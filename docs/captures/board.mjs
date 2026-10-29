#!/usr/bin/env node
// Stands in for the work board's command, Shepherdr's `shepherdr`, in the scenes: the verbs Pair reads (space list,
// task list --json, task show --json, artifact list), and the two it writes on your pick (task add, task tell). With
// CAP_BOARD naming a state file ({spaces, tasks}, which the stage writes and changes as a scene goes on), it answers
// from that; without, it is the context-card scene's board: hookd's tasks, and another space's task with the same
// number, which the card must not take for this branch's.
import {readFileSync, writeFileSync} from 'node:fs';

const state = process.env.CAP_BOARD ? JSON.parse(readFileSync(process.env.CAP_BOARD, 'utf8')) : {
  spaces: [{name: 'hookd', key: 'HKD', path: '/work/hookd'}, {name: 'webapp', key: 'WEB', path: '/work/webapp'}],
  tasks: [
    {id: 'HKD-7', status: 'work', title: 'Retries reach the budget', sub: 'Tracing attempt 5 against the 15 s budget', place: 'p:here:hookd', branch: 'work/7-retries-reach-the-budget'},
    {id: 'HKD-8', status: 'work', title: 'Dead-letter queue for failed webhooks', sub: 'Writing the schema', place: 'p:here:hookd'},
    {id: 'HKD-6', status: 'done', title: 'Lease jobs per attempt', sub: 'Merged', place: 'p:here:hookd'},
    {id: 'WEB-7', status: 'work', title: 'Dark mode', sub: '', place: 'p:here:webapp'},
  ],
};
const args = process.argv.slice(2);
const [verb, sub, id] = args;
const space = args.includes('--space') ? args[args.indexOf('--space') + 1] : null;
const spaceOf = task => task.place.split(':').slice(2).join(':');
const say = text => { console.log(text); process.exit(0); };

if (verb === 'space' && sub === 'list') say(state.spaces.map(s => `${s.name}  ${s.key}  ${s.path}`).join('\n'));
if (verb === 'task' && sub === 'list') say(JSON.stringify(state.tasks.filter(t => !space || spaceOf(t) === space).map(({id, title, status, sub}) => ({id, title, status, sub}))));
if (verb === 'task' && sub === 'show') {
  const task = state.tasks.find(each => each.id === id);
  if (!task) { console.log(`No task ${id}`); process.exit(1); }
  say(JSON.stringify({...task, name: task.title}));
}
if (verb === 'artifact' && sub === 'list') say('No artifacts here yet.');
// The writes Pair makes on a pick (/gen board's add, a tell): kept in the state file, so the next read shows them.
const keep = () => process.env.CAP_BOARD && writeFileSync(process.env.CAP_BOARD, JSON.stringify(state));
if (verb === 'task' && sub === 'add') {
  const [title] = args.slice(2).filter(word => !word.startsWith('--'));
  const named = flag => args.find(word => word.startsWith(`--${flag}=`))?.slice(flag.length + 3);
  const home = state.spaces.find(each => each.name === named('space')) ?? state.spaces[0];
  const n = Math.max(0, ...state.tasks.map(t => Number(t.id.split('-')[1]))) + 1;
  const later = args.includes('--later');
  state.tasks.push({id: `${home.key}-${n}`, title, status: later ? 'todo' : 'work', sub: later ? 'Waiting for a go' : 'Reading the brief', place: `p:here:${home.name}`, desc: named('brief')});
  keep();
  say(`Added ${home.key}-${n}: ${title}${later ? ' (waits for a go)' : ''}`);
}
if (verb === 'task' && sub === 'tell') {
  const task = state.tasks.find(each => each.id === id);
  if (!task) { console.log(`No task ${id}`); process.exit(1); }
  (state.told ??= []).push({id, text: args[3]});
  keep();
  say(`Told ${id}.`);
}
console.log(`the stand-in board answers only what Pair reads, not: ${args.join(' ')}`);
process.exit(2);
