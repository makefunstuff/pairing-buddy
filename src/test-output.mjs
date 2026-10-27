// Reads test-runner output: which runner, which tests failed and the first error line.
// Covers cargo test, go test, jest, vitest, pytest and node --test (the spec reporter), and the JSON reports of
// go test, jest and vitest; zig test, ctest, TAP and JUnit XML are test-reports.mjs. Anything else is null.
import {ctest, junit, tap, zig} from './test-reports.mjs';

const MAX_NAMES = 20;

const linesOf = text => text.split('\n');
const unique = names => [...new Set(names)].slice(0, MAX_NAMES);
const count = (text, pattern) => [...text.matchAll(pattern)].reduce((sum, match) => sum + Number(match[1]), 0);
/** The index of the first line at or after `from` that passes `test` (by default: is not blank), else -1. */
const indexFrom = (lines, from, test = line => line.trim()) => {
  const index = lines.slice(from).findIndex(test);
  return index === -1 ? -1 : from + index;
};
const lineFrom = (lines, from, test) => lines[indexFrom(lines, from, test)]?.trim() ?? null;

/**
 * Each test cargo ran, `test tests::adds ... ok`: found by its fn (see test-places.mjs), in the file that ran it
 * (`Running tests/api.rs`) when cargo says, and the place it panicked at.
 */
function cargoTests(lines) {
  let running = null;
  const tests = [];
  for (const line of lines) {
    running = /^\s*Running (?:unittests )?(\S+\.rs) /.exec(line)?.[1] ?? running;
    const match = /^test (\S+) \.\.\. (ok|FAILED|ignored)$/.exec(line);
    if (!match) continue;
    const [, name, result] = match;
    const status = result === 'ok' ? 'passed' : result === 'FAILED' ? 'failed' : 'skipped';
    // The unit tests of src/lib.rs may be in any file of src/; an integration test is in its own file.
    const files = running && !running.startsWith('src/') ? [running] : [];
    const path = name.split('::');
    tests.push({name, status, find: {kind: 'rust', name: path.at(-1), module: path.at(-2), files}, failure: status === 'failed' ? cargoFailure(lines, name) : null});
  }
  return tests;
}

/** Where test `name` panicked, `thread 'tests::x' (41) panicked at src/lib.rs:7:26:`, and the line after it. */
function cargoFailure(lines, name) {
  const index = lines.findIndex(line => line.startsWith(`thread '${name}'`) && / panicked at /.test(line));
  if (index === -1) return {file: null, line: null, text: 'failed'};
  const at = / panicked at (\S+?):(\d+):\d+:?$/.exec(lines[index]);
  return {file: at?.[1] ?? null, line: at ? Number(at[2]) : null, text: lines[index + 1]?.trim() || 'panicked'};
}

function cargo(text) {
  if (!/^test result: /m.test(text)) return null;
  const lines = linesOf(text);
  const tests = cargoTests(lines);
  const panic = lines.findIndex(line => / panicked at /.test(line));
  let firstError = null;
  if (panic !== -1) {
    const where = / panicked at (\S+?):?$/.exec(lines[panic])?.[1];
    const sides = lines.slice(panic + 2, panic + 4).filter(line => /^\s*(left|right):/.test(line)).map(line => line.trim());
    firstError = `${lines[panic + 1].trim()}${sides.length ? ` (${sides.join(', ')})` : ''}${where ? ` at ${where}` : ''}`;
  }
  return {
    runner: 'cargo',
    failed: unique([...text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map(match => match[1])),
    passed: count(text, /^test result: \w+\. (\d+) passed/gm),
    failedCount: count(text, /^test result: \w+\. \d+ passed; (\d+) failed/gm),
    firstError,
    ...(tests.length ? {tests} : {}),
  };
}

function go(text) {
  if (!/^(--- FAIL: |(ok|FAIL)\s+\S+\s+(\d|\[))/m.test(text)) return null;
  const lines = linesOf(text);
  const names = [...text.matchAll(/^\s*--- FAIL: (\S+)/gm)].map(match => match[1]);
  // A failed subtest fails its parent too; the subtest is the one worth naming.
  const failed = names.filter(name => !names.some(other => other.startsWith(`${name}/`)));
  const firstFail = lines.findIndex(line => /^\s*--- FAIL: /.test(line));
  const firstError = firstFail !== -1
    ? lineFrom(lines, firstFail + 1, line => line.trim() && !/--- FAIL: /.test(line))
    : /^\S+\.go:\d+:\d+: .+$/m.exec(text)?.[0] ?? null; // a build error
  const packageFailed = /^FAIL\s+\S+\s+(\d|\[)/m.test(text);
  return {runner: 'go', failed: unique(failed), passed: null, failedCount: Math.max(failed.length, packageFailed ? 1 : 0), firstError};
}

function jest(text) {
  const summary = /^Tests:\s+(.*\btotal)$/m.exec(text);
  if (!summary) return null;
  const lines = linesOf(text);
  const header = lines.findIndex(line => /^\s*● /.test(line));
  let firstError = null;
  if (header !== -1) {
    const start = indexFrom(lines, header + 1);
    firstError = lines[start].trim();
    const values = lines.slice(start + 1, start + 5).filter(line => /^\s*(Expected|Received):/.test(line)).map(line => line.trim());
    if (values.length) firstError += ` (${values.join(', ')})`;
    const at = lines.slice(start).find(line => /^\s*at .*\((.+:\d+:\d+)\)/.test(line));
    if (at) firstError += ` at ${/\((.+:\d+:\d+)\)/.exec(at)[1]}`;
  }
  return {
    runner: 'jest',
    failed: unique([...text.matchAll(/^\s*● (.+)$/gm)].map(match => match[1].trim())),
    passed: Number(/(\d+) passed/.exec(summary[1])?.[1] ?? 0),
    failedCount: Number(/(\d+) failed/.exec(summary[1])?.[1] ?? 0),
    firstError,
  };
}

function vitest(text) {
  const summary = /^\s*Tests\s+(.*\(\d+\))\s*$/m.exec(text);
  if (!summary) return null;
  const lines = linesOf(text);
  const header = lines.findIndex(line => /^\s*FAIL\s/.test(line));
  let firstError = null;
  if (header !== -1) {
    firstError = lineFrom(lines, header + 1);
    const at = lines.slice(header + 1).find(line => /^\s*❯ \S+:\d+:\d+/.test(line));
    if (at) firstError += ` at ${at.trim().slice(2)}`;
  }
  return {
    runner: 'vitest',
    failed: unique([...text.matchAll(/^\s*FAIL\s+(.+)$/gm)].map(match => match[1].trim())),
    passed: Number(/(\d+) passed/.exec(summary[1])?.[1] ?? 0),
    failedCount: Number(/(\d+) failed/.exec(summary[1])?.[1] ?? 0),
    firstError,
  };
}

/**
 * Each test pytest names: `tests/test_calc.py::test_adds PASSED` with -v, `PASSED tests/test_calc.py::test_adds`
 * with -rA, and the failures in any case. A failure's place is the last `file.py:12: Error` line of its section.
 */
function pytestTests(text) {
  const statuses = new Map();
  const STATUS = {PASSED: 'passed', FAILED: 'failed', ERROR: 'failed', SKIPPED: 'skipped', XFAIL: 'skipped', XPASS: 'passed'};
  for (const [, id, word] of text.matchAll(/^(\S+\.py::\S+) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/gm)) statuses.set(id, STATUS[word]);
  for (const [, word, id] of text.matchAll(/^(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS) (\S+\.py::\S+)/gm)) statuses.set(id, STATUS[word]);
  const lines = linesOf(text);
  return [...statuses].map(([id, status]) => {
    const [file, ...path] = id.split('::');
    const name = path.at(-1);
    let failure = null;
    if (status === 'failed') {
      const said = new RegExp(`^(?:FAILED|ERROR) ${escapeRegExp(id)} - (.*)$`, 'm').exec(text)?.[1];
      const header = lines.findIndex(line => new RegExp(`^_+ ${escapeRegExp(path.join('.'))} _+$`).test(line));
      const end = header === -1 ? -1 : indexFrom(lines, header + 1, line => /^(_+ .* _+|=+ .* =+)$/.test(line));
      const section = header === -1 ? [] : lines.slice(header + 1, end === -1 ? undefined : end);
      const at = section.map(line => /^(\S+\.py):(\d+): \w+/.exec(line)).filter(Boolean).at(-1);
      failure = {file: at?.[1] ?? null, line: at ? Number(at[2]) : null, text: said ?? section.find(line => line.startsWith('E '))?.slice(1).trim() ?? 'failed'};
    }
    // A parametrized test, test_param[2-3-6], is its def test_param.
    return {name: id, status, find: {kind: 'python', name: name.replace(/\[.*\]$/, ''), files: [file]}, failure};
  });
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pytest(text) {
  const summary = /^=+ (.*\b(passed|failed|errors?)\b.* in [\d.]+s.*?) =+$/m.exec(text);
  if (!summary) return null;
  const failures = [...text.matchAll(/^(?:FAILED|ERROR) (\S+)(?: - (.*))?$/gm)];
  const tests = pytestTests(text);
  return {
    ...(tests.length ? {tests} : {}),
    runner: 'pytest',
    failed: unique(failures.map(match => match[1])),
    passed: Number(/(\d+) passed/.exec(summary[1])?.[1] ?? 0),
    failedCount: Number(/(\d+) failed/.exec(summary[1])?.[1] ?? 0) + Number(/(\d+) errors?/.exec(summary[1])?.[1] ?? 0),
    firstError: failures[0]?.[2] ?? /^E\s+(.+)$/m.exec(text)?.[1] ?? null,
  };
}

function nodeTest(text) {
  if (!/^ℹ tests \d+$/m.test(text)) return null;
  const lines = linesOf(text);
  // The "failing tests:" section repeats each failure with its error right under it.
  const section = lines.findIndex(line => /^✖ failing tests:/.test(line));
  const header = section === -1 ? -1 : indexFrom(lines, section + 1, line => /^✖ .+\([\d.]+m?s\)$/.test(line));
  let firstError = null;
  if (header !== -1) {
    const start = indexFrom(lines, header + 1);
    firstError = lines[start].trim();
    // "Expected values to be strictly equal:" says little; the line after it has the values.
    if (firstError.endsWith(':')) firstError += ` ${lineFrom(lines, start + 1)}`;
  }
  return {
    runner: 'node',
    failed: unique([...text.matchAll(/^\s*✖ (.+?) \([\d.]+m?s\)$/gm)].map(match => match[1])),
    passed: count(text, /^ℹ pass (\d+)$/gm),
    failedCount: count(text, /^ℹ fail (\d+)$/gm),
    firstError,
  };
}

// JSON reports: `go test -json` (one event per line) and the report of `jest --json` or `vitest --reporter=json`.
// They also list each test, for the editor: {name, status, package or file, line, failure: {file, line, text}}.

/** The JSON objects among the lines of `text`; a runner's own lines and npm's around them are skipped. */
function jsonLines(text) {
  return linesOf(text).filter(line => line.startsWith('{')).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

const GO_STATUS = {pass: 'passed', fail: 'failed', skip: 'skipped'};

/** Where a failed Go test says it failed: `t.Errorf`'s `file.go:12: text`, else a panic and its first frame outside the runtime. */
function goFailure(output) {
  const lines = output.join('').split('\n');
  const assertion = lines.map(line => /^\s+([\w.-]+\.go):(\d+): (.*)$/.exec(line)).find(Boolean);
  if (assertion) return {file: assertion[1], line: Number(assertion[2]), text: assertion[3].trim()};
  const panic = lines.findIndex(line => line.startsWith('panic: '));
  if (panic === -1) return null;
  const text = lines[panic].replace(/ \[recovered.*\]$/, '');
  // The stack is pairs of lines: a function, then its file:line. The panic is raised where the first one past
  // `panic(` that is not part of the runtime was.
  const frames = lines.slice(lines.findIndex((line, i) => i > panic && line.startsWith('panic(')) + 2);
  for (let i = 0; i + 1 < frames.length; i += 2) {
    const at = /^\t(\/\S+\.go):(\d+)/.exec(frames[i + 1]);
    if (at && !frames[i].startsWith('runtime.')) return {file: at[1], line: Number(at[2]), text};
  }
  return {file: null, line: null, text};
}

function goJson(text) {
  const events = jsonLines(text).filter(event => event.Action && (event.Package || event.ImportPath));
  if (!events.length) return null;
  const runs = new Map(); // "package test" -> {name, package, status, output}
  const build = [];
  let packageFailed = false;
  for (const event of events) {
    if (event.Action === 'build-output') build.push(event.Output);
    if (!event.Test) {
      if (event.Action === 'fail') packageFailed = true;
      continue;
    }
    const key = `${event.Package} ${event.Test}`;
    const run = runs.get(key) ?? {name: event.Test, package: event.Package, status: null, output: []};
    runs.set(key, run);
    if (event.Action === 'output') run.output.push(event.Output);
    if (GO_STATUS[event.Action]) run.status = GO_STATUS[event.Action];
  }
  const ended = [...runs.values()].filter(run => run.status);
  // A failed subtest fails its parent too; the subtest is the one worth naming, and has the failure.
  const leaves = ended.filter(run => !ended.some(other => other.package === run.package && other.name.startsWith(`${run.name}/`)));
  const failedLeaves = leaves.filter(run => run.status === 'failed');
  const tests = ended.filter(run => !run.name.includes('/')).map(run => {
    const leaf = failedLeaves.find(other => other.package === run.package && (other.name === run.name || other.name.startsWith(`${run.name}/`)));
    return {name: run.name, package: run.package, status: run.status, failure: leaf ? goFailure(leaf.output) : null};
  });
  const failure = tests.find(test => test.failure)?.failure;
  const buildError = build.map(line => line.trim()).find(line => /^\S+\.go:\d+:\d+: /.test(line));
  return {
    runner: 'go',
    failed: unique(failedLeaves.map(run => run.name)),
    passed: tests.filter(test => test.status === 'passed').length,
    failedCount: Math.max(failedLeaves.length, packageFailed ? 1 : 0),
    firstError: failure ? `${failure.file ? `${failure.file.split('/').at(-1)}:${failure.line}: ` : ''}${failure.text}` : buildError ?? null,
    tests,
    packages: new Set(tests.map(test => test.package)).size,
  };
}

const stripColor = text => text.replace(/\x1b\[[0-9;]*m/g, '');

/** A failed jest or vitest test's first error line, with its expected and received values, and where in `file` it failed. */
function jsFailure(message, file) {
  const lines = stripColor(message).split('\n');
  const values = lines.filter(line => /^\s*(Expected|Received):/.test(line)).map(line => line.trim());
  const text = `${lines[0].trim()}${values.length ? ` (${values.join(', ')})` : ''}`;
  const at = lines.map(line => /(?:\(|at )(?:file:\/\/)?(\/[^():\s]+):(\d+):\d+/.exec(line)).find(match => match?.[1] === file);
  return {file, line: at ? Number(at[2]) : null, text};
}

const JS_STATUS = {passed: 'passed', failed: 'failed'}; // anything else (pending, skipped, todo) did not run

function jsJson(text) {
  const report = jsonLines(text).find(object => Array.isArray(object.testResults));
  if (!report) return null;
  const tests = report.testResults.flatMap(suite => {
    // A file that fails as a whole (a syntax error, a failed import) has no tests of its own to name.
    if (!suite.assertionResults?.length && suite.status === 'failed') {
      // Its mark goes on the first line, and its error there too unless the stack names a line of its own.
      const failure = jsFailure(suite.message || 'failed to run', suite.name);
      return [{name: suite.name.split('/').at(-1), file: suite.name, line: 1, status: 'failed', failure: {...failure, line: failure.line ?? 1}}];
    }
    return (suite.assertionResults ?? []).map(result => ({
      name: [...result.ancestorTitles, result.title].join(' › '),
      title: result.title,
      file: suite.name,
      line: result.location?.line ?? null,
      status: JS_STATUS[result.status] ?? 'skipped',
      failure: result.status === 'failed' ? jsFailure(result.failureMessages?.[0] ?? 'failed', suite.name) : null,
    }));
  });
  const failed = tests.filter(test => test.status === 'failed');
  return {
    // jest's report also lists the handles left open; vitest's report copies jest's format, without them.
    runner: 'openHandles' in report ? 'jest' : 'vitest',
    failed: unique(failed.map(test => test.name)),
    passed: tests.filter(test => test.status === 'passed').length,
    failedCount: failed.length,
    firstError: failed[0] ? `${failed[0].failure.text}${failed[0].failure.line ? ` at ${failed[0].file.split('/').at(-1)}:${failed[0].failure.line}` : ''}` : null,
    tests,
    files: report.testResults.length,
  };
}

const RUNNERS = [goJson, jsJson, junit, tap, cargo, jest, vitest, pytest, nodeTest, zig, ctest, go];

/**
 * `{runner, failed, passed, failedCount, firstError}` when `text` is the output of a test run, else null.
 * `failed` names the failed tests (at most 20); `passed` is null when the runner does not count them.
 * Most runners also give `tests`, each test with its status, failure and where to find it (see test-reports.mjs);
 * a JSON report also says how many `packages` (go) or test `files` (jest, vitest) it ran.
 * `report` is the JUnit XML the command wrote to a file, if any: its tests count where it names more than the output.
 */
export function parseTestOutput(text = '', report = null) {
  const fromReport = report && junit(report);
  for (const runner of RUNNERS) {
    const result = runner(text);
    if (!result) continue;
    // The report wins where it names more tests (plain pytest lists only its failures); else the output's own list
    // does, which says as much or more of where each test is (ctest's report names no file).
    const better = fromReport && fromReport.tests.length > (result.tests?.length ?? 0);
    return finished(better ? {...fromReport, runner: result.runner} : result);
  }
  return fromReport && finished(fromReport);
}

const finished = result => ({...result, failedCount: Math.max(result.failedCount, result.failed.length)});

const SOURCE_EXTENSION = String.raw`\.(?:go|[cm]?js|jsx|tsx?|py|rs|rb|java|kt|swift|cs|c|cc|cpp|h|hpp|php|exs?|lua|zig)`;
// Source files as test runners print them: `worker_test.go:35`, `at test/ws.test.ts:14:28`, `File "test_ws.py"`.
const SOURCE_FILE = new RegExp(String.raw`(?:^|[\s("'\[])(\/?(?:[\w.@-]+\/)*[\w@-][\w.@-]*${SOURCE_EXTENSION})\b`, 'gm');

/** Whether `file` is source code, by its extension. */
export const isSourceFile = file => new RegExp(`${SOURCE_EXTENSION}$`).test(file);

/** The source files a test run's output names, as written (at most 20). */
export function namedFiles(text = '') {
  return unique([...text.matchAll(SOURCE_FILE)].map(match => match[1]).filter(file => !file.includes('node_modules/')));
}

/** One line for the models: "2 failed (a, b): first error", or "12 passed". */
export function testSummary(tests) {
  if (!tests.failedCount) return `${tests.passed ?? 'all'} passed`;
  const names = tests.failed.length ? ` (${tests.failed.slice(0, 5).join(', ')}${tests.failed.length > 5 ? ', ...' : ''})` : '';
  return `${tests.failedCount} failed${names}${tests.firstError ? `: ${tests.firstError}` : ''}`;
}
