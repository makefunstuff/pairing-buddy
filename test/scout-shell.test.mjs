import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {homedir, tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {test} from 'node:test';
import {cacheFolders, overlayWorks, sandboxWords, sandboxWorks, userSockets} from '../src/sandbox.mjs';
import {commandResult, promptNumber} from '../src/scout-pane.mjs';
import {rcNames, scoutPaneConfig, shellLine, shellQuote} from '../src/scout-shell.mjs';

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'pair-shell-')));
const plain = scoutPaneConfig({sandbox: false});

// What a user's rc file does that would hide the exit code or end the pane: a prompt of its own, prompt hooks,
// a DEBUG trap and errexit; and what the pane should keep: an alias, a function and the environment.
const RC = `alias ll='ls -1'
greet() { echo "hi $1"; }
export FROM_RC=yes
PS1='me> '
PROMPT_COMMAND='PS1="mine $? > "'
trap 'echo before' DEBUG
set -euo pipefail
echo "rc loaded"
`;

/**
 * Starts `line` as herdr's pane would, with stdin and the output on pipes instead of a terminal, and types
 * `commands` one at a time: resolves with each command's `{exit, output}`, read back as ScoutPane reads them.
 */
function runInShell(line, cwd, commands) {
  return new Promise((resolve, reject) => {
    const shell = spawn('sh', ['-c', `${line} 2>&1`], {cwd});
    let text = '';
    const results = [];
    let next = 1; // the prompt the next command is typed at
    const timer = setTimeout(() => { shell.kill(); reject(new Error(`no prompt in time:\n${text}`)); }, 15_000);
    shell.stdout.on('data', chunk => {
      text += chunk;
      const number = promptNumber(text);
      // A prompt seen before, with the typed command echoed after it (bash on a pipe echoes it).
      if (number !== next) return;
      next++;
      if (number > 1) results.push(commandResult(text, number - 1));
      if (results.length === commands.length) {
        clearTimeout(timer);
        shell.stdin.end('exit\n');
        return resolve(results);
      }
      shell.stdin.write(`${commands[number - 1]}\n`);
    });
  });
}

test('scoutPane in the config: an rc file, the sandbox, its network and the folders it may write', () => {
  assert.deepEqual(scoutPaneConfig(), {rc: null, sandbox: 'auto', network: false, writable: []});
  assert.deepEqual(scoutPaneConfig({rc: true, sandbox: true, network: true, writable: ['~/.cache']}), {
    rc: join(homedir(), '.bashrc'), sandbox: true, network: true, writable: [join(homedir(), '.cache')],
  });
  assert.equal(scoutPaneConfig({rc: '~/.config/pair.bashrc'}).rc, join(homedir(), '.config/pair.bashrc'));
  assert.throws(() => scoutPaneConfig({sandbox: 'yes'}), /"auto", true or false/);
  assert.throws(() => scoutPaneConfig({rcfile: '~/.bashrc'}), /scoutPane.rcfile is not a setting/);
  assert.throws(() => scoutPaneConfig({writable: '~/.cache'}), /must list folders/);
});

test('the pane\'s shell line: a plain bash, or one that loads the rc file, and the sandbox only where it works', () => {
  const cwd = '/project';
  assert.equal(shellLine({setup: plain, cwd}).line, "exec env HISTFILE= 'PS1=scout[\\#] exit $? $ ' bash --noprofile --norc -i");
  const rc = shellLine({setup: scoutPaneConfig({rc: '/home/me/.bashrc', sandbox: false}), cwd}).line;
  assert.match(rc, /PAIR_SCOUT_RC=\/home\/me\/.bashrc bash --noprofile --rcfile \S+\/scout-pane.bash -i$/);

  const auto = scoutPaneConfig();
  assert.deepEqual(shellLine({setup: auto, cwd, works: () => false}), {line: shellLine({setup: plain, cwd}).line, sandboxed: false});
  const inside = shellLine({setup: auto, cwd, works: () => true});
  assert.equal(inside.sandboxed, true);
  assert.match(inside.line, / bwrap --ro-bind \/ \/ .* --unshare-all --chdir \/project bash /);
  assert.throws(() => shellLine({setup: scoutPaneConfig({sandbox: true}), cwd, works: () => false}), /bubblewrap/);
});

test('the sandbox: the disk read-only, the project and named folders writable, sockets hidden, network off unless allowed', () => {
  const dir = scratch();
  const cache = join(dir, 'cache');
  mkdirSync(cache);
  const socket = join(dir, 'herdr.sock');
  writeFileSync(socket, '');
  const words = sandboxWords({cwd: dir, writable: [cache, join(dir, 'missing')], hidden: [socket], runtimeDir: '/run/user/1', caches: [], sockets: []});
  const at = (...seq) => words.findIndex((_, i) => seq.every((word, j) => words[i + j] === word));
  assert.ok(at('--ro-bind', '/', '/') === 1);
  assert.ok(at('--tmpfs', '/run/user/1') > 0);
  assert.ok(at('--bind', dir, dir) > 0 && at('--bind', cache, cache) > 0);
  assert.equal(words.includes(join(dir, 'missing')), false, 'a folder that is not there is left out');
  assert.ok(at('--ro-bind', '/dev/null', socket) > at('--bind', dir, dir), 'a socket inside a writable folder stays hidden');
  assert.equal(words.includes('--share-net'), false);
  const online = sandboxWords({cwd: dir, network: true, caches: [], sockets: []});
  assert.ok(online.includes('--share-net'));
  // Name lookups through systemd-resolved, nscd, avahi or the system bus would reach the network without it.
  const resolver = '/run/systemd/resolve/io.systemd.Resolve';
  if (existsSync(resolver)) {
    assert.ok(at('--ro-bind', '/dev/null', resolver) > 0, 'without the network, no name lookups either');
    assert.equal(online.includes(resolver), false, 'with the network, lookups work');
  }
});

test('the sandbox: caches writable with their writes thrown away, and every socket of yours hidden', async () => {
  const dir = scratch();
  const [cache, project] = ['cache', 'project'].map(name => join(dir, name));
  mkdirSync(cache);
  mkdirSync(project);
  const yours = join(dir, 'client.sock');
  const server = createServer();
  await new Promise(resolve => server.listen(yours, resolve));
  try {
    assert.ok(userSockets().includes(yours), 'a listening socket of yours is found');
    const words = sandboxWords({cwd: project, caches: [cache, project], overlay: true, sockets: [yours], runtimeDir: null});
    const at = (...seq) => words.findIndex((_, i) => seq.every((word, j) => words[i + j] === word));
    assert.ok(at('--overlay-src', cache, '--tmp-overlay', cache) > 0);
    assert.equal(at('--tmp-overlay', project), -1, 'a writable folder is no cache');
    assert.ok(at('--ro-bind', '/dev/null', yours) > 0);
    assert.ok(sandboxWords({cwd: project, caches: [cache], overlay: false, sockets: []}).includes('--tmpfs'), 'without overlays, an empty one');
    assert.deepEqual(cacheFolders({XDG_CACHE_HOME: '/c', GOCACHE: '/go'}), ['/c', '/go']);
    assert.deepEqual(cacheFolders({XDG_CACHE_HOME: '/c', GOCACHE: '/c'}), ['/c']);
  } finally {
    server.close();
  }
});

test('in the sandbox a cache keeps what is there and takes new entries, which never reach the disk', {skip: overlayWorks() ? false : 'bubblewrap cannot make overlays here'}, async () => {
  const dir = scratch();
  const [cache, project] = ['cache', 'project'].map(name => join(dir, name));
  mkdirSync(cache);
  mkdirSync(project);
  writeFileSync(join(cache, 'old'), 'built before\n');
  const words = sandboxWords({cwd: project, caches: [cache], sockets: [], runtimeDir: null});
  const line = `exec env ${shellQuote('PS1=scout[\\#] exit $? $ ')} ${words.map(shellQuote).join(' ')} bash --norc -i`;
  const results = await runInShell(line, project, [`cat ${cache}/old`, `echo entry > ${cache}/new && cat ${cache}/new`]);
  assert.deepEqual(results, [{exit: 0, output: 'built before'}, {exit: 0, output: 'entry'}]);
  assert.equal(existsSync(join(cache, 'new')), false);
});

test('with the rc file the pane has its aliases, functions and environment, and still reads exit codes', async () => {
  const dir = scratch();
  const rc = join(dir, 'bashrc');
  writeFileSync(rc, RC);
  const {line} = shellLine({setup: scoutPaneConfig({rc, sandbox: false}), cwd: dir});
  const results = await runInShell(line, dir, ['ll -d .', 'greet you', 'echo $FROM_RC', 'false', 'sh -c "exit 7"', 'echo $HISTFILE.', 'false | true', 'echo $UNSET.']);
  assert.deepEqual(results.map(result => result.exit), [0, 0, 0, 1, 7, 0, 0, 0], 'a pipeline ends as its last command, as without the rc file');
  assert.deepEqual(results.map(result => result.output), ['.', 'hi you', 'yes', '', '', '.', '', '.'], 'no DEBUG trap output, and no history file');
});

test('the rc file\'s aliases and functions are listed for the command policy', async () => {
  const dir = scratch();
  const rc = join(dir, 'bashrc');
  writeFileSync(rc, `${RC}alias t='npm test -- --watch=false'\n`);
  const names = await rcNames(rc, dir);
  assert.deepEqual(names.aliases, {ll: 'ls -1', t: 'npm test -- --watch=false'});
  assert.ok(names.functions.includes('greet'));
  const exits = join(dir, 'exits');
  writeFileSync(exits, 'exit 0\n');
  await assert.rejects(rcNames(exits, dir), /could not list the aliases and functions/);
});

test('in the sandbox, commands write only the project, reach no network and no hidden socket', {skip: sandboxWorks() ? false : 'bubblewrap does not work here'}, async () => {
  const dir = scratch();
  const project = join(dir, 'project');
  mkdirSync(project);
  // Inside the writable project, where nothing but hiding it keeps it out of reach.
  const socket = join(project, 'herdr.sock');
  const server = createServer(connection => connection.end('reached\n'));
  await new Promise(resolve => server.listen(socket, resolve));
  try {
    // An rc file in /tmp, which is a private one in the sandbox.
    const rc = join(dir, 'bashrc');
    writeFileSync(rc, RC);
    // Not named as hidden: it is hidden as a socket of yours.
    const {line, sandboxed} = shellLine({setup: scoutPaneConfig({rc, sandbox: true}), cwd: project});
    assert.equal(sandboxed, true);
    const marker = mkdtempSync('/tmp/pair-marker-');
    const results = await runInShell(line, project, [
      'touch made && ll',
      `touch ${join(homedir(), '.pair-sandbox-probe')}`,
      `touch ${join(dir, 'outside')}`,
      'ls /tmp',
      `node -e "require('net').connect('${socket}').on('data', d => process.stdout.write(d)).on('error', e => { console.log(e.code); process.exit(3); })"`,
      'node -e "require(\'net\').connect(53, \'1.1.1.1\').on(\'connect\', () => process.exit(0)).on(\'error\', e => { console.log(e.code); process.exit(4); })"',
    ]);
    assert.deepEqual(results[0], {exit: 0, output: 'herdr.sock\nmade'});
    assert.equal(results[1].exit, 1);
    assert.match(results[1].output, /Read-only file system/);
    assert.equal(existsSync(join(homedir(), '.pair-sandbox-probe')), false);
    assert.equal(results[2].exit, 0, '/tmp is writable');
    assert.equal(existsSync(join(dir, 'outside')), false, 'but its files stay in the sandbox');
    assert.equal(results[3].output.includes(basename(marker)), false, 'a private /tmp');
    assert.equal(results[4].exit, 3, `the hidden socket: ${results[4].output}`);
    assert.equal(results[5].exit, 4, `the network: ${results[5].output}`);
  } finally {
    server.close();
  }
});

const hasGo = spawnSync('go', ['version'], {stdio: 'ignore'}).status === 0;

test('go test runs in the default sandbox on a module it never built, with its cache writes thrown away', {skip: sandboxWorks() && hasGo ? false : 'needs bubblewrap and go', timeout: 120_000}, async () => {
  const project = join(scratch(), 'mod');
  mkdirSync(project);
  // A module and a test nobody built before, so each build result is a new cache entry.
  const unique = `${process.pid}${Date.now()}`;
  writeFileSync(join(project, 'go.mod'), `module example.com/m${unique}\n\ngo 1.21\n`);
  writeFileSync(join(project, 'm_test.go'), `package m\n\nimport "testing"\n\nfunc TestUnique(t *testing.T) { if ${unique} == 0 { t.Fatal() } }\n`);
  const {line} = shellLine({setup: scoutPaneConfig(), cwd: project});
  const [result] = await runInShell(line, project, ['go test -count=1 ./...']);
  assert.equal(result.exit, 0, result.output);
  assert.match(result.output, /^ok\s+example\.com\/m/);
});
