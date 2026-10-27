// The Watcher's pace, before (`watcherPace: false`, as before the pace) and after: 40 moments of a working hour
// through the speak gate, the score memory and the pace, against a fake Watcher answering in a set time. The numbers
// in docs/watcher.md ("When the server is slow") come from it. Not a test: run it by hand, it takes about 7 minutes.
//   node test/pace-bench.mjs [latencies in ms, comma-separated; default 300,1000,1700,3500]
import {Budget} from '../src/budget.mjs';
import {initialState} from '../src/fold.mjs';
import {decide} from '../src/gate.mjs';
import {KEPT, Pace} from '../src/pace.mjs';
import {rememberScores} from '../src/score-memory.mjs';

// 40 moments of a working hour: the kinds that come up, with repeats (#again) and plain noise (#grep) among them.
const MIX = [
  'failed_command', 'drift', 'number_moved', 'new_code_diagnostic', 'same_result', 'stall', 'note_stall', 'repeated_error',
  'drift', 'new_warning', 'search_trail', 'failed_command#grep', 'edit_while_red', 'note_drift', 'number_moved', 'crash',
  'drift', 'regression', 'same_result', 'stall', 'number_moved', 'new_code_diagnostic', 'drift#again', 'failed_command',
  'note_stall', 'new_warning', 'number_moved#again', 'repeated_error', 'search_trail', 'drift', 'same_result', 'crash',
  'number_moved', 'note_drift', 'stall', 'failed_command#grep', 'drift', 'new_code_diagnostic', 'regression', 'same_result',
];
const kinds = MIX.map(name => name.split('#')[0]);
const moments = MIX.map((name, i) => {
  const [kind, tag] = name.split('#');
  const n = tag === 'again' ? kinds.slice(0, i).lastIndexOf(kind) : i; // the same moment as one before it
  return {kind, key: `${kind}:${i}`, detail: `${kind} ${n}`, ...(tag === 'grep' ? {command: {cmd: 'grep TODO', exit: 1}} : {})};
});

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const s = ms => (ms / 1000).toFixed(1);

async function run(latencyMs, paceOn) {
  const pace = new Pace({on: paceOn});
  let calls = 0;
  let busy = 0;
  const watcher = async () => {
    calls += 1;
    const started = Date.now();
    await new Promise(done => setTimeout(done, latencyMs));
    busy += Date.now() - started;
    pace.hear(Date.now() - started);
    return {value: 7, reason: 'x'};
  };
  const score = rememberScores(watcher, {momentOf: trigger => trigger.detail});
  const news = []; // how long a moment you cannot see waited for its verdict, from when its burst came up
  const skipped = new Set();
  // Moments come up four at a time (a tick sees what came up since the last), and the gate takes them in turn.
  for (let at = 0; at < moments.length; at += 4) {
    const burst = Date.now();
    for (const [j, trigger] of moments.slice(at, at + 4).entries()) {
      const budget = new Budget('chatty'); // every moment reaches the Watcher: the budget is not what is measured
      const decision = await decide({trigger, state: initialState(), now: 600_000 + at + j, budget, score, typingPauseMs: 0, pace});
      if (KEPT.includes(trigger.kind) && !trigger.command) news.push(Date.now() - burst);
      if (decision.skipped) skipped.add(trigger.kind);
    }
  }
  return {calls, busy: s(busy), news: s(median(news)), worst: s(Math.max(...news)), level: pace.level, skipped: [...skipped].join(', ')};
}

console.log('| Watcher latency | Watcher calls | Watcher busy (s) | wait for news you cannot see, median / worst (s) | pace after; kinds not asked |');
console.log('|---|---|---|---|---|');
for (const ms of (process.argv[2] ?? '300,1000,1700,3500').split(',').map(Number)) {
  const before = await run(ms, false);
  const after = await run(ms, true);
  console.log(`| ${ms} ms | ${before.calls} → ${after.calls} | ${before.busy} → ${after.busy} | ${before.news} / ${before.worst} → ${after.news} / ${after.worst} | ${after.level}; ${after.skipped || '-'} |`);
}
