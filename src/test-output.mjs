// Reads test-runner output: which runner, which tests failed and the first error line.
// Covers cargo test, go test, jest, vitest, pytest and node --test (the spec reporter); anything else is null.

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

function cargo(text) {
  if (!/^test result: /m.test(text)) return null;
  const lines = linesOf(text);
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

function pytest(text) {
  const summary = /^=+ (.*\b(passed|failed|errors?)\b.* in [\d.]+s.*?) =+$/m.exec(text);
  if (!summary) return null;
  const failures = [...text.matchAll(/^(?:FAILED|ERROR) (\S+)(?: - (.*))?$/gm)];
  return {
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

const RUNNERS = [cargo, jest, vitest, pytest, nodeTest, go];

/**
 * `{runner, failed, passed, failedCount, firstError}` when `text` is the output of a test run, else null.
 * `failed` names the failed tests (at most 20); `passed` is null when the runner does not count them.
 */
export function parseTestOutput(text = '') {
  for (const runner of RUNNERS) {
    const result = runner(text);
    if (result) return {...result, failedCount: Math.max(result.failedCount, result.failed.length)};
  }
  return null;
}

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
