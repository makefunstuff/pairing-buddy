#!/usr/bin/env node
// Stands in for the herdr work board's `list --json` in the context-card capture: hookd's tasks, and another repo's
// task with the same number, which the card must not take for this branch's.
if (process.argv[2] !== 'list') process.exit(2);
console.log(JSON.stringify([
  {id: 'hookd/7', state: 'working', title: 'Retries reach the budget', msg: 'Tracing attempt 5 against the 15 s budget'},
  {id: 'hookd/8', state: 'working', title: 'Dead-letter queue for failed webhooks', msg: 'Writing the schema'},
  {id: 'hookd/6', state: 'done', title: 'Lease jobs per attempt', msg: 'Merged'},
  {id: 'webapp/7', state: 'working', title: 'Dark mode', msg: ''},
]));
