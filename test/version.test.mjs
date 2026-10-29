// The version is written in one place, package.json; these hold the places that repeat it (the lock file, `pair
// --version`) to it, and the changelog to an entry for it that can be a release's notes (docs/releasing.md).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {VERSION} from '../src/version.mjs';

const BIN = fileURLToPath(new URL('../bin/pair.mjs', import.meta.url));
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const {version} = JSON.parse(read('package.json'));

/** The changelog's entry for one version: its lines after `## [x.y.z]`, up to the next entry. */
const entry = (changelog, v) => changelog.split(/^## /m).find(part => part.startsWith(`[${v}]`))?.split('\n').slice(1).join('\n').trim();

test('pair --version prints the version package.json has, as do its other spellings', () => {
  for (const flag of ['--version', '-v', 'version']) {
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, flag], {encoding: 'utf8'});
    assert.equal(out, `pair ${version}\n`, flag);
  }
  assert.equal(VERSION, version); // what the daemon logs and reports to pair doctor
});

test('package-lock.json has the version package.json has', () => {
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
});

test('the README names the release package.json has', () => {
  assert.match(read('README.md'), new RegExp(`^Version ${version.split('.').slice(0, 2).join('\\.')} `, 'm'));
});

test('the changelog has a dated entry for this version, with links that work as a release\'s notes', () => {
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
  const notes = entry(changelog, version);
  assert.ok(notes, `no entry for ${version}`);
  assert.match(notes, /^### (Added|Changed|Fixed)$/m);
  // A release's page is not in the repo: a relative link in its notes would lead nowhere.
  const relative = [...notes.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]).filter(href => !/^https:\/\//.test(href));
  assert.deepEqual(relative, []);
  assert.match(changelog, new RegExp(`^\\[${version.replaceAll('.', '\\.')}\\]: https://github\\.com/makefunstuff/pairing-buddy/releases/tag/v${version.replaceAll('.', '\\.')}$`, 'm'));
});
