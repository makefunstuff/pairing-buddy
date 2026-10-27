// The tests a save can affect, where the runner can be told: the command on save narrowed to them. Go runs the
// saved file's package and every package of the module that imports it, directly or not; jest and vitest find the
// tests related to the saved files themselves (--findRelatedTests, vitest related); pytest runs a saved test file.
// Any other command, or a save these cannot narrow (a source file for pytest, a file outside the Go module), runs
// whole.
import {readdir, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {shellQuote} from './scout-shell.mjs';

// One command, without lists or pipes: only then do its arguments say what it runs.
const SIMPLE = /^[^;&|<>()`$]+$/;
const SKIPPED_DIRS = new Set(['vendor', 'testdata', 'node_modules']);

/** The import paths of a Go file's text. */
function goImports(text) {
  const imports = [];
  for (const [, block, single] of text.matchAll(/^import\s*(?:\(([\s\S]*?)\)|(?:[\w.]+\s+)?"([^"]+)")/gm)) {
    if (single) imports.push(single);
    else imports.push(...[...block.matchAll(/"([^"]+)"/g)].map(match => match[1]));
  }
  return imports;
}

/** The module's packages: directory (relative, '.' for the root) -> the import paths its files use. */
async function goPackages(root) {
  const packages = new Map();
  const walk = async dir => {
    for (const entry of await readdir(join(root, dir), {withFileTypes: true}).catch(() => [])) {
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !entry.name.startsWith('_') && !SKIPPED_DIRS.has(entry.name)) await walk(path);
      } else if (entry.name.endsWith('.go')) {
        const imports = goImports(await readFile(join(root, path), 'utf8').catch(() => ''));
        packages.set(dir, new Set([...(packages.get(dir) ?? []), ...imports]));
      }
    }
  };
  await walk('.');
  return packages;
}

/** `go test … ./...` with the packages the saved Go files are in, and the packages that import them. */
async function go(command, root, files) {
  if (!/(^|\s)\.\/\.\.\.(\s|$)/.test(command) || !files.every(file => file.endsWith('.go'))) return null;
  const module = /^module\s+(\S+)/m.exec(await readFile(join(root, 'go.mod'), 'utf8').catch(() => ''))?.[1];
  if (!module) return null;
  const packages = await goPackages(root);
  const importPath = dir => (dir === '.' ? module : `${module}/${dir}`);
  const affected = new Set(files.map(file => dirname(file)));
  if (![...affected].every(dir => packages.has(dir))) return null;
  for (let grew = true; grew;) {
    grew = false;
    for (const [dir, imports] of packages) {
      if (!affected.has(dir) && [...affected].some(other => imports.has(importPath(other)))) {
        affected.add(dir);
        grew = true;
      }
    }
  }
  const list = [...affected].sort().map(dir => (dir === '.' ? '.' : `./${dir}`)).join(' ');
  return command.replace(/(^|\s)\.\/\.\.\.(?=\s|$)/, `$1${list}`);
}

const quoted = files => files.map(shellQuote).join(' ');

function jest(command, files) {
  return /(^|[\s/])jest(\s|$)/.test(command) ? `${command} --findRelatedTests ${quoted(files)}` : null;
}

function vitest(command, files) {
  return /(^|[\s/])vitest run(\s|$)/.test(command) ? `${command.replace(/vitest run/, 'vitest related --run')} ${quoted(files)}` : null;
}

// pytest's options that take a value as the next word.
const PYTEST_VALUES = new Set(['-k', '-m', '-p', '-c', '-o', '-n', '-W', '-r', '--tb', '--junitxml', '--junit-xml', '--rootdir', '--basetemp', '--deselect', '--ignore', '--maxfail']);
const isTestFile = file => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(file);

/** pytest with the saved test files, when its command names no files of its own. */
function pytest(command, files) {
  const words = command.trim().split(/\s+/);
  const at = words.findIndex(word => word === 'pytest' || word.endsWith('/pytest'));
  if (at === -1 || !files.every(isTestFile)) return null;
  for (let i = at + 1; i < words.length; i++) {
    if (PYTEST_VALUES.has(words[i])) i++;
    else if (!words[i].startsWith('-')) return null;
  }
  return `${command} ${quoted(files)}`;
}

/**
 * `command` narrowed to the tests that saving `files` (relative to `root`) can affect, or null when it runs whole.
 */
export async function affectedCommand({command, root, files}) {
  if (!files.length || !SIMPLE.test(command) || /'|"/.test(command)) return null;
  return jest(command, files) ?? vitest(command, files) ?? pytest(command, files) ?? go(command, root, files);
}
