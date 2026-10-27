// The test runners whose output names each test, beyond the JSON reports of test-output.mjs: zig test, ctest, TAP
// (node --test --test-reporter=tap, prove, bats) and JUnit XML (pytest --junitxml, node's junit reporter, ctest
// --output-junit), in the output or in the report file the command names. Each gives the shape parseTestOutput
// gives, with `tests` for the editor: {name, status, failure, ...where}, where is one of
//   {file, line}               the runner says where the test is;
//   {file, title}              a JS test, found by its title in the file (see test-places.mjs), or in one of
//                              `files` when the runner did not say which;
//   {find: {kind, name, files}} a declaration to look for: a Python def, a Rust fn, a Zig test, a CMake add_test,
//                              in the files whose paths end with one of `files`, or in any file of its kind.

const MAX_NAMES = 20;

const unique = names => [...new Set(names)].slice(0, MAX_NAMES);
const number = (text, pattern) => Number(pattern.exec(text)?.[1] ?? 0);

/** The result parseTestOutput gives for `tests`, by runner `runner`; `firstError` from the first failure. */
function resultOf(runner, tests, counts = {}) {
  const failed = tests.filter(test => test.status === 'failed');
  const first = failed.find(test => test.failure)?.failure;
  return {
    runner,
    failed: unique(failed.map(test => test.name)),
    passed: counts.passed ?? tests.filter(test => test.status === 'passed').length,
    failedCount: counts.failed ?? failed.length,
    firstError: first ? `${first.text}${first.file && first.line ? ` at ${first.file.split('/').at(-1)}:${first.line}` : ''}` : null,
    tests,
  };
}

// Places in a failure's text: `src/lib.rs:14:9`, `tests/test_calc.py:10: AssertionError`, `file:///…/a.test.js:10:12`.
const PLACE = /(?:file:\/\/)?((?:\/|\.{0,2}[\w@-])[^\s:()'"<>]*\.[a-z]\w*):(\d+)/g;

/** The first place in `text` that is in `file`, else the first one at all, as {file, line}; null when none. */
function placeIn(text, file) {
  const places = [...text.matchAll(PLACE)].map(match => ({file: match[1], line: Number(match[2])}));
  return places.find(place => file && place.file === file) ?? places[0] ?? null;
}

// zig test: `2/3 main.test.add wrong...FAIL (TestExpectedEqual)`; zig build test names only the failures:
// `error: 'main.test.add wrong' failed: expected 5, found 4`. Either way the stack's frame `in test.<name>` is
// where it failed.

export function zig(text) {
  const listed = [...text.matchAll(/^\d+\/\d+ (?:([\w.]+)\.)?test\.(.+?)\.\.\.(OK|SKIP|.*)$/gm)];
  const built = [...text.matchAll(/^error: '(?:([\w.]+)\.)?test\.(.+?)' failed(?:: (.*))?$/gm)];
  const summary = /^(?:All (\d+) tests passed\.|(\d+) passed; \d+ skipped; (\d+) failed\.)$/m.exec(text)
    ?? /^Build Summary: .*?(?:(\d+)\/\d+ tests passed(?:; (\d+) failed)?)/m.exec(text);
  if (!summary || (!listed.length && !built.length && !/tests passed/.test(summary[0]))) return null;
  const lines = text.split('\n');
  const failureOf = (name, said) => {
    const frame = lines.findIndex(line => line.includes(` in test.${name} (`));
    const at = frame === -1 ? null : /^(\S+\.zig):(\d+):\d+:/.exec(lines[frame]);
    return {file: at?.[1] ?? null, line: at ? Number(at[2]) : null, text: said || 'failed'};
  };
  const test = (module, name, status, said) => ({
    name, status, find: {kind: 'zig', name, files: module ? [`${module.split('.').at(-1)}.zig`] : []}, failure: status === 'failed' ? failureOf(name, said) : null,
  });
  // A failure ends its line with what it printed (`expected 5, found 4`), or only with `FAIL (TestUnexpectedResult)`.
  const said = end => /^FAIL \((\w+)\)$/.exec(end)?.[1] ?? end.trim();
  const tests = listed.length
    ? listed.map(([, module, name, end]) => test(module, name, end === 'OK' ? 'passed' : end === 'SKIP' ? 'skipped' : 'failed', end === 'OK' || end === 'SKIP' ? null : said(end)))
    : built.map(([, module, name, said]) => test(module, name, 'failed', said));
  const passed = summary[1] !== undefined && summary[0].startsWith('All') ? Number(summary[1]) : undefined;
  return resultOf('zig', tests, passed === undefined ? {} : {passed});
}

// ctest: `2/2 Test #2: fails .....***Failed    0.00 sec`, and with --output-on-failure the test's output under it.

const CTEST_LINE = /^\s*\d+\/\d+ Test\s+#\d+: (\S+) \.*\s*(Passed|\*+\w.*?|Not Run.*?)\s+[\d.]+ sec$/;

export function ctest(text) {
  if (!/^\d+% tests passed, \d+ tests? failed out of \d+/m.test(text)) return null;
  const lines = text.split('\n');
  const tests = [];
  lines.forEach((line, index) => {
    const match = CTEST_LINE.exec(line);
    if (!match) return;
    const [, name, result] = match;
    const status = result === 'Passed' ? 'passed' : /^Not Run/.test(result) ? 'skipped' : 'failed';
    let failure = null;
    if (status === 'failed') {
      // Its output runs up to the next test, or the summary.
      const end = lines.findIndex((next, i) => i > index && /^\s*(Start\s+\d+:|\d+\/\d+ Test|\d+% tests passed)/.test(next));
      const said = lines.slice(index + 1, end === -1 ? undefined : end).map(next => next.trim()).find(Boolean);
      const place = said ? placeIn(said) : null;
      failure = {file: place?.file ?? null, line: place?.line ?? null, text: said ?? result.replace(/^\*+/, '')};
    }
    tests.push({name, status, find: {kind: 'ctest', name, files: []}, failure});
  });
  const failed = number(text, /^\d+% tests passed, (\d+) tests? failed/m);
  return resultOf('ctest', tests, {failed: Math.max(failed, tests.filter(test => test.status === 'failed').length)});
}

// TAP: `ok 1 - adds`, `not ok 3 - sums 2 and 2`, each with an optional YAML block under it, where node's reporter
// gives the test's `location` and its `error`.

function yamlValue(block, key) {
  const index = block.findIndex(line => new RegExp(`^\\s*${key}: `).test(line));
  if (index === -1) return null;
  const value = block[index].replace(/^\s*\w+: /, '');
  if (!/^[|>]/.test(value)) return value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  // A block value: the lines indented deeper than its key.
  const indent = /^\s*/.exec(block[index])[0].length;
  const end = block.findIndex((line, i) => i > index && line.trim() && /^\s*/.exec(line)[0].length <= indent);
  return block.slice(index + 1, end === -1 ? undefined : end).map(line => line.trim()).filter(Boolean).join(' ') || null;
}

export function tap(text) {
  if (!/^TAP version \d+$/m.test(text) && !(/^1\.\.\d+$/m.test(text) && /^(not )?ok \d+/m.test(text))) return null;
  const lines = text.split('\n');
  const tests = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)(not ok|ok) \d+(?: -)? ([^#]*?)\s*(#\s*(SKIP|TODO).*)?$/i.exec(line);
    if (!match) return;
    const [, indent, ok, name, , directive] = match;
    const end = lines.findIndex((next, i) => i > index && next.startsWith(`${indent}  ...`));
    const block = lines[index + 1]?.startsWith(`${indent}  ---`) && end !== -1 ? lines.slice(index + 2, end) : [];
    if (yamlValue(block, 'type') === 'suite') return; // node's describe(): it fails when a test in it does
    const at = /^(?:file:\/\/)?(\/.+):(\d+):\d+$/.exec(yamlValue(block, 'location') ?? '');
    const status = directive ? 'skipped' : ok === 'ok' ? 'passed' : 'failed';
    let failure = null;
    if (status === 'failed') {
      const said = yamlValue(block, 'error') ?? yamlValue(block, 'message') ?? 'failed';
      const thrown = placeIn(yamlValue(block, 'stack') ?? '', at?.[1]);
      failure = {file: thrown?.file ?? null, line: thrown?.line ?? null, text: said};
    }
    tests.push({name, status, failure, ...(at ? {file: at[1], line: Number(at[2])} : {title: name})});
  });
  // Without its own location, a test is looked for by its title in the files the others are in.
  const files = [...new Set(tests.filter(test => test.file).map(test => test.file))];
  for (const test of tests.filter(test => test.title)) test.files = files;
  return resultOf('tap', tests, {passed: number(text, /^# pass (\d+)$/m) || undefined, failed: number(text, /^# fail (\d+)$/m) || undefined});
}

// JUnit XML: <testcase name classname file line> with <failure message> or <error> or <skipped> in it.

const ENTITIES = {lt: '<', gt: '>', amp: '&', quot: '"', apos: "'"};
const unescape = text => text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, entity) => (
  entity[0] === '#' ? String.fromCodePoint(Number(entity[1] === 'x' ? `0${entity.slice(1)}` : entity.slice(1))) : ENTITIES[entity] ?? whole
));
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]));

const KINDS = {'.py': 'python', '.rs': 'rust', '.zig': 'zig'};

/** Where a JUnit test case is: its file and line, its file and title, or its classname as a Python module. */
function junitPlace({file, line, classname, name}) {
  if (file && line) return {file, line: Number(line)};
  if (!file && classname === name) return {find: {kind: 'ctest', name, files: []}}; // ctest names a test only by itself
  // pytest names a parametrized test test_param[2-3-6]; its def is test_param.
  const declared = name.replace(/\[.*\]$/, '');
  const kind = file && KINDS[/\.\w+$/.exec(file)?.[0]];
  if (kind) return {find: {kind, name: declared, files: [file]}};
  if (file) return {file, title: name};
  // pytest names the module, and the class in it: tests.test_calc.TestCalc. Each prefix may be the file.
  const parts = (classname ?? '').split('.').filter(Boolean);
  return {find: {kind: 'python', name: declared, files: parts.map((_, i) => `${parts.slice(0, parts.length - i).join('/')}.py`)}};
}

export function junit(text) {
  if (!/<testsuites?[\s>]/.test(text) || !/<testcase[\s>]/.test(text)) return null;
  const cases = [...text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
  const tests = cases.map(([, tag, body = '']) => {
    const attrs = attributes(tag);
    const name = attrs.name ?? '';
    const bad = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const status = bad ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    let failure = null;
    if (bad) {
      const message = unescape(attributes(bad[2]).message ?? '');
      // What the test printed, where the failure itself says no more than that it failed (ctest: "Failed").
      const detail = unescape(bad[3] || /<system-out>([\s\S]*?)<\/system-out>/.exec(body)?.[1] || '');
      const place = placeIn(detail, attrs.file);
      const said = /^(failed|error)?$/i.test(message.trim()) ? detail || message : message;
      failure = {file: place?.file ?? null, line: place?.line ?? null, text: said.split('\n').map(line => line.trim()).find(Boolean) ?? 'failed'};
    }
    return {name, status, failure, ...junitPlace({...attrs, name})};
  });
  return resultOf('junit', tests);
}

// The JUnit report a command writes to a file: pytest --junitxml, ctest --output-junit, node's
// --test-reporter-destination, vitest's --outputFile when it ends in .xml.
const REPORT_FILE = /(?:^|\s)--(?:junitxml|junit-xml|output-junit|test-reporter-destination|outputFile(?:\.junit)?)(?:=|\s+)(\S+\.xml)(?=\s|$)/;

/** The JUnit XML file `command` writes, as written in it (relative to where it runs), or null. */
export const reportFileOf = command => REPORT_FILE.exec(command)?.[1] ?? null;
