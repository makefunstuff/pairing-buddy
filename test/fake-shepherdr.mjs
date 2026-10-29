// A stand-in for the work board's command, `shepherdr`, for the tests: a script that answers from a state file the
// test writes (its spaces, tasks and artifacts) and notes every call it gets. It never reaches a real Shepherdr.
import {chmodSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const SCRIPT = String.raw`#!/usr/bin/env node
const {appendFileSync, readFileSync, writeFileSync} = require('node:fs');
const dir = __dirname;
const args = process.argv.slice(2);
appendFileSync(dir + '/calls.jsonl', JSON.stringify(args) + '\n');
const state = JSON.parse(readFileSync(dir + '/state.json', 'utf8'));
const out = text => { process.stdout.write(text.endsWith('\n') ? text : text + '\n'); process.exit(0); };
const fail = text => { process.stdout.write(text + '\n'); process.exit(1); };
if (state.down) { process.stderr.write('Shepherdr is not running here\n'); process.exit(2); }
// Options as Shepherdr's own parser (server/live/args.ts) reads them: --name=value, else --name and the next word,
// unless it is a flag, the last word, or the next word starts with -- (then --name is a flag, without its value).
const FLAGS = new Set(['json', 'later', 'archived', 'force']);
const opts = {}, flags = new Set(), words = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) { words.push(a); continue; }
  const eq = a.indexOf('=');
  const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
  if (eq > 0) opts[name] = a.slice(eq + 1);
  else if (FLAGS.has(name) || i + 1 >= args.length || args[i + 1].startsWith('--')) flags.add(name);
  else opts[name] = args[++i];
}
const opt = name => opts[name] ?? null;
const spaceOf = task => task.place.split(':').slice(2).join(':');
const [a0, a1, a2] = words;
if (a0 === 'space' && a1 === 'list') out(['~  (home space)  /home/me', ...state.spaces.map(s => s.name + '  ' + s.key + '  ' + s.path + (s.github ? '  github:' + s.github : ''))].join('\n'));
if (a0 === 'task' && a1 === 'list') {
  const space = opt('space');
  const tasks = state.tasks.filter(t => !t.archived && (!space || spaceOf(t) === space));
  if (!flags.has('json')) out(tasks.map(t => t.id + ' ' + t.status + ' ' + t.title).join('\n'));
  out(JSON.stringify(tasks.map(t => ({id: t.id, title: t.title, status: t.status, sub: t.sub ?? '', archived: t.archived, pinned: undefined})), null, 2));
}
if (a0 === 'task' && a1 === 'show') {
  const t = state.tasks.find(each => each.id === a2);
  if (!t) fail('No task ' + a2);
  out(JSON.stringify({id: t.id, name: t.title, status: t.status, place: t.place, sub: t.sub ?? '', branch: t.branch, pr: t.pr, outcome: t.outcome, desc: t.desc ?? 'No brief yet.'}, null, 2));
}
// As Shepherdr prints them: the list names the space an artifact is kept in (a task's agent's goes in its task's
// space), and only show says who made it.
if (a0 === 'artifact' && a1 === 'list') {
  const space = opt('space');
  out((state.artifacts ?? []).filter(a => !space || a.space === space).map(a => a.id + '  v1  ' + a.title + '  · ' + a.space + ' · 2h').join('\n') || 'No artifacts here yet.');
}
if (a0 === 'artifact' && a1 === 'show') {
  const a = (state.artifacts ?? []).find(each => each.id === a2);
  if (!a) fail('No artifact ' + a2 + ' on this machine; shepherdr artifact list shows them');
  out(a.id + ' “' + a.title + '” in ' + a.space + ': v1, 2h ago by ' + a.by + '. Its Send and notes go to ' + a.by + '.\nHTML: ' + a.html + '\nData: none\nCopy them to edit; shepherdr artifact update ' + a.id + ' makes the new version.\nVersions:\n  v1  2h  ' + a.by);
}
if (a0 === 'task' && a1 === 'add') {
  const title = a2;
  if (!title || title.length > 32) fail('A title is at most 32 characters: ' + JSON.stringify(title));
  const bare = [...flags].filter(f => f !== 'later')[0];
  if (bare) fail('--' + bare + ' needs a value');
  const name = opt('space') ?? state.spaces[0].name;
  const space = state.spaces.find(s => s.name === name);
  if (!space) fail('No space called ' + name);
  const id = space.key + '-' + (state.next ?? 90);
  state.next = (state.next ?? 90) + 1;
  state.tasks.push({id, title, status: flags.has('later') ? 'todo' : 'work', place: 'p:here:' + space.name, desc: opt('brief')});
  writeFileSync(dir + '/state.json', JSON.stringify(state));
  out(flags.has('later') ? 'Added ' + id + ': ' + title + ', for later. Its agent (Claude) reads the brief now and waits for a go (shepherdr task tell ' + id + ' "go").' : 'Added ' + id + ': ' + title + '. Its agent (Claude) starts on the brief now.');
}
if (a0 === 'task' && a1 === 'tell') out('Told ' + a2 + '.');
fail('shepherdr (fake): no ' + args.join(' '));
`;

/**
 * Writes the fake board into `dir`, its state `state` ({spaces, tasks, artifacts}): {command, set(state), calls()},
 * where calls() lists the argument lists it got. Each task is {id, title, status, sub, place: 'p:here:<space>',
 * branch, pr: {number, url}}; each artifact {id, title, space, by: 'BDY-7 agent', html}, newest first.
 */
export function fakeShepherdr(dir, state) {
  const command = join(dir, 'shepherdr');
  writeFileSync(join(dir, 'package.json'), '{"type": "commonjs"}'); // the script is CommonJS, whatever the test is
  writeFileSync(command, SCRIPT);
  chmodSync(command, 0o755);
  writeFileSync(join(dir, 'calls.jsonl'), '');
  const set = next => writeFileSync(join(dir, 'state.json'), JSON.stringify({spaces: [], tasks: [], artifacts: [], ...next}));
  set(state);
  return {
    command,
    set,
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
    calls: () => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []),
  };
}
