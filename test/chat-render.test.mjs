// What the full-screen chat pane draws, as plain text: Pair's Markdown, a suggestion's diff, the gutter of who
// speaks, folding, the status in its rule in each state, the keys of the footer, the colours each part is drawn
// with, and the whole frame.
import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {LineEditor} from '../src/chat-input.mjs';
import {baseNames, bodyLines, genStatus, heldText, breakText, codeLines, cutStart, dedent, diffLines, emptyLines, footerKeys, footerLine, headerLine, helpLines, markdownLines, menuLines, remarkKeys, renderFrame, statusLine, transcriptLines, wrapTokens, inlineTokens} from '../src/chat-render.mjs';
import {COMMANDS} from '../src/chat.mjs';
import {STYLES, paintLine, textWidth} from '../src/chat-style.mjs';

const plain = lines => lines.map(line => line.map(seg => seg.text).join(''));
const at = new Date(2026, 9, 28, 14, 5).getTime();
// Today is the day of `at`, whatever the day the tests run: a divider says another day's name.
mock.timers.enable({apis: ['Date'], now: at + 60 * 60_000});

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
  assert.deepEqual(plain(markdownLines('    indented code stays', 12)), ['  indented', '    code', '    stays'], 'code wraps at its spaces, with a hanging indent');
});

test('a suggestion is a diff, its shared indentation gone; a remark says what it is about first', () => {
  const entry = {kind: 'pair', at, text: 'queue.go:18 suggestion: lease past the last attempt\n\treturn x', meta: {place: {file: 'queue.go', line: 18}, suggestion: {action: 4, old: ['\treturn &Queue{ttl: b}'], new: ['\treturn &Queue{ttl: b + t}']}}};
  assert.deepEqual(plain(bodyLines(entry, 24)), [
    '✎ suggested change · qu…',
    'lease past the last',
    'attempt',
    '│ - return &Queue{ttl:',
    '│     b}',
    '│ + return &Queue{ttl: b',
    '│     + t}',
  ]);
  assert.deepEqual(dedent(['\t\tif x {', '\t\t\ty()', '', '\t\t}']), ['if x {', '    y()', '', '}']);
  const remark = {kind: 'watch', at, text: 'You moved to docs/.', meta: {remark: 3, trigger: 'drift', place: {file: 'docs/a.md', line: 3}}, verdict: 'useful'};
  assert.deepEqual(plain(bodyLines(remark, 40)), ['drift · docs/a.md:3  ✓ useful', 'You moved to docs/.']);
});

test('the gutter: who speaks on a turn\'s first line, 7 columns, a bar on the selected message, └ for the tools', () => {
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
    '                        ── 14:05 ──',
    ' you   why does attempt 5 fail?',
    '       └ read queue.go 1-40 · ran go test ./...',
    '',
    '▌pair  The lease ends early.',
    '',
    '       queue.go:18 the lease',
    '',
    ' ··    Goal: retries',
    '       Talk level: quiet',
  ]);
  assert.deepEqual(ranges.map(r => [r.start, r.end]), [[1, 2], [2, 3], [4, 5], [6, 7], [8, 9], [9, 10]], 'the divider is no message\'s');
  entries[1].expanded = true;
  assert.deepEqual(plain(transcriptLines(entries.slice(0, 2), 60).lines).slice(2), ['       └ read queue.go 1-40', '       └ ran go test ./...']);
  assert.deepEqual(plain(transcriptLines(entries.slice(0, 1), 30).lines).slice(1), [' you   why does attempt 5', '       fail?'], 'narrow: the same gutter, no row for the name');
});

test('the time is a divider: at the start, after five minutes or more, and with the day across midnight; Alt-↑ shows a message\'s', () => {
  const minutes = n => at + n * 60_000;
  const entries = [
    {kind: 'you', at, text: 'a'},
    {kind: 'pair', at: minutes(4), text: 'b'},
    {kind: 'you', at: minutes(9), text: 'c'},
    {kind: 'pair', at: minutes(9), text: 'd'},
    {kind: 'you', at: new Date(2026, 9, 29, 0, 2).getTime(), text: 'e'},
  ];
  const lines = plain(transcriptLines(entries, 40, {now: at}).lines);
  assert.deepEqual(lines.map(line => line.trim()).filter(line => line.startsWith('──')), ['── 14:05 ──', '── 14:14 ──', '── Thu 29 Oct · 00:02 ──']);
  assert.deepEqual(lines.slice(0, 4), ['              ── 14:05 ──', ' you   a', '', ' pair  b'], 'centred, dim, then the message under it');
  assert.equal(lines[lines.indexOf(lines.find(line => line.includes('14:14'))) - 1], '', 'a blank row before a divider');
  const divider = transcriptLines(entries.slice(0, 1), 40).lines[0];
  assert.deepEqual(divider.filter(s => s.text.trim()).map(s => s.style), ['rule', 'dim', 'rule']);
  assert.match(plain(transcriptLines(entries.slice(0, 1), 40, {now: minutes(60 * 24)}).lines)[0], /── Wed 28 Oct · 14:05 ──/, 'yesterday\'s first message says its day');
  assert.equal(plain(transcriptLines([entries[0], {kind: 'you', at: minutes(1), text: 'f'}], 40).lines).join('\n').match(/you/g).length, 1, 'the same speaker within the pause: one name');
  const picked = footerLine({mode: 'select', selectedEntry: {kind: 'pair', at, meta: {}}, now: at}, 40);
  assert.equal(plain([picked])[0], `${' c copy · Esc back'.padEnd(35)}14:05`, 'the picked message\'s time, in the footer, on the right');
  assert.equal(picked.at(-1).style, 'dim');
  assert.equal(plain([footerLine({mode: 'select', selectedEntry: {kind: 'pair', at, meta: {}}, now: minutes(60 * 24)}, 40)])[0], `${' c copy · Esc back'.padEnd(22)}Wed 28 Oct · 14:05`);
});

test('a long message folds to its start until it is opened, and says so; the last remark shows its action line until rated', () => {
  const long = {kind: 'pair', at, text: Array.from({length: 30}, (_, i) => `line ${i + 1}`).join('\n\n')};
  const folded = plain(transcriptLines([long], 60).lines).slice(1);
  assert.equal(folded.length, 13);
  assert.match(folded.at(-1), /… \d+ more lines · Alt-↑ and Enter shows all$/);
  long.expanded = true;
  assert.equal(plain(transcriptLines([long], 60).lines).length, 60);
  long.expanded = false;
  assert.match(plain(transcriptLines([long], 30).lines).at(-1), /^ {7}… \d+ more · Alt-↑ Enter$/, 'a narrow pane: the fold line shorter, not cut');
  // The pane knows a message is folded from the fold itself, at any width (it used to count rows: > 13).
  for (const width of [44, 60, 120]) assert.equal(transcriptLines([long], width).ranges[0].folded, true, `${width} columns`);
  assert.equal(transcriptLines([{...long, expanded: true}], 60).ranges[0].folded, false);
  assert.equal(transcriptLines([{kind: 'pair', at, text: Array.from({length: 13}, (_, i) => `l${i}`).join('\n')}], 60).ranges[0].folded, false, '13 lines: not folded');
  const remark = {kind: 'watch', at, text: 'Off the goal.', meta: {remark: 1, trigger: 'drift'}};
  assert.match(plain(transcriptLines([remark], 60, {latestRemark: 0}).lines).at(-1), /^ {7}\+ useful {2}- noise {2}· Alt-↑ first$/);
  remark.verdict = 'noise';
  assert.doesNotMatch(plain(transcriptLines([remark], 60, {latestRemark: 0}).lines).join('\n'), /useful {2}-/);
});

test('the status is in the rule over the input: what Pair does now, and on the right the model, the time and the cost of the last answer', () => {
  const now = at + 75_000;
  const row = (view, width = 72) => plain([statusLine({now, model: 'qwen3', ...view}, width)])[0];
  const idle = {activity: {state: 'idle'}, presence: {looked: 3, spoke: 1, lastAt: at}, turn: {ms: 2100, tokens: 3400, cost: 0.0042}};
  assert.equal(row(idle, 100), '── ◉ watching · looked at 3 moments, spoke 1 · 1m ago ───────── qwen3 · 2.1s · 3.4k tok · $0.0042 ──');
  assert.equal(row(idle, 72), '── ◉ watching · looked at 3 moments, spoke 1 · 1m ago ── qwen3 · 2.1s ──', 'narrower: the right side gives way');
  assert.match(row({activity: {state: 'thinking', since: at}}), /^── ▖ thinking 1m 15s ─+ qwen3 ──$/);
  assert.match(row({activity: {state: 'thinking', since: now - 6000}, writing: true}), /^── ▖ writing 6s ─+ qwen3 ──$/, 'writing, once the words arrive');
  assert.match(row({activity: {state: 'tool', tool: 'run', what: 'go test ./...', since: now - 3000}}), /^── ▖ running go test \.\/\.\.\. 3s ─/);
  assert.match(row({activity: {state: 'remark', what: 'edit_while_red', since: now - 4000}}), /^── ▖ looking at edit while red 4s ─/);
  assert.match(row({activity: {state: 'thinking', since: now - 2900}}), /^── ▖ thinking ─+ qwen3 ──$/, 'no counter for the first 3s: a short turn does not tick');
  assert.match(row({activity: {state: 'thinking', since: now - 3000}}), /^── ▖ thinking 3s ─/);
  assert.match(row({activity: {state: 'waiting'}}), /^── \? waiting for your answer ─+ qwen3 ──$/);
  assert.match(row({connection: 'away'}), /^── ! the pair daemon went away · reconnecting ─+$/);
  assert.match(row({activity: {state: 'idle'}, scrolled: 12}), /─ ↓ 12 lines below ──$/);
  assert.match(row({activity: {state: 'idle'}, role: 'driver'}), /^── ◆ Pair drives · any key in Neovim takes it back ─/);
  assert.match(row({activity: {state: 'idle'}, role: 'driver'}, 30), /^── ◆ Pair drives ─+$/);
  assert.equal(textWidth(row(idle, 33)), 33);
  for (const view of [idle, {activity: {state: 'thinking', since: at}}, {activity: {state: 'waiting'}}, {activity: {state: 'idle'}, scrolled: 3}]) {
    assert.doesNotMatch(row(view, 120), /Esc|End|\by\b allow|decline/, 'the status names no keys');
  }
});

test('the header is in the top rule; the goal is cut first, then left out (always under 52 columns), then the role is shortened, then the level gives way', () => {
  const header = {project: 'hookd', goal: 'make the queue lease outlive the last retry', role: 'navigator', level: 'normal'};
  const line = width => plain([headerLine(header, width)])[0];
  assert.equal(line(86), '── pair · hookd · make the queue lease outlive the last retry ── navigator · normal ──');
  assert.equal(line(60), '── pair · hookd · make the queue l… ── navigator · normal ──');
  assert.equal(plain([headerLine({...header, muted: ['drift', 'tests']}, 60)])[0], '── pair · hookd ──────────── navigator · normal · 2 muted ──', 'the goal left out before the right side gives way');
  assert.equal(line(44), '── pair · hookd ──────────── nav · normal ──');
  assert.equal(line(30), '── pair · hookd ─────── nav ──');
  assert.equal(plain([headerLine({}, 20)])[0], '── pair ────────────');
});

test('colour: yellow only for the Watcher and a waiting ?; dim never for words addressed to you', () => {
  const styles = line => line.filter(s => s.text.trim()).map(s => `${s.text.trim()}:${s.style}`);
  const confirm = {kind: 'confirm', at, text: 'May I run `go test ./internal/queue -run TestLease` in my pane (go test runs code)?'};
  assert.deepEqual(plain(bodyLines(confirm, 60)), ['May I run this in my pane (go test runs code)?', '│ go test ./internal/queue -run TestLease']);
  assert.ok(bodyLines(confirm, 60)[0].every(s => s.style === 'text'), 'the question in body text');
  assert.deepEqual([...new Set(styles(bodyLines(confirm, 60)[1]).map(s => s.split(':').at(-1)))], ['rule', 'text'], 'the command in body text, behind a bar');
  assert.deepEqual(plain(bodyLines({...confirm, answer: false}, 60)).at(-1), 'you declined');
  const ticks = 'ls `pwd`/build && rm -rf out';
  assert.deepEqual(plain(bodyLines({kind: 'confirm', at, text: `May I run \`${ticks}\` in my pane (it runs a command substitution)?`, command: ticks}, 60)),
    ['May I run this in my pane (it runs a command substitution)?', `│ ${ticks}`], 'a command with backticks of its own shows whole');
  assert.deepEqual(plain(bodyLines(confirm, 30)).slice(-2), ['│ go test ./internal/queue', '│   -run TestLease'], 'a long command wraps at its spaces, behind the bar, with a hanging indent');
  assert.equal(bodyLines({...confirm, answer: false}, 60).at(-1)[0].style, 'text');
  const gutter = plain(transcriptLines([confirm], 60).lines)[0];
  assert.match(gutter, /── 14:05 ──/);
  assert.match(plain(transcriptLines([confirm], 60).lines)[1], /^ pair  May I run this/, 'Pair asks it, as pair');
  assert.equal(transcriptLines([confirm], 60).lines[1][1].style, 'pair');
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
  assert.equal(keys({mode: 'search'}), '↑↓ Enter Esc');
  assert.equal(footerKeys({mode: 'menu', menu: {kind: 'command'}})[2][1], 'run');
  assert.equal(footerKeys({mode: 'menu', menu: {kind: 'file'}})[2][1], 'inserts', 'Enter puts a file in what you type: it runs nothing');
  assert.equal(keys({connection: 'away'}), 'Ctrl-D ?', 'away: nothing sends, so no keys that send');
  assert.equal(keys({connection: 'away', editorEmpty: false}), 'Alt-Enter Tab');
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
    '                        ── 14:05 ──',
    ' you   why?',
    '',
    ' pair  Because.',
    '── ◉ watching ───────────────────────────────────── qwen3 ──',
    '› hello',
    ' Enter send · Alt-Enter newline · Tab complete',
  ]);
  assert.equal(lines[0], '── pair · hookd ──────────── navigator · normal · 1 muted ──', 'the goal gives way first');
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
  // The column, then a space, then the words; a name too long for the column alone, its words under it.
  for (const [i, line] of lines.entries()) {
    const alone = line.length >= 15 && /^ {2}\S+( \S+)?$/.test(line) && /^ {15}\S/.test(lines[i + 1] ?? '');
    if (!alone) assert.match(line, /^.{14} \S/, line);
  }
  assert.ok(lines.some((line, i) => line === '  /gen scaffold' && /^ {15}many files and their wiring/.test(lines[i + 1])));
  assert.ok(lines.some(line => /^ {2}\/drive +hand Pair the wheel/.test(line)));
  assert.ok(lines.some(line => /^ {2}\/goal <text> +set the session goal/.test(line)));
});

test('Markdown inline: _italic_ and *italic*, [links](url) as words and address; snake_case and 2*3*4 stay as written', () => {
  const styled = text => markdownLines(text, 80)[0].filter(seg => seg.text.trim()).map(seg => [seg.text, seg.style]);
  assert.deepEqual(styled('an _ital_ and *also* word').map(([text, style]) => `${text}:${style}`), ['an:text', 'ital:italic', 'and:text', 'also:italic', 'word:text']);
  assert.deepEqual(styled('see [the docs](http://x.y/z) now').map(([text, style]) => `${text}:${style}`), ['see:text', 'the:under', 'docs:under', '(http://x.y/z):dim', 'now:text']);
  assert.deepEqual(plain(markdownLines('a trigger_kind and 2*3*4', 80)), ['a trigger_kind and 2*3*4']);
});

test('code and diffs wrap between tokens with a hanging indent, never inside a name or a flag', () => {
  assert.equal(breakText('cfg.AttemptTimeout}', 8), 'cfg', 'before the dot, not inside the name');
  assert.equal(breakText('&Lease{ttl:', 9), '&Lease{', 'after an opening sign; the colon stays with its name');
  assert.equal(breakText('-count=1', 4), '-cou', 'a flag longer than the line is cut where it must be');
  assert.equal(breakText('./internal/queue/lease.go', 20), './internal/queue/');
  const diff = plain(diffLines({old: ['\treturn &Lease{ttl: cfg.Budget}'], new: ['\treturn &Lease{ttl: cfg.Budget + cfg.AttemptTimeout}']}, 37));
  assert.deepEqual(diff, ['│ - return &Lease{ttl: cfg.Budget}', '│ + return &Lease{ttl: cfg.Budget +', '│     cfg.AttemptTimeout}']);
  const code = plain(markdownLines('```\nfoo(alpha, beta, gamma) && go test ./internal/queue -run TestLease -count=1\n```', 30));
  assert.deepEqual(code, ['│ foo(alpha, beta, gamma) &&', '│   go test ./internal/queue', '│   -run TestLease -count=1']);
  assert.deepEqual(plain(codeLines('    if (x) {', 40, 'text')), ['    if (x) {'], 'its own indent kept');
  assert.deepEqual(plain(codeLines('    callSomething(withAVeryLongArgumentName)', 24, 'text')), ['    callSomething(', '      withAVeryLongArgum', '      entName)'], 'the indent of the line and two more');
});

test('code wrapping keeps a flag with its =, kebab-case names, numbers and versions whole; a deep indent keeps half the line', () => {
  const wrap = (text, width) => plain(codeLines(text, width, 'text', [{text: '│ ', style: 'rule'}]));
  assert.deepEqual(wrap('--config=webpack.production.config.js', 30), ['│ --config=webpack.production', '│   .config.js']);
  assert.deepEqual(wrap('go build --ldflags=-X=main.version=v1.2.3-rc.1 ./cmd', 30), ['│ go build', '│   --ldflags=-X=main.version=', '│   v1.2.3-rc.1 ./cmd']);
  assert.deepEqual(wrap('<my-very-long-component-name-here-and-more />', 30), ['│ <my-very-long-component-', '│   name-here-and-more />'], 'a name longer than the line breaks after a dash');
  assert.deepEqual(wrap('const pi = 3.14159; next', 20), ['│ const pi =', '│   3.14159; next']);
  assert.equal(breakText('-count=1 more', 7), '-count', 'not between a flag and its =');
  const deep = wrap(`${' '.repeat(24)}return someFunction(argumentOne, argumentTwo)`, 30);
  assert.deepEqual(deep, ['│              return', '│              someFunction(', '│              argumentOne,', '│              argumentTwo)']);
  assert.deepEqual(wrap(`${' '.repeat(12)}if (x) { callSomething(withAnArgument) }`, 30)[1], '│              callSomething(', 'the hanging indent kept');
  for (const line of [...deep, ...wrap('--config=webpack.production.config.js', 30)]) assert.ok(textWidth(line) <= 30);
});

test('a code span wraps with the word before it, at its own spaces', () => {
  const lines = plain(wrapTokens(inlineTokens('Run `go test ./internal/queue -run TestLease -count=1` in my pane?'), 37));
  assert.deepEqual(lines, ['Run go test ./internal/queue -run', 'TestLease -count=1 in my pane?']);
  assert.ok(wrapTokens(inlineTokens('a `b c`'), 30)[0].filter(s => s.text.trim()).slice(1).every(s => s.style === 'code'));
});

test('a narrow pane: tool traces by their base names and a count, the remark\'s file by its name, the status shorter but whole', () => {
  assert.equal(baseNames('read internal/queue/lease.go 1-40'), 'read lease.go 1-40');
  assert.equal(baseNames('go test ./...'), 'go test ./...', 'nothing to shorten');
  assert.equal(baseNames('go test ./internal/queue -run TestLease'), 'go test ./internal/queue -run TestLease', 'a command stays one you could run');
  const tools = {kind: 'tool', at, tools: [{tool: 'read', what: 'internal/queue/lease.go 1-40'}, {tool: 'search', what: 'AttemptTimeout'}]};
  assert.deepEqual(plain(bodyLines(tools, 80)), ['└ read internal/queue/lease.go 1-40 · searched AttemptTimeout'], 'whole where it fits');
  assert.deepEqual(plain(bodyLines(tools, 48)), ['└ read lease.go 1-40 · searched AttemptTimeout']);
  assert.deepEqual(plain(bodyLines(tools, 37)), ['└ read lease.go 1-40 · +1']);
  const remark = {kind: 'watch', at, text: 'The lease ends early.', meta: {remark: 1, trigger: 'regression', place: {file: 'internal/queue/lease.go', line: 18}}};
  assert.equal(plain(bodyLines(remark, 37))[0], 'regression · lease.go:18');
  assert.equal(plain(bodyLines(remark, 60))[0], 'regression · internal/queue/lease.go:18');
  const now = at + 180_000;
  const row = (view, width) => plain([statusLine({now, model: 'qwen3-coder-30b', ...view}, width)])[0];
  const idle = {activity: {state: 'idle'}, presence: {looked: 7, spoke: 1, lastAt: at}};
  assert.equal(row(idle, 44), '── ◉ watching · 3m ago ─────────────────────', 'the model gives way, then the counts; the time stays');
  assert.equal(row(idle, 20), '── ◉ watching ──────');
  assert.match(row({activity: {state: 'waiting'}}, 26), /^── \? waiting ─+$/);
  assert.match(row({activity: {state: 'tool', tool: 'read', what: 'internal/queue/lease.go 1-40', since: now - 4000}}, 36), /^── ▖ reading lease\.go 1-40 4s ─+$/);
  assert.match(row({activity: {state: 'tool', tool: 'read', what: 'internal/queue/lease.go 1-40', since: now - 4000}}, 24), /^── ▖ reading 4s ─+$/);
  assert.match(row({connection: 'away'}, 30), /^── ! reconnecting ─+$/);
  assert.match(row({activity: {state: 'tool', tool: 'run', what: 'go test ./internal/queue -run TestLease', since: now - 4000}}, 52), /^── ▖ running 4s ─+/, 'a command too long: none, not a rewritten one');
  assert.match(row({activity: {state: 'idle'}, role: 'scout'}, 24), /^── ◉ Scout ─+$/);
  for (const width of [24, 30, 36, 44]) {
    for (const view of [idle, {activity: {state: 'waiting'}}, {connection: 'away'}, {connection: 'connecting'}, {activity: {state: 'remark', what: 'edit_while_red', since: now}}, {activity: {state: 'idle'}, role: 'scout'}]) {
      assert.doesNotMatch(row(view, width), /[^\s─]…/, `${JSON.stringify(view)} at ${width}: shorter, not cut`);
    }
  }
});

test('the @file menu: a path too long loses its start, a folder at a time, never its end', () => {
  assert.equal(cutStart('@internal/retry/backoff_test.go', 20), '@…/backoff_test.go');
  assert.equal(cutStart('@internal/retry/backoff.go', 20), '@…/retry/backoff.go');
  assert.equal(cutStart('@a_really_long_file_name.go', 12), '@…le_name.go');
  const items = ['@internal/retry/backoff.go', '@internal/retry/backoff_test.go'].map(label => ({label, value: label}));
  const lines = plain(menuLines(items, 0, 24, {kind: 'file'}));
  assert.deepEqual(lines.map(line => line.trimEnd()), [' ▸ @…/retry/backoff.go', '   @…/backoff_test.go'], 'two files, told apart');
  assert.deepEqual(plain(menuLines(items, 0, 44, {kind: 'file'})).map(line => line.trimEnd()), [' ▸ @internal/retry/backoff.go', '   @internal/retry/backoff_test.go'], 'no detail: the label may take the width');
});

test('a wide pane: the words end by column 80, code and diffs use the width, and the turn\'s meta sits right of its answer', () => {
  const text = `${'word '.repeat(40).trim()}\n\n\`\`\`\n${'x'.repeat(100)}\n\`\`\``;
  const answer = {kind: 'pair', at, text, turn: {ms: 6400, tokens: 3400}};
  const lines = plain(transcriptLines([answer], 124).lines).slice(1);
  assert.equal(lines[0], ` pair  ${'word '.repeat(14).trim()}${' '.repeat(124 - 7 - 69 - 23)}14:05 · 6.4s · 3.4k tok`);
  assert.ok(lines.filter(line => !line.includes('│')).every(line => line.replace(/ +14:05.*$/, '').length <= 80), 'words by column 80');
  assert.ok(lines.some(line => line === ` ${' '.repeat(6)}│ ${'x'.repeat(100)}`), 'the code block runs on');
  assert.equal(transcriptLines([answer], 124).lines[1].at(-1).style, 'dim');
  assert.doesNotMatch(plain(transcriptLines([answer], 80).lines).join('\n'), /6\.4s/, 'no margin in an 80-column pane');
  assert.match(plain(transcriptLines([answer], 100).lines)[1], /word {2,}14:05 · 6\.4s$/, 'less room: the tokens go first');
});

test('a remark is one unit: its last line has the keys that work on it once picked, spaced like buttons, Alt-↑ as an aside', () => {
  const suggestion = {action: 4, old: ['return &Lease{ttl: cfg.Budget}'], new: ['return &Lease{ttl: cfg.Budget + cfg.AttemptTimeout}']};
  const remark = {kind: 'watch', at, text: 'internal/queue/lease.go:18 suggestion: the lease ends before the last attempt does', meta: {remark: 7, trigger: 'regression', place: {file: 'internal/queue/lease.go', line: 18}, suggestion}};
  const lines = plain(transcriptLines([remark], 80, {latestRemark: 0}).lines);
  assert.deepEqual(lines.slice(1).map(line => line.trimEnd()), [
    ' watch regression · internal/queue/lease.go:18',
    '       the lease ends before the last attempt does',
    '       │ - return &Lease{ttl: cfg.Budget}',
    '       │ + return &Lease{ttl: cfg.Budget + cfg.AttemptTimeout}',
    '       + useful  - noise  a apply  j jump  · Alt-↑ first',
  ], 'the diff has the code block\'s bar and space');
  const action = transcriptLines([remark], 80, {latestRemark: 0}).lines.at(-1);
  assert.deepEqual(action.filter(s => s.style === 'bold').map(s => s.text), ['+', '-', 'a', 'j', 'Alt-↑'], 'the keys bold');
  assert.ok(action.filter(s => /useful|noise|apply|jump|first/.test(s.text)).every(s => s.style === 'dim'), 'their words dim');
  assert.match(plain(transcriptLines([{...remark, applied: true}], 80, {latestRemark: 0}).lines).at(-1), /^ {7}\+ useful {2}- noise {2}j jump {2}· Alt-↑ first$/, 'taken: no a');
  assert.equal(plain(transcriptLines([remark], 80, {latestRemark: 0, selected: 0}).lines).at(-1).trimEnd(), '▌      + useful  - noise  a apply  j jump', 'picked: the keys work now, no aside');
  assert.equal(plain(transcriptLines([remark], 54, {latestRemark: 0}).lines).at(-1), '       + useful - noise a apply j jump  · Alt-↑ first', 'narrower: the gaps first');
  assert.equal(plain(transcriptLines([remark], 44, {latestRemark: 0}).lines).at(-1), '       + - a j  · Alt-↑ first', 'a narrow pane: the keys without words, the aside kept');
  const pieces = [{...remark, text: 'the lease ends early', meta: {...remark.meta, suggestion: undefined}}, {kind: 'watch', at, text: 'see the retry', meta: {remark: 7, trigger: 'regression'}}];
  assert.deepEqual(Object.keys(remarkKeys(pieces, 1)).filter(key => remarkKeys(pieces, 1)[key]), ['jump'], 'the keys of the whole remark, from its last part');
});

test('the speakers: ! for an error, not !!, and its text is Markdown, so a command in it is a code span, whole', () => {
  const error = {kind: 'error', at, text: 'Pair could not answer: connect ECONNREFUSED 127.0.0.1:8080. `pair doctor` checks the models.'};
  const lines = transcriptLines([error], 60).lines;
  assert.deepEqual(plain(lines).slice(1), [
    ' !     Pair could not answer: connect ECONNREFUSED',
    '       127.0.0.1:8080. pair doctor checks the models.',
  ]);
  assert.deepEqual(lines[1][1], {text: '!', style: 'errorBold'});
  const code = lines[2].filter(s => s.style === 'code').map(s => s.text);
  assert.deepEqual(code, ['pair', 'doctor'], 'the command in the accent, no backticks');
  assert.ok(lines[1].slice(3).every(s => s.style === 'error'), 'the words in red');
});

test('ordered lists: the numbers are padded to the widest of their list, so 9. and 10. end in one column', () => {
  const text = Array.from({length: 10}, (_, i) => `${i + 1}. step ${i + 1}`).join('\n');
  const lines = plain(markdownLines(text, 40));
  assert.equal(lines[0], ' 1. step 1');
  assert.equal(lines[8], ' 9. step 9');
  assert.equal(lines[9], '10. step 10');
  assert.deepEqual(plain(markdownLines('1. one\n2. two\n\nWords.\n\n9. nine\n10. ten', 40)), ['1. one', '2. two', '', 'Words.', '', ' 9. nine', '10. ten'], 'each list its own width');
  assert.deepEqual(plain(markdownLines('8. a long item that wraps here\n9. b\n10. c', 20)).slice(0, 2), [' 8. a long item that', '    wraps here'], 'the hanging indent follows the padding');
});

test('find: a match of several words, or over a `code` span, is one match; one over a wrap still finds its message', () => {
  const answer = {kind: 'pair', at, text: 'The lease ends too early: ttl is only the budget. Run `pair doctor` now.'};
  const count = query => transcriptLines([answer], 80, {query}).ranges[0].matches;
  for (const query of ['lease', 'the lease', 'lease ends', 'too early', 'run pair', 'pair doctor now', 'THE LEASE']) assert.equal(count(query), 1, query);
  assert.equal(count('the'), 2);
  assert.equal(count('nowhere'), 0);
  const {lines} = transcriptLines([answer], 80, {query: 'run pair', selected: 0, found: 0});
  assert.deepEqual(lines[1].filter(s => s.style === 'found').map(s => s.text), ['Run', ' ', 'pair'], 'lit over the word and the span');
  const wrapped = transcriptLines([answer], 30, {query: 'only the budget'});
  assert.equal(wrapped.ranges[0].matches, 1, 'over a wrap: the message is found');
});

test('find: every match underlined, the one you are on bold, underlined and green; a fold opens to show it', () => {
  const entries = [{kind: 'pair', at, text: 'the lease ends; the lease again'}, {kind: 'you', at, text: 'lease?'}];
  const {lines, ranges} = transcriptLines(entries, 60, {query: 'lease', selected: 0, found: 1});
  assert.deepEqual(ranges.map(range => range.matches), [2, 1]);
  const styles = lines.flat().filter(s => s.text.toLowerCase() === 'lease').map(s => s.style);
  assert.deepEqual(styles, ['match', 'found', 'match'], 'the second match of the first message is the one you are on');
  const painted = paintLine(lines[1], {color: true});
  assert.ok(painted.includes('\x1b[4m\x1b[1m\x1b[32mlease'), 'bold, underlined, green');
  assert.ok(painted.includes('\x1b[4mlease'), 'the others underlined only');
  assert.ok(!painted.includes('\x1b[7m'), 'no reverse video');
  const long = {kind: 'pair', at, text: [...Array.from({length: 20}, (_, i) => `line ${i}`), 'the lease at the end'].join('\n')};
  const shut = transcriptLines([long], 60, {query: 'lease', selected: 0, found: -1});
  assert.equal(shut.ranges[0].folded, true);
  assert.equal(shut.ranges[0].matches, 1, 'a folded match counts');
  const open = transcriptLines([long], 60, {query: 'lease', selected: 0, found: 0});
  assert.equal(open.ranges[0].folded, false, 'on it, the message opens');
  assert.match(plain([open.lines[open.ranges[0].found]])[0], /the lease at the end/, 'and the pane knows its line');
});

test('the find row stands where you type: what it looks for, which match of how many, and in how many messages', () => {
  const editor = new LineEditor();
  editor.insert('a half-typed question');
  const view = {
    entries: [{kind: 'pair', at, text: 'the lease ends'}], editor, selected: 0, found: 0, activity: {state: 'idle'},
    mode: 'search', search: 'lease', searchNote: '1 of 1 · in 1 message',
  };
  const {lines, cursor} = renderFrame(view, {width: 60, height: 10});
  assert.equal(lines.at(-2), ' find: lease  1 of 1 · in 1 message');
  assert.equal(lines.at(-1).trimEnd(), ' ↑↓ older/newer · Enter keep · Esc close');
  assert.ok(!lines.join('\n').includes('half-typed'), 'what you typed waits behind it');
  assert.deepEqual(cursor, {row: 8, column: 12});
});

test('the command menu: name, arguments and what it does in three columns; how many it shows, and how many more', () => {
  const items = COMMANDS.map(([name, args, what]) => ({label: name, args, detail: what, value: name}));
  const lines = plain(menuLines(items, 0, 80));
  assert.equal(lines.length, 8, 'seven, and the line of how many more');
  const column = lines[0].indexOf('<text>');
  assert.match(lines[0], /^ ▸ \/goal +<text> +set the session goal/);
  assert.equal(lines[1].indexOf('quiet|normal|chatty'), column, 'the arguments in one column');
  assert.equal(lines[1].indexOf('how often'), lines[0].indexOf('set the session'), 'what it does in another');
  assert.equal(lines[2].indexOf('speak unasked'), lines[0].indexOf('set the session'), 'with or without arguments');
  assert.equal(lines[7], `   ↓ ${COMMANDS.length - 7} more`);
  const down = plain(menuLines(items, 9, 80));
  assert.match(down[6], /^ ▸ \/cancel/, 'the chosen one in sight, at the bottom');
  assert.equal(down[7], `   ↑ 3 more · ↓ ${COMMANDS.length - 10} more`);
  assert.equal(plain(menuLines(items, COMMANDS.length - 1, 80)).at(-1), `   ↑ ${COMMANDS.length - 7} more`);
  assert.equal(plain(menuLines(items.slice(0, 3), 0, 80)).length, 3, 'all of them: no more line');
  for (const line of plain(menuLines(items, 0, 44))) assert.ok(textWidth(line) <= 44, line);
  assert.match(plain(menuLines(items, 0, 44))[1], /^ {3}\/level +quiet\|norm\w*… {2}how often/, 'a narrow pane cuts the arguments, not the column');
  const frame = renderFrame({entries: [], editor: new LineEditor(), selected: -1, activity: {state: 'idle'}, mode: 'menu', menu: {kind: 'command', items, chosen: 0}}, {width: 80, height: 20});
  assert.match(frame.lines.find(line => line.startsWith('╶─')), new RegExp(`^╶─ commands · 7 of ${COMMANDS.length} · type to narrow ─+$`));
  assert.match(frame.lines.at(-1), /Enter run/);
  const files = renderFrame({entries: [], editor: new LineEditor(), selected: -1, activity: {state: 'idle'}, mode: 'menu', menu: {kind: 'file', items: [{label: '@a.go', value: '@a.go'}], chosen: 0}}, {width: 80, height: 20});
  assert.match(files.lines.find(line => line.startsWith('╶─')), /^╶─ files ─+$/);
  assert.match(files.lines.at(-1), /Enter inserts/);
});

test('the empty card: Pair\'s CRT head in four rows, however the words beside it wrap', () => {
  const head = ['      ▗▖', '   ▗▛▀▀▀▀▜▖', '   ▐ ▀  ▀ ▌', '   ▝▙▄▄▄▄▟▘'];
  for (const width of [24, 44, 49, 60, 80, 124, 200]) {
    const lines = plain(emptyLines(width));
    assert.deepEqual(lines.slice(0, 4).map(line => line.slice(0, 11).trimEnd()), head, `${width} columns`);
    assert.ok(lines.every(line => textWidth(line) <= width), `${width} columns: nothing wider than the pane`);
  }
  assert.deepEqual(plain(emptyLines(64)).slice(0, 4), [
    '      ▗▖',
    '   ▗▛▀▀▀▀▜▖  Pair · your pair in the second chair',
    '   ▐ ▀  ▀ ▌  It watches you work and speaks rarely: a line in',
    '   ▝▙▄▄▄▄▟▘  Neovim, more here when you ask.',
  ]);
  assert.equal(plain(emptyLines(200))[3], '   ▝▙▄▄▄▄▟▘  when you ask.', 'the words end by column 80, so the chin keeps its words');
  assert.deepEqual(plain(emptyLines(44)).slice(3, 6), ['   ▝▙▄▄▄▄▟▘', '   Pair · your pair in the second chair', '   It watches you work and speaks rarely: a'], 'too narrow for the title beside the head: the words go under it');
  // The head's colours: the frame in the accent, the eyes green, the antenna magenta.
  const styles = emptyLines(64).slice(0, 4).flatMap(line => line.filter(s => /[▗▖▛▀▜▐▌▝▙▄▟▘]/.test(s.text)).map(s => `${s.text}:${s.style}`));
  assert.deepEqual(styles, ['▗▖:antenna', '▗▛▀▀▀▀▜▖:accent', '▐:accent', '▀:eyes', '▀:eyes', '▌:accent', '▝▙▄▄▄▄▟▘:accent']);
  const painted = paintLine(emptyLines(64)[2], {color: true});
  assert.match(painted, /\x1b\[32m\x1b\[1m▀/, 'the eyes green');
  assert.match(paintLine(emptyLines(64)[0], {color: true}), /\x1b\[35m▗▖/, 'the antenna magenta');
  assert.deepEqual(plain(emptyLines(64)).slice(5), [
    '   Enter   ask anything',
    '   /       commands · /drive hands it the keyboard',
    '   @       a file, or @here for your selection',
    '   Alt-↑   pick a message: copy, apply, jump, rate',
    '   ?       every key',
  ]);
  assert.deepEqual(emptyLines(64)[6].filter(s => s.style === 'accent' && s.text.trim()).map(s => s.text), ['/drive'], 'a command in the accent');
});

test('one colour per role, from the site: the role in the header, the glyph in the status', () => {
  const header = {project: 'hookd', level: 'normal'};
  const role = (r, extra = {}) => headerLine({...header, role: r, ...extra}, 64).find(s => s.text === r || s.text === 'nav');
  assert.equal(role('navigator').style, 'navigator');
  assert.equal(role('scout').style, 'scout');
  assert.equal(role('driver').style, 'driver');
  assert.deepEqual(STYLES.navigator, ['blue', 'bold']);
  assert.deepEqual(STYLES.scout, ['green', 'bold']);
  assert.deepEqual(STYLES.driver, ['red', 'bold']);
  assert.deepEqual(STYLES.watcher, ['yellow']);
  assert.match(plain([headerLine({...header, role: 'driver', keep: true}, 64)])[0], /^── pair · hookd ─+ driver · keeps the wheel ──$/, 'the Driver that keeps the wheel says so');
  assert.match(plain([headerLine({...header, role: 'navigator'}, 64)])[0], /^── pair · hookd ─+ navigator · normal ──$/);
  assert.match(paintLine(headerLine({...header, role: 'scout'}, 64), {color: true}), /\x1b\[32m\x1b\[1mscout\x1b\[0m/);
  const glyph = view => statusLine({activity: {state: 'idle'}, ...view}, 64).find(s => /[◉◆▖]/.test(s.text));
  assert.deepEqual([glyph({}).text, glyph({}).style], ['◉ ', 'watcher'], 'the Watcher\'s ◉ in yellow');
  assert.deepEqual([glyph({role: 'scout'}).text, glyph({role: 'scout'}).style], ['◉ ', 'watcher']);
  assert.deepEqual([glyph({role: 'driver'}).text, glyph({role: 'driver'}).style], ['◆ ', 'driverGlyph'], 'the Driver\'s ◆ in red');
  const thinking = statusLine({activity: {state: 'thinking'}}, 64);
  assert.deepEqual(thinking.filter(s => s.text.trim() && s.style !== 'rule').map(s => s.style), ['accent', 'accentBold'], 'Pair at work: its own accent');
});

test('calm motion: what waits under the answer that streams, safe glyphs', () => {
  assert.equal(heldText({remarks: 1}), '1 remark below');
  assert.equal(heldText({notes: 2}), '2 notes below');
  assert.equal(heldText({remarks: 1, notes: 1}), '1 remark and 1 note below');
  assert.equal(heldText(null), '');
  const now = at + 10_000;
  const row = (view, width) => plain([statusLine({now, model: 'qwen3', activity: {state: 'thinking', since: at}, writing: true, ...view}, width)])[0];
  assert.match(row({held: {remarks: 1}}, 64), /^── ▖ writing 10s · 1 remark below ─+ qwen3 ──$/);
  assert.match(row({held: {remarks: 1}}, 40), /^── ▖ writing 10s · 1 remark below ─+$/, 'the model gives way first');
  assert.match(row({held: {remarks: 1}}, 32), /^── ▖ writing · 1 remark below ─+$/, 'narrower: the seconds give way before what waits');
  assert.match(row({held: {remarks: 2, notes: 1}}, 44), /^── ▖ writing · 2 remarks and 1 note below ─+$/);
  assert.match(row({held: {remarks: 1}}, 24), /^── ▖ writing 10s ─+$/, 'too narrow for it: the status as without');
  // Glyphs every font has, one column wide: no ⚠, no ⎿.
  const away = statusLine({now, connection: 'away', away: {since: at}}, 64);
  assert.deepEqual(away.filter(s => s.style === 'warn').map(s => s.text), ['! '], 'away: a yellow !');
  assert.match(paintLine(away, {color: true}), /\x1b\[33m! /);
  const down = plain([statusLine({now, model: 'qwen3', down: ['watcher'], activity: {state: 'idle'}}, 64)])[0];
  assert.match(down, /─ ! watcher not answering ──$/, 'a model that does not answer: ! too');
  assert.match(plain([statusLine({now, model: 'qwen3', down: ['watcher'], activity: {state: 'idle'}}, 30)])[0], /^── ◉ watching ─+$/, 'whole or not at all');
  const tools = {kind: 'tool', at, tools: [{tool: 'read', what: 'a.go 1-4'}]};
  assert.deepEqual(plain(bodyLines(tools, 40)), ['└ read a.go 1-4']);
  const frames = [
    renderFrame({entries: [tools], editor: new LineEditor(), activity: {state: 'idle'}, connection: 'away', away: {since: at}, now}, {width: 60, height: 10}),
    renderFrame({entries: [], showEmpty: true, editor: new LineEditor(), activity: {state: 'idle'}}, {width: 60, height: 24}),
  ];
  for (const frame of frames) assert.doesNotMatch(frame.lines.join('\n'), /[⚠⎿]/);
});

test('code bars: a diff and a code block indent alike; ordered lists end their numbers in one column', () => {
  const block = markdownLines('```go\nttl := cfg.Budget\n```', 40);
  const fenced = markdownLines('```diff\n- return ttl\n+ return ttl + grace\n```', 40);
  const suggestion = diffLines({old: ['return ttl'], new: ['return ttl + grace']}, 40);
  assert.deepEqual(plain(block), ['│ ttl := cfg.Budget']);
  assert.deepEqual(plain(fenced), ['│ - return ttl', '│ + return ttl + grace']);
  assert.deepEqual(plain(suggestion), ['│ - return ttl', '│ + return ttl + grace'], 'the bar, a space, then the sign: as in a code block');
  const list = plain(markdownLines(Array.from({length: 10}, (_, i) => `${i + 1}. step ${i + 1} of the retry that goes on`).join('\n'), 24));
  assert.equal(list[0], ' 1. step 1 of the retry');
  assert.equal(list[1], '    that goes on');
  assert.equal(list.at(-2), '10. step 10 of the retry');
  assert.equal(list.at(-1), '    that goes on', 'the hanging indent the same past 9');
});

test('reconnecting: how long the daemon has been away, how many times the pane tried, and that what you type is kept', () => {
  const now = at + 6000;
  const row = width => plain([statusLine({now, connection: 'away', away: {since: at, attempts: 3}}, width)])[0];
  assert.match(row(80), /^── ! the pair daemon went away · reconnecting 6s · attempt 3 ─+$/);
  assert.match(row(40), /^── ! reconnecting 6s · attempt 3 ─+$/);
  assert.match(row(28), /^── ! reconnecting 6s ─+$/);
  assert.match(plain([statusLine({now, connection: 'away', away: {since: at, attempts: 0}}, 80)])[0], /reconnecting 6s ─/, 'no attempt yet: no count');
});

test('a gen card: the gen speaker in magenta, its words without "gen", the code at the cursor as a diff, its keys as an action line', () => {
  const card = {type: 'gen_card', gen: 7, action: 31, shape: 'scaffold', state: 'ready', of: 9, taken: 0, left: 9, keys: {k: 'keep one', enter: 'open the list', d: 'drop all', u: 'undo'}};
  const text = '#7 · scaffold · 9 files, 3 of yours changed · 2m 41s\nin Pair\'s copy gen/shop/7 · check ✓ `go test ./...`: 47 pass\n│ + internal/admin/orders.go  +118\n│ ~ cmd/shop/main.go          +3 -1';
  const entry = {kind: 'gen', at, text, meta: {gen: 7, hint: 'In Neovim, :Pair gen list keeps them one at a time (k).'}, card};
  const you = {kind: 'you', at, text: '/gen scaffold an admin page for orders'};
  const {lines} = transcriptLines([you, entry], 80, {latestCard: 1});
  assert.deepEqual(plain(lines).slice(1), [
    ' you   /gen scaffold an admin page for orders',
    '',
    ' gen   #7 · scaffold · 9 files, 3 of yours changed · 2m 41s',
    '       in Pair\'s copy gen/shop/7 · check ✓ go test ./...: 47 pass',
    '       │ + internal/admin/orders.go  +118',
    '       │ ~ cmd/shop/main.go          +3 -1',
    '       ',
    '       k keep one   Enter open the list   d drop all   u undo   · Alt-↑ picks',
  ], 'the keys replace the hint of how to take it');
  const gutter = lines[3].find(seg => seg.text === 'gen');
  assert.equal(gutter.style, 'gen');
  assert.deepEqual(STYLES.gen, ['magenta', 'bold'], 'magenta, as the role colours have it');
  // Picked, the aside goes; narrower, the gaps narrow, then the words go.
  assert.match(plain(transcriptLines([entry], 80, {latestCard: 0, selected: 0}).lines).at(-1), /u undo$/);
  assert.equal(plain(transcriptLines([entry], 74, {latestCard: 0}).lines).at(-1), '       k keep one  Enter open the list  d drop all  u undo   · Alt-↑ picks');
  assert.equal(plain(transcriptLines([entry], 71, {latestCard: 0}).lines).at(-1), '       k keep one Enter open the list d drop all u undo   · Alt-↑ picks');
  assert.equal(plain(transcriptLines([entry], 44, {latestCard: 0}).lines).at(-1), '       k Enter d u   · Alt-↑ picks');
  assert.equal(plain(transcriptLines([entry], 32, {latestCard: 0}).lines).at(-1), '       k Enter d u', 'narrower still, the aside goes whole, never cut');
  // Not the live card, or nothing left to do on it: no action line; with no keys at all, the hint says how to take it.
  assert.doesNotMatch(plain(transcriptLines([entry], 80).lines).join('\n'), /Alt-↑ picks/);
  const old = plain(transcriptLines([{...entry, card: {...card, keys: {}}}], 80, {latestCard: 0}).lines);
  assert.equal(old.at(-1), '       In Neovim, :Pair gen list keeps them one at a time (k).');
  // A /gen question is the gen speaker's too, and a new request is a new turn.
  const asks = {kind: 'confirm', at, gen: 8, text: '#8 · new files: "migration". Shape?', hint: 'y: file · here, scaffold, try · n cancels', confirm: 3};
  const both = plain(transcriptLines([entry, asks], 80).lines);
  assert.ok(both.includes(' gen   #8 · new files: "migration". Shape?'), both.join('\n'));
  // A long card does not fold: Enter on it opens it in Neovim.
  const long = {...entry, text: Array.from({length: 30}, (_, i) => `line ${i}`).join('\n')};
  assert.doesNotMatch(plain(transcriptLines([long], 80).lines).join('\n'), /more lines/);
});

test('a gen card for code at the cursor: its words, then the diff; ✓ taken once taken', () => {
  const entry = {kind: 'gen', at, text: '#2 · here · 3 lines at math.js:1: A sum.\n≠ brief "BigInt only" NOTES.md:4 · math.js:1 plain numbers', meta: {gen: 2, place: {file: 'math.js', line: 1}, suggestion: {action: 5, old: [], new: ['function sum(a, b) {', '  return a + b', '}']}}};
  assert.deepEqual(plain(bodyLines(entry, 60)), [
    '#2 · here · 3 lines at math.js:1: A sum.',
    '≠ brief "BigInt only" NOTES.md:4 · math.js:1 plain numbers',
    '│ + function sum(a, b) {',
    '│ +   return a + b',
    '│ + }',
  ], 'every line of its words, not only the first');
  assert.equal(plain(bodyLines({...entry, applied: true}, 60)).at(-1), '✓ taken');
});

test('the status says what /gen does: a request at work in magenta, the one waiting its turn, a question, and what is left to take', () => {
  const now = at;
  const row = (view, width = 72) => plain([statusLine({now, model: 'qwen3', activity: {state: 'idle'}, presence: {looked: 31, spoke: 2}, ...view}, width)])[0];
  const genView = cards => ({gen: genStatus(cards)});
  const working = {gen: 4, shape: 'file', state: 'generating', since: now - 41_000, of: 0, taken: 0, left: 0, keys: {}};
  assert.match(row(genView([working])), /^── ▖ gen #4 generating 41s ─+ qwen3 ──$/);
  const spinner = statusLine({now, activity: {state: 'idle'}, ...genView([working])}, 72).find(seg => seg.text.startsWith('▖'));
  assert.equal(spinner.style, 'genGlyph');
  assert.match(row(genView([working, {...working, gen: 5, state: 'queued'}])), /^── ▖ gen #4 generating 41s · gen #5 waits ─/, 'the next one waits its turn (one at a time)');
  assert.match(row(genView([working, {...working, gen: 5, state: 'queued'}, {...working, gen: 6, state: 'queued'}])), /· 2 more wait/);
  assert.match(row(genView([{...working, state: 'asking'}])), /^── \? gen #4 asks in Neovim ─/, 'a question asked in Neovim is answered there');
  assert.match(row({...genView([{...working, state: 'asking'}]), activity: {state: 'waiting'}}), /^── \? gen #4 waits for your answer ─/, 'asked here');
  assert.match(row({...genView([working]), activity: {state: 'thinking', since: now}}), /^── ▖ thinking · gen #4 generating ─/, 'Pair answers you meanwhile, in its own conversation');
  // Done: what is left of the newest one, after the watching; it gives way first.
  const scaffold = {gen: 7, shape: 'scaffold', state: 'ready', of: 9, taken: 0, left: 9, keys: {k: 'keep one'}};
  assert.match(row(genView([scaffold])), /^── ◉ watching · gen #7: 0 of 9 kept ─/);
  assert.match(row(genView([{...scaffold, shape: 'file', of: 2, left: 2}])), /◉ watching · gen #7: 2 to review/);
  assert.match(row(genView([{...scaffold, shape: 'here', of: 1, left: 1}])), /◉ watching · gen #7: ready in Neovim/);
  assert.doesNotMatch(row(genView([{...scaffold, state: 'done'}])), /gen #7/, 'nothing left: nothing said');
  assert.match(row(genView([scaffold]), 36), /^── ◉ watching ─/, 'a narrow pane keeps the watching');
});

test('a picked gen card: the footer has its keys, in their short words when the long ones do not fit', () => {
  const card = {gen: 7, shape: 'scaffold', keys: {k: 'keep one', enter: 'open the list', d: 'drop all', u: 'undo'}};
  const keys = footerKeys({mode: 'select', selectedEntry: {kind: 'gen', card, meta: {gen: 7}}}).map(([key, what]) => `${key} ${what}`);
  assert.deepEqual(keys, ['c copy', 'k keep one', 'Enter open the list', 'd drop all', 'u undo', 'Esc back']);
  assert.match(plain([footerLine({mode: 'select', selectedEntry: {kind: 'gen', card, meta: {gen: 7}}}, 50)])[0], /k keep · Enter open · d drop · u undo/);
  // The command menu after /keep names what it keeps from.
  const menu = renderFrame({editor: Object.assign(new LineEditor(), {}), entries: [], header: {}, mode: 'menu', menu: {kind: 'keep', title: 'gen #7 · files to keep', chosen: 0, items: [{label: 'internal/admin/orders.go', value: '/keep internal/admin/orders.go'}]}}, {width: 60, height: 12});
  assert.match(menu.lines.join('\n'), /╶─ gen #7 · files to keep ─+\n ▸ internal\/admin\/orders\.go/);
  assert.match(menu.lines.join('\n'), /Enter keeps/);
});
