// What the full-screen chat pane draws, as plain text: Pair's Markdown, a suggestion's diff, the gutter of who
// speaks, folding, the status in its rule in each state, the keys of the footer, the colours each part is drawn
// with, and the whole frame.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LineEditor} from '../src/chat-input.mjs';
import {bodyLines, dedent, emptyLines, footerKeys, footerLine, headerLine, helpLines, markdownLines, renderFrame, statusLine, transcriptLines} from '../src/chat-render.mjs';
import {COMMANDS} from '../src/chat.mjs';
import {paintLine, textWidth} from '../src/chat-style.mjs';

const plain = lines => lines.map(line => line.map(seg => seg.text).join(''));
const at = new Date(2026, 9, 28, 14, 5).getTime();

test('Markdown: headings, bold, `code`, lists with a hanging indent, quotes and fenced code', () => {
  const text = '# The cause\nThe **lease ends** in `queue.go:18` before the last attempt.\n\n- one item long enough to wrap\n2. two\n> a quote\n\n```go\nttl := cfg.Budget\n```\n\nAfter.';
  assert.deepEqual(plain(markdownLines(text, 30)), [
    'The cause',
    'The lease ends in queue.go:18',
    'before the last attempt.',
    '',
    '• one item long enough to wrap',
    '2. two',
    '▎ a quote',
    '',
    '│ ttl := cfg.Budget',
    '',
    'After.',
  ]);
  const styles = markdownLines('a `b` **c**', 30)[0].map(seg => [seg.text, seg.style]);
  assert.deepEqual(styles, [['a', 'text'], [' ', 'text'], ['b', 'code'], [' ', 'bold'], ['c', 'bold']]);
  assert.deepEqual(plain(markdownLines('```diff\n-old\n+new\n```', 30)), ['│ -old', '│ +new']);
  assert.deepEqual(markdownLines('```diff\n-old\n+new\n```', 30).map(line => line[1].style), ['del', 'add']);
  assert.deepEqual(plain(markdownLines('    indented code stays', 12)), ['  indented c', '  ode stays'], 'code is cut, not wrapped at words');
});

test('a suggestion is a diff, its shared indentation gone; a remark says what it is about first', () => {
  const entry = {kind: 'pair', at, text: 'queue.go:18 suggestion: lease past the last attempt\n\treturn x', meta: {place: {file: 'queue.go', line: 18}, suggestion: {action: 4, old: ['\treturn &Queue{ttl: b}'], new: ['\treturn &Queue{ttl: b + t}']}}};
  assert.deepEqual(plain(bodyLines(entry, 24)), [
    '✎ suggested change · qu…',
    'lease past the last',
    'attempt',
    '│- return &Queue{ttl: b}',
    '│+ return &Queue{ttl: b ',
    '│  + t}',
  ]);
  assert.deepEqual(dedent(['\t\tif x {', '\t\t\ty()', '', '\t\t}']), ['if x {', '    y()', '', '}']);
  const remark = {kind: 'watch', at, text: 'You moved to docs/.', meta: {remark: 3, trigger: 'drift', place: {file: 'docs/a.md', line: 3}}, verdict: 'useful'};
  assert.deepEqual(plain(bodyLines(remark, 40)), ['drift · docs/a.md:3  ✓ useful', 'You moved to docs/.']);
});

test('the gutter: the time and who speaks on a turn\'s first line, a bar on the selected message, ⎿ for the tools', () => {
  const entries = [
    {kind: 'you', at, text: 'why does attempt 5 fail?'},
    {kind: 'tool', at, tools: [{tool: 'read', what: 'queue.go 1-40'}, {tool: 'run', what: 'go test ./...'}]},
    {kind: 'pair', at, text: 'The lease ends early.'},
    {kind: 'pair', at, text: 'queue.go:18 the lease', meta: {place: {file: 'queue.go', line: 18}}},
    {kind: 'system', at, text: 'Goal: retries'},
    {kind: 'system', at, text: 'Talk level: quiet'},
  ];
  const {lines, ranges} = transcriptLines(entries, 60, {selected: 2});
  assert.deepEqual(plain(lines), [
    ' 14:05 you   why does attempt 5 fail?',
    '             ⎿ read queue.go 1-40 · ran go test ./...',
    '',
    '▌14:05 pair  The lease ends early.',
    '',
    '             queue.go:18 the lease',
    '',
    ' 14:05 ··    Goal: retries',
    '             Talk level: quiet',
  ]);
  assert.deepEqual(ranges.map(r => [r.start, r.end]), [[0, 1], [1, 2], [3, 4], [5, 6], [7, 8], [8, 9]]);
  entries[1].expanded = true;
  assert.deepEqual(plain(transcriptLines(entries.slice(0, 2), 60).lines).slice(1), ['             ⎿ read queue.go 1-40', '             ⎿ ran go test ./...']);
  assert.deepEqual(plain(transcriptLines(entries.slice(0, 1), 30).lines).map(line => line.trimEnd()), [' 14:05 you', '   why does attempt 5 fail?'], 'narrow: the name above the words');
});

test('a long message folds to its start until it is opened; the last remark shows its keys until rated', () => {
  const long = {kind: 'pair', at, text: Array.from({length: 30}, (_, i) => `line ${i + 1}`).join('\n\n')};
  const folded = plain(transcriptLines([long], 60).lines);
  assert.equal(folded.length, 13);
  assert.match(folded.at(-1), /… \d+ more lines · Alt-↑ and Enter shows all$/);
  long.expanded = true;
  assert.equal(plain(transcriptLines([long], 60).lines).length, 59);
  const remark = {kind: 'watch', at, text: 'Off the goal.', meta: {remark: 1, trigger: 'drift'}};
  assert.match(plain(transcriptLines([remark], 60, {latestRemark: 0}).lines).at(-1), /\+ useful · - noise · Alt-↑ more$/);
  remark.verdict = 'noise';
  assert.doesNotMatch(plain(transcriptLines([remark], 60, {latestRemark: 0}).lines).join('\n'), /useful · -/);
});

test('the status is in the rule over the input: what Pair does now, and on the right the model, the time and the cost of the last answer', () => {
  const now = at + 75_000;
  const row = (view, width = 72) => plain([statusLine({now, model: 'qwen3', ...view}, width)])[0];
  const idle = {activity: {state: 'idle'}, presence: {looked: 3, spoke: 1, lastAt: at}, turn: {ms: 2100, tokens: 3400, cost: 0.0042}};
  assert.equal(row(idle, 100), '── ◇ watching · looked at 3 moments, spoke 1 · 1m ago ───────── qwen3 · 2.1s · 3.4k tok · $0.0042 ──');
  assert.equal(row(idle, 72), '── ◇ watching · looked at 3 moments, spoke 1 · 1m ago ── qwen3 · 2.1s ──', 'narrower: the right side gives way');
  assert.match(row({activity: {state: 'thinking', since: at}}), /^── ▖ thinking 1m 15s ─+ qwen3 ──$/);
  assert.match(row({activity: {state: 'thinking', since: now - 6000}, writing: true}), /^── ▖ writing 6s ─+ qwen3 ──$/, 'writing, once the words arrive');
  assert.match(row({activity: {state: 'tool', tool: 'run', what: 'go test ./...', since: now - 3000}}), /^── ▖ running go test \.\/\.\.\. 3s ─/);
  assert.match(row({activity: {state: 'remark', what: 'edit_while_red', since: now}}), /^── ▖ looking at edit while red 0s ─/);
  assert.match(row({activity: {state: 'waiting'}}), /^── \? waiting for your answer ─+ qwen3 ──$/);
  assert.match(row({connection: 'away'}), /^── ⚠ the pair daemon went away · reconnecting ─+$/);
  assert.match(row({activity: {state: 'idle'}, scrolled: 12}), /─ ↓ 12 lines below ──$/);
  assert.match(row({activity: {state: 'idle'}, role: 'driver', keepWheel: true}), /◆ Pair keeps the wheel/);
  assert.equal(textWidth(row(idle, 33)), 33);
  for (const view of [idle, {activity: {state: 'thinking', since: at}}, {activity: {state: 'waiting'}}, {activity: {state: 'idle'}, scrolled: 3}]) {
    assert.doesNotMatch(row(view, 120), /Esc|End|\by\b allow|decline/, 'the status names no keys');
  }
});

test('the header is in the top rule; the goal is cut first, then the level and the role give way', () => {
  const header = {project: 'hookd', goal: 'make the queue lease outlive the last retry', role: 'navigator', level: 'normal'};
  const line = width => plain([headerLine(header, width)])[0];
  assert.equal(line(86), '── pair · hookd · make the queue lease outlive the last retry ── navigator · normal ──');
  assert.equal(line(60), '── pair · hookd · make the queue l… ── navigator · normal ──');
  assert.equal(line(44), '── pair · hookd · make the … ── navigator ──');
  assert.equal(plain([headerLine({}, 20)])[0], '── pair ────────────');
});

test('colour: yellow only for the Watcher and a waiting ?; dim never for words addressed to you', () => {
  const styles = line => line.filter(s => s.text.trim()).map(s => `${s.text.trim()}:${s.style}`);
  const confirm = {kind: 'confirm', at, text: 'May I run `go test ./internal/queue -run TestLease` in my pane (go test runs code)?'};
  assert.deepEqual(plain(bodyLines(confirm, 60)), ['May I run this in my pane (go test runs code)?', '│ go test ./internal/queue -run TestLease']);
  assert.ok(bodyLines(confirm, 60)[0].every(s => s.style === 'text'), 'the question in body text');
  assert.deepEqual(styles(bodyLines(confirm, 60)[1]), ['│:rule', 'go test ./internal/queue -run TestLease:text']);
  assert.deepEqual(plain(bodyLines({...confirm, answer: false}, 60)).at(-1), 'you declined');
  assert.equal(bodyLines({...confirm, answer: false}, 60).at(-1)[0].style, 'text');
  const gutter = plain(transcriptLines([confirm], 60).lines)[0];
  assert.match(gutter, /^ 14:05 pair  May I run this/, 'Pair asks it, as pair');
  assert.equal(transcriptLines([confirm], 60).lines[0][3].style, 'pair');
  const keys = footerLine({confirming: true}, 60);
  assert.equal(plain([keys])[0], ' y allow · n decline · Esc decline');
  assert.deepEqual(keys.filter(s => ['y', 'n'].includes(s.text)).map(s => s.style), ['answer', 'answer'], 'y and n bold yellow');
  const status = statusLine({activity: {state: 'waiting'}}, 60);
  assert.deepEqual(status.filter(s => s.style === 'warn').map(s => s.text.trim()), ['?']);
  assert.ok(status.some(s => s.text === 'waiting for your answer' && s.style === 'text'), 'the status word at body-text weight');
  for (const kind of ['system', 'note']) {
    assert.ok(bodyLines({kind, at, text: 'tests on save: 1 failed'}, 60)[0].every(s => s.style === 'text'), `${kind} notes in body text`);
  }
  const remark = {kind: 'watch', at, text: 'Off the goal.', meta: {remark: 1, trigger: 'drift', place: {file: 'a.md', line: 3}}};
  assert.deepEqual(bodyLines(remark, 60)[0].map(s => s.style), ['watchMeta', 'watchMeta'], 'the remark\'s kind in yellow');
  assert.ok(emptyLines(60).flat().every(s => s.style !== 'dim'), 'the empty card speaks in body text');
  assert.ok(markdownLines('> a quote', 40)[0].slice(1).every(s => s.style === 'italic'));
  const frame = renderFrame({entries: [confirm], editor: new LineEditor(), editorEmpty: true, confirming: true, placeholder: 'or type an answer', activity: {state: 'waiting'}, model: 'qwen3'}, {width: 60, height: 10, look: {color: true}});
  assert.match(frame.lines.at(-2), /^\x1b\[36my\/N › /, 'the y/N prompt in the accent, not yellow');
  assert.equal(frame.lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n').match(/\bdecline\b/g).length, 2, 'the answer keys once: in the footer');
});

test('the footer shows the keys that work now', () => {
  const keys = view => footerKeys(view).map(([k]) => k).join(' ');
  assert.equal(keys({}), '/ @ Alt-↑ ?');
  assert.equal(keys({editorEmpty: false}), 'Enter Alt-Enter Tab');
  assert.equal(keys({busy: true}), 'Esc / @ Alt-↑ ?');
  assert.equal(keys({confirming: true}), 'y n Esc');
  assert.equal(keys({confirming: true, editorEmpty: false}), 'Enter Esc');
  assert.equal(keys({scroll: 4}), 'End / @ Alt-↑ ?', 'scrolled up: End comes back down');
  assert.equal(keys({mode: 'select', selectedEntry: {kind: 'watch', meta: {remark: 1, place: {}, suggestion: {}}}}), 'c a j +/- m f e Esc');
  assert.equal(keys({mode: 'select', selectedEntry: {kind: 'you', meta: {}}}), 'c Esc');
  assert.equal(keys({mode: 'search'}), 'type ↑↓ Enter Esc');
});

test('the frame: header in its rule, conversation, status in its rule, input and footer, exactly the pane\'s size, the cursor where you type', () => {
  const editor = new LineEditor();
  editor.insert('hello');
  const view = {
    header: {project: 'hookd', goal: 'retries reach the budget', role: 'navigator', level: 'normal', muted: ['drift']},
    entries: [{kind: 'you', at, text: 'why?'}, {kind: 'pair', at, text: 'Because.'}],
    editor, selected: -1, activity: {state: 'idle'}, model: 'qwen3',
  };
  const {lines, cursor} = renderFrame({...view, editorEmpty: false}, {width: 60, height: 12});
  assert.equal(lines.length, 12);
  assert.ok(lines.every(line => textWidth(line) <= 60));
  assert.deepEqual(lines.slice(1).map(line => line.trimEnd()), [
    '',
    '',
    '',
    '',
    '',
    ' 14:05 you   why?',
    '',
    ' 14:05 pair  Because.',
    '── ◇ watching ───────────────────────────────────── qwen3 ──',
    '› hello',
    ' Enter send · Alt-Enter newline · Tab complete',
  ]);
  assert.equal(lines[0], '── pair · hookd · retries reach th… ── navigator · normal ──', 'the goal is cut first');
  assert.deepEqual(cursor, {row: 10, column: 7});
  const empty = renderFrame({...view, entries: [], showEmpty: true, editor: new LineEditor(), placeholder: 'Ask Pair anything'}, {width: 60, height: 24});
  assert.ok(empty.lines.some(line => line.includes('Pair · your pair in the second chair')));
  assert.ok(empty.lines.some(line => line.includes('› Ask Pair anything')));
  const painted = renderFrame(view, {width: 60, height: 12, look: {color: true, accent: '#7fd1b9'}});
  assert.match(painted.lines[0], /\x1b\[38;2;127;209;185m\x1b\[1mpair/, 'Pair\'s name in the editor\'s accent');
  assert.equal(paintLine([{text: 'x', style: 'add'}], {color: false}), 'x');
});

test('the help: each key and command, then what it does, never run together', () => {
  const lines = plain(helpLines(COMMANDS, 80)).filter(line => line.startsWith('  '));
  assert.ok(lines.length > COMMANDS.length);
  for (const line of lines) assert.match(line, /^.{14} \S/, line); // the column, then a space, then the words
  assert.ok(lines.some(line => /^ {2}\/drive +hand Pair the wheel/.test(line)));
  assert.ok(lines.some(line => /^ {2}\/goal <text> +set the session goal/.test(line)));
});

test('Markdown inline: _italic_ and *italic*, [links](url) as words and address; snake_case and 2*3*4 stay as written', () => {
  const styled = text => markdownLines(text, 80)[0].filter(seg => seg.text.trim()).map(seg => [seg.text, seg.style]);
  assert.deepEqual(styled('an _ital_ and *also* word').map(([text, style]) => `${text}:${style}`), ['an:text', 'ital:italic', 'and:text', 'also:italic', 'word:text']);
  assert.deepEqual(styled('see [the docs](http://x.y/z) now').map(([text, style]) => `${text}:${style}`), ['see:text', 'the:under', 'docs:under', '(http://x.y/z):dim', 'now:text']);
  assert.deepEqual(plain(markdownLines('a trigger_kind and 2*3*4', 80)), ['a trigger_kind and 2*3*4']);
});
