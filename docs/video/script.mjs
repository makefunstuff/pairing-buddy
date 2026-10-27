// The tutorial's script: every scene, what the voice says and when, and what the picture points at. build.mjs turns
// it into the composition, tts.mjs into the voice (audio/<line id>.mp3), words.mjs into the captions' timings.
//
// A scene of captures (`shots`) has a title card (`card`: the situation, what to watch, and which `area` of the screen
// map to light), its shots, and a sum (`sum`, one line the voice also says, unless `quietSum`). Its voice is `say`: lines with `at`, in
// seconds into the shots (or `card`/`sum` for the title card's and the sum's lines). `poster: n` makes the
// moment its nth spot shows the poster of the site's video. Times of the overlays are
// seconds into the shots, or `{line: n}`, when the voice starts its nth line.
// Boxes are [x, y, w, h] in a capture's pixels: the Neovim takes are 1920x1080 terminals at 9.6 x 21.33 pixels a
// cell, so G(col, row, cols, rows) gives a box of cells (from 0); T() the same for the setup takes (font 20).
// The clips are in clips/ (clips.sh copies them from the captures).

const G = (col, row, cols = 1, rows = 1) => [Math.round(col * 9.6), Math.round(row * 21.33), Math.round(cols * 9.6), Math.round(rows * 21.33)];
const T = (col, row, cols = 1, rows = 1) => [Math.round(14 + col * 12), Math.round(16 + row * 26.5), Math.round(cols * 12 + 8), Math.round(rows * 26.5 + 4)];

// The areas of the screen in the Neovim takes: the names they get on screen, their boxes, and where they sit on
// the little map of the title cards (in percent of the map).
export const AREAS = {
  nvim: {label: 'Neovim: your code', short: 'your code', box: G(0, 0, 135.5, 35.5), map: [2, 3, 64, 64]},
  term: {label: 'your terminal', short: 'your terminal', box: G(0, 35.6, 135.5, 12.4), map: [2, 70, 64, 21]},
  chat: {label: 'Pair’s chat', short: 'Pair’s chat', box: G(136, 0, 64, 48), map: [68, 3, 30, 88]},
  status: {label: 'the statusline', short: 'statusline', box: G(0, 48, 200, 1), map: [2, 93.5, 96, 4]},
  pair: {label: 'Pair, in the statusline', box: G(168, 48, 32, 1)},
};

export const CHAPTERS = {
  1: ['Setup and pair doctor', 'install, a model, a check'],
  2: ['The roles', 'who does what'],
  3: ['Exploring code', 'it watches, reads, and points'],
  4: ['Tests', 'it runs what you’d skip'],
  5: ['Notes and the blank page', 'thinking before the code'],
  6: ['The hand-over', 'Pair types one change while you watch'],
  7: ['Voice', 'ask out loud'],
  8: ['With or without herdr', 'where the panes live'],
};

export const CHEATS = [
  {keys: ['Alt', 'J'], what: 'go where Pair points'},
  {keys: ['Alt', 'Y'], what: 'take Pair’s suggested change'},
  {keys: ['Alt', '?'], what: 'the idea behind Pair’s words'},
  {keys: [':Pair drive …'], what: 'hand Pair one change'},
  {keys: ['u'], what: 'undo Pair’s change in one step'},
  {keys: ['any key'], what: 'while Pair types: take the wheel back'},
  {keys: ['Alt', 'T'], what: 'hold, ask aloud, let go'},
  {keys: ['pair doctor'], what: 'check every part of the setup'},
];

const at = (t, plus) => (plus ? {t, plus} : {t}); // a time in the take

const key = list => list.map(k => `<span class="key">${k}</span>`).join('<span class="plus">+</span>');
const node = (i, name, kind, text, status) => `<div class="node r${i}"><div class="node-n">${name}</div><div class="node-k">${kind}</div><div class="node-t">${text}</div>${status ? `<div class="node-s">${status}</div>` : ''}</div>`;
const map = (areas, lit) => `<div class="map">${areas.map(([name, x, y, w, h]) => `<div class="map-a${lit.includes(name) ? ' map-on' : ''}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"><span>${name}</span></div>`).join('')}</div>`;

export const TOUR = [
  {
    id: 'intro', kind: 'panel', min: 4,
    panel: `<div class="big r0">pairing-buddy</div>
      <div class="big-s r1">a pair programmer in Neovim that knows when to speak</div>
      <div class="big-l"><div class="r2">● it watches while you work, and speaks only when it matters</div>
      <div class="r3">● its words appear where you are already looking</div>
      <div class="r4">● it changes your code only when you hand it the wheel</div></div>`,
    reveal: [0.2, 0.9, {line: 2}, {line: 3}, {line: 4}],
    say: [
      {at: 0.6, text: 'Pairing buddy, or Pair for short, is a pair programmer that sits beside you in Neovim.'},
      {at: 0.4, text: 'It watches while you work, and speaks only when something matters.'},
      {at: 0.3, text: 'Its words appear where you are already looking.'},
      {at: 0.3, text: 'And it changes your code only when you hand it the wheel. This tutorial shows each of these, one at a time.'},
    ],
  },
  {
    id: 'screen', ch: 0, title: 'The screen', pad: 1.2,
    card: {situation: 'First, the screen you will see in every scene.', watch: 'the four labelled areas', area: ['nvim', 'term', 'chat', 'status']},
    say: [
      {at: 'card', text: 'First, the screen you will see in every scene. Watch the four labelled areas.'},
      {at: 0.6, text: 'On the left is Neovim, with your code.'},
      {at: 0.4, text: 'Under it is your terminal, where you run commands.'},
      {at: 0.4, text: 'On the right is Pair’s chat. It keeps a record of what Pair says, and you can type to it.'},
      {at: 0.4, text: 'And along the bottom, the statusline shows what Pair is doing right now.'},
    ],
    shots: [{clip: 't-wrong-turn', from: 0, to: 1.9}],
    areas: [
      {at: {line: 1}, until: {line: 2}, show: ['nvim']},
      {at: {line: 2}, until: {line: 3}, show: ['term']},
      {at: {line: 3}, until: {line: 4}, show: ['chat']},
      {at: {line: 4}, show: ['status']},
    ],
    sum: 'Code, terminal, chat, statusline: Pair speaks in all four.',
    sumSay: 'Your code, your terminal, the chat, and the statusline. Pair uses all four.',
  },
  {chapter: 1},
  {
    id: 'install', ch: 1, title: 'Install', pad: 1.2,
    card: {situation: 'Pair is a Neovim plugin and a small background program, the daemon.', watch: 'the last lines of each command', area: ['term']},
    shots: [
      {clip: 'install', from: 0.8, to: 5.4},
      {clip: 'install', from: 5.4, to: 23.8, rate: 4, badge: 'npm installs'},
      {clip: 'install', from: 23.8, to: 41.1},
    ],
    say: [
      {at: 'card', text: 'Pair is a Neovim plugin and a small program that runs in the background, the daemon. Watch the last lines of each command.'},
      {at: at(1.3), text: 'One npm command installs it, straight from GitHub.'},
      {at: at(26.6), text: 'Then pair setup writes a config file from the example, offers a login, and starts the daemon as a service, so it runs from now on.'},
      {at: 0.6, text: 'Last, it says what to add to Neovim: the plugin, for lazy dot nvim, or any plugin manager.'},
    ],
    typed: [
      {at: at(1.2), until: at(5.4), where: 'you type', text: 'npm install -g github:makefunstuff/pairing-buddy'},
      {at: at(26.8), until: at(28.8), where: 'then', text: 'pair setup'},
    ],
    cams: [
      {at: 0, box: T(0, 0, 90, 6), cut: true},
      {at: at(24.0), box: T(0, 3, 120, 10)},
      {at: {line: 3}, box: T(0, 12, 110, 12)},
    ],
    spots: [
      {at: at(24.2), until: at(26.6), box: T(0, 3, 26, 1), label: 'installed', place: 'below'},
      {at: {line: 2, plus: 1.4}, until: {line: 3}, box: T(0, 8, 96, 1), label: 'the daemon, as a service', place: 'below'},
      {at: {line: 3, plus: 0.6}, box: T(2, 14, 46, 7), label: 'the plugin, in your Neovim config', place: 'above'},
    ],
    sum: 'Two commands: Pair is installed, and its daemon runs as a service.',
  },
  {
    id: 'doctor', ch: 1, title: 'A model, and pair doctor', pad: 1.4,
    card: {situation: 'Pair needs a model: a local server, or a cloud provider with a key.', watch: 'the ticks pair doctor prints', area: ['term']},
    shots: [{clip: 'start', from: 0.8, to: 31}],
    say: [
      {at: 'card', text: 'Pair needs a model: a server on your machine, or a cloud provider with a key. Watch the ticks pair doctor prints.'},
      {at: at(1.4), text: 'The config names one model for both jobs. This tutorial uses DeepSeek, in the cloud.'},
      {at: at(10.2), text: 'Pair auth stores the key, in a file only you can read. It never prints it.'},
      {at: at(18.2), text: 'Then pair doctor checks every part: the service, the daemon, the plugin in Neovim, the sandbox for commands, and the model itself.'},
      {at: 0.6, text: 'It asks the model a question, times the answer, and checks that it thinks. A cross, instead of a tick, would name the fix.'},
    ],
    typed: [
      {at: 0.6, until: 4.4, where: 'you look at', text: 'cat ~/.config/pairing-buddy/config.json'},
      {at: 9.2, until: 12.4, where: 'you type', text: 'pair auth list | grep deepseek'},
      {at: 17.2, until: 19.4, where: 'you type', text: 'pair doctor'},
    ],
    cams: [
      {at: 0, box: T(0, 0, 80, 6), cut: true},
      {at: 8.8, box: T(0, 3, 80, 5)},
      {at: 16.8, box: T(0, 6, 100, 16)},
    ],
    spots: [
      {at: 4.6, until: 8.8, box: T(2, 3, 62, 1), label: 'one model, both roles', place: 'below'},
      {at: 12.6, until: 16.6, box: T(0, 6, 42, 1), label: 'the key: stored, never shown', place: 'below'},
      {at: {line: 3, plus: 1.2}, until: {line: 4}, box: T(0, 8, 70, 9), label: 'every part, checked', place: 'above'},
      {at: {line: 4}, box: T(0, 17, 80, 2), label: 'the model answers, and thinks', place: 'above'},
    ],
    sum: 'A config, a key, and pair doctor: every part checked before you start.',
  },
  {chapter: 2},
  {
    id: 'roles', kind: 'panel', ch: 2, min: 4,
    panel: `<h1 class="r0">Two models, three roles</h1>
      <div class="flow">${node(1, 'Watcher', 'a small, fast model', 'scores each moment from 0 to 10: is this worth a word?')}
      ${node(2, 'Partner', 'a model that thinks', 'reads your code and writes what Pair says')}</div>
      <div class="r-arrow r3">the Partner works in one of three roles</div>
      <div class="roles2">${node(4, 'Navigator', 'the default', 'watches and points at code', '<b>●</b> pair')}
      ${node(5, 'Scout', '/scout in the chat', 'runs commands in a pane of its own, in a sandbox', '<b>●</b> pair · scout')}
      ${node(6, 'Driver', ':Pair drive …', 'types one change, then gives the wheel back', '<b>◎</b> pair has the wheel')}</div>`,
    reveal: [0.2, {line: 1}, {line: 2}, {line: 3}, {line: 4}, {line: 5}, {line: 6}],
    say: [
      {at: 0.5, text: 'Two models share the work. The Watcher is small and fast. It scores every moment from zero to ten: is this worth a word?'},
      {at: 0.3, text: 'Only high scores reach the Partner. It thinks first, reads your code, and writes what Pair says. One model can play both parts.'},
      {at: 0.3, text: 'The Partner works in one of three roles, and the statusline always says which.'},
      {at: 0.3, text: 'Navigator is the default. It watches, and points at code.'},
      {at: 0.3, text: 'Scout runs commands for you, in a pane of its own, inside a sandbox.'},
      {at: 0.3, text: 'And Driver types one change into your buffer, then gives the wheel back.'},
    ],
  },
  {
    id: 'scout', ch: 2, title: 'Scout runs it for you', pad: 1.4,
    card: {situation: 'You want to know why a test fails, without digging yourself.', watch: 'the chat, and the pane that opens under it', area: ['chat', 'term']},
    shots: [{clip: 't-scout', from: 0, to: 24}],
    say: [
      {at: 'card', text: 'You want to know why a test fails, without digging yourself. Watch the chat, and the pane that opens at the bottom.'},
      {at: at(2.4), text: 'In the chat, slash scout switches Pair to the Scout role.'},
      {at: at(7.4), text: 'Then you ask your question, in plain words.'},
      {at: at(11.6), text: 'Pair’s own pane opens at the bottom. Scout runs the test there, and searches the code. Every command is typed where you can see it, in a sandbox: only the project is writable, and there is no network.'},
      {at: at(16.8, 7.6), text: 'The answer comes back in the chat: the greater-or-equal on line thirty-five drops the retry that fits exactly.'},
    ],
    typed: [
      {at: at(4.2), until: at(6.8), where: 'in the chat', text: '/scout'},
      {at: at(7.3), until: at(11.2), where: 'in the chat', text: 'why does the delivery test fail? run it'},
    ],
    cams: [
      {at: at(3.2), box: G(130, 0, 70, 16)},
      {at: at(11.4), box: G(0, 34, 170, 15)},
      {at: at(16.8, 7.4), box: G(130, 4, 70, 12)},
    ],
    spots: [
      {at: at(5.4), until: at(10.6), box: G(136, 6, 64, 3), label: 'Role: Scout', place: 'below'},
      {at: at(12.4), until: at(16.8, 7.2), box: G(0, 36, 162, 11), label: 'Pair’s pane: scout[1], scout[2], each command where you see it', place: 'above'},
      {at: at(16.8, 8.0), box: G(136, 10, 64, 4), label: 'Scout’s answer', place: 'below'},
    ],
    sum: 'You asked once; Scout ran the test in plain sight and answered in the chat.',
  },
  {chapter: 3},
  {
    id: 'wrong-turn', ch: 3, title: 'The wrong turn', pad: 1.4, poster: 3,
    card: {situation: 'A test fails, and you start fixing the wrong file.', watch: 'the margin, under the line you change', area: ['nvim']},
    shots: [
      {clip: 't-wrong-turn', from: 0, to: 15.5},
      {clip: 't-wrong-turn', from: 15.5, to: 35, rate: 3.5, badge: 'Pair thinks'},
      {clip: 't-wrong-turn', from: 35, to: 52.3},
    ],
    say: [
      {at: 'card', text: 'A test fails, and you start fixing the wrong file. Watch the margin, under the line you change.'},
      {at: 2.6, text: 'In your terminal, the delivery test fails: it wants five attempts, and gets four.'},
      {at: 9.6, text: 'You guess the backoff is wrong, and change the shift on line twenty.'},
      {at: 15.8, text: 'Pair saw the red test, and an edit in a file the failure doesn’t name. The Watcher scores that a wrong turn, worth a word.'},
      {at: at(36.3), text: 'So the Partner reads the code, and speaks once, under the line you changed. The cause is the greater-or-equal in worker dot go.'},
      {at: at(44.0), text: 'Alt J goes where it points. Your cursor never moves by itself.'},
    ],
    typed: [
      {at: 2.0, until: 4.2, where: 'you type, in your terminal', text: 'go test ./internal/delivery/'},
      {at: 7.0, until: 10.2, where: 'you open', text: ':e internal/retry/backoff.go'},
      {at: 11.2, until: 14.8, where: 'you change line 20', text: 'b.Base << (attempt - 1)   →   b.Base << attempt'},
    ],
    cams: [
      {at: 4.0, box: G(0, 33, 110, 15)},
      {at: 9.8, box: null},
      {at: 10.6, box: G(0, 12, 120, 14)},
      {at: 15.5, box: null},
      {at: at(35.5), box: G(0, 15, 112, 9)},
      {at: at(44.2), box: null},
      {at: at(45.1), box: G(0, 11, 105, 12)},
    ],
    spots: [
      {at: 4.4, until: 9.6, box: G(0, 37, 82, 2), label: 'wants 5 attempts, gets 4', place: 'above'},
      {at: 11.4, until: 15.4, box: G(4, 19, 28, 1), label: 'your change', place: 'below'},
      {at: at(17.2), until: at(34.6), area: 'pair', label: 'pair · thinking', place: 'above'},
      {at: at(36.7), until: at(44.1), box: G(10, 20, 108, 2), label: 'Pair’s words, under the line you changed', place: 'below'},
      {at: at(46.1), box: G(6, 17, 86, 1), label: 'the real cause, where Alt-J landed', place: 'below'},
    ],
    keys: [{at: at(44.4), keys: ['Alt', 'J'], note: 'go where Pair points'}],
    sum: 'Pair spoke once, where you were looking, and pointed at the real cause.',
  },
  {chapter: 4},
  {
    id: 'tests', ch: 4, title: 'Tests on save', pad: 4.5,
    card: {situation: 'You fix one line, and a test somewhere else breaks.', watch: 'the statusline, then the ghost text', area: ['status', 'nvim']},
    shots: [
      {clip: 't-tests-on-save', from: 0, to: 11.6},
      {clip: 't-tests-on-save', from: 11.6, to: 24, rate: 4, badge: 'Pair reads and thinks'},
      {clip: 't-tests-on-save', from: 24, to: 31.2},
      {clip: 't-tests-on-save', from: 31.2, to: 37.2},
      {clip: 't-tests-on-save', from: 37.2, to: 50.8},
    ],
    say: [
      {at: 'card', text: 'You fix one line, and a test somewhere else breaks. Watch the statusline, then the ghost text.'},
      {at: at(1.6), text: 'Each time you save, Pair runs your tests, in its own pane at the bottom. The delivery test is red.'},
      {at: at(8.6), text: 'You fix the check on line thirty-five, from greater-or-equal to greater, and save again.'},
      {at: at(11.2), text: 'Delivery passes now, but a queue test that passed before now fails. That is a regression, and the Watcher scores it high.'},
      {at: at(24.4), text: 'Pair says why, under your line: the queue’s lease runs out just as the last attempt starts.'},
      {at: at(31.3), text: 'Alt J goes to its fix, in queue dot go. The ghost text shows the old line struck through, and the new one under it. Nothing has changed yet.'},
      {at: at(37.3), text: 'Alt Y takes it into your buffer. You save, the tests run again, and they pass.'},
    ],
    typed: [
      {at: at(1.2), until: at(3.6), where: 'you save', text: ':w'},
      {at: at(8.8), until: at(10.2), where: 'you delete one character', text: '>=   →   >'},
      {at: at(10.2), until: at(11.6), where: 'you save', text: ':w'},
      {at: at(39.4), until: at(41.6), where: 'you save', text: ':w'},
    ],
    cams: [
      {at: at(8.6), box: G(0, 10, 100, 13)},
      {at: at(11.4), box: G(100, 34, 100, 16)},
      {at: at(24.2), box: null},
      {at: at(26.8), box: G(0, 12, 112, 10)},
      {at: at(31.4), box: G(0, 12, 116, 9)},
      {at: at(39.6), box: null},
      {at: at(44.6), box: G(128, 14, 72, 13)},
    ],
    spots: [
      {at: at(2.4), until: at(5.4), box: G(0, 36, 200, 3), label: 'Pair’s pane: go test, after each save', place: 'above'},
      {at: at(5.6), until: at(8.6), box: G(138, 48, 54, 1), label: '✗ the delivery test fails', place: 'above'},
      {at: at(9.2), until: at(11.2), box: G(6, 16, 30, 1), label: 'your fix', place: 'below'},
      {at: at(11.6), until: at(24.2), box: G(138, 48, 54, 1), label: '✗ TestNoDoubleDelivery: it passed before your change', place: 'above'},
      {at: at(27.4), until: at(31.2), box: G(6, 17, 102, 3), label: 'why, under your line', place: 'below'},
      {at: at(31.8), until: at(37.2), box: G(4, 16, 108, 3), label: 'the suggestion: old line struck through, new line under it', place: 'below'},
      {at: at(45.2), box: G(136, 23, 64, 2), label: '✓ the tests pass again', place: 'below'},
    ],
    keys: [{at: at(31.25), keys: ['Alt', 'J'], note: 'go to the fix'}, {at: at(37.25), keys: ['Alt', 'Y'], note: 'take it'}],
    compare: {
      at: at(50.8),
      before: {clip: 't-tests-on-save', t: 32, box: G(0, 13, 118, 7), label: 'before: Pair’s suggestion, not in your file'},
      after: {clip: 't-tests-on-save', t: 38.5, box: G(0, 13, 118, 7), label: 'after Alt-Y: in your buffer, saved with :w'},
    },
    sum: 'Pair ran the tests you might skip, caught a regression, and showed its fix before you took it.',
  },

  {chapter: 5},
  {
    id: 'notes', ch: 5, title: 'Notes in the margin', pad: 1.2,
    card: {situation: 'You are writing a design note, not code yet.', watch: 'the margin of the note', area: ['nvim']},
    shots: [
      {clip: 't-notes', from: 0, to: 6},
      {clip: 't-notes', from: 6, to: 14.6, rate: 3, badge: 'Pair reads the note'},
      {clip: 't-notes', from: 14.6, to: 46},
      {clip: 't-notes', from: 46, to: 54},
    ],
    say: [
      {at: 'card', text: 'You are writing a design note, not code yet. Watch the margin of the note.'},
      {at: at(0.6), text: 'You finish a sentence about dead letters, and stop to think.'},
      {at: at(6.4), text: 'When you stop, Pair reads the whole note, and the code it names.'},
      {at: at(15.0), text: 'Its notes land in the margin, each with a sign. A question mark is a question the note leaves open.'},
      {at: 0.5, text: 'The not-equal sign marks two lines that can’t both be true: five attempts here, six there.'},
      {at: 0.5, text: 'The arrow says what the code really does. Here, the note is wrong about worker dot go.'},
      {at: 0.5, text: 'Nothing in the note changed. The marks are only in the margin.'},
      {at: at(44.0), text: 'When you are ready to build, Pair tasks lists the work the note asks for. Nothing is added until you say so.'},
    ],
    typed: [
      {at: at(0.9), until: at(3.6), where: 'you finish the sentence', text: '…still gets the webhook.'},
      {at: at(43.6), until: at(46.4), where: 'you type', text: ':Pair tasks'},
    ],
    cams: [
      {at: at(0.4), box: G(0, 15, 110, 9)},
      {at: at(6.0), box: null},
      {at: at(15.2), box: G(0, 0, 130, 32)},
      {at: {line: 4}, box: G(0, 12, 110, 9)},
      {at: {line: 5}, box: G(0, 1, 130, 6)},
      {at: {line: 6}, box: G(0, 0, 130, 32)},
      {at: at(43.6), box: null},
      {at: at(46.4), box: G(56, 14, 88, 20)},
    ],
    spots: [
      {at: at(1.0), until: at(6.0), box: G(4, 19, 48, 2), label: 'the paragraph you just finished', place: 'below'},
      {at: {line: 3, plus: 2.4}, until: {line: 4}, box: G(0, 20, 125, 1), label: '? an open question', place: 'below'},
      {at: {line: 4, plus: 0.4}, until: {line: 5}, box: G(0, 16, 100, 1), label: '≠ line 14 and line 20 disagree', place: 'below'},
      {at: {line: 5, plus: 0.4}, until: {line: 6}, box: G(0, 3, 132, 1), label: '→ what worker.go really returns', place: 'below'},
      {at: at(46.6), box: G(59, 15, 82, 18), label: 'the tasks, each with its lines', place: 'below', dim: false},
    ],
    sum: 'Pair read the note like a colleague: questions, contradictions, facts, in the margin.',
  },
  {
    id: 'blank-page', ch: 5, title: 'The blank page', pad: 1.4,
    card: {situation: 'An empty folder, and an idea. No code yet.', watch: 'the note, under your last line', area: ['nvim']},
    shots: [
      {clip: 't-blank-page', from: 0, to: 18.6},
      {clip: 't-blank-page', from: 18.6, to: 27.4, rate: 2, badge: 'you answer'},
      {clip: 't-blank-page', from: 27.4, to: 31},
      {clip: 't-blank-page', from: 31, to: 49.6, rate: 6, badge: 'you think'},
      {clip: 't-blank-page', from: 49.6, to: 56.6, rate: 2, badge: 'you answer'},
      {clip: 't-blank-page', from: 56.6, to: 62},
      {clip: 't-blank-page', from: 62, to: 79.6, rate: 6, badge: 'you think'},
      {clip: 't-blank-page', from: 79.6, to: 86.6, rate: 2, badge: 'you answer'},
      {clip: 't-blank-page', from: 86.6, to: 95.3, rate: 3, badge: 'Pair writes the slice'},
      {clip: 't-blank-page', from: 95.3, to: 105.2},
    ],
    say: [
      {at: 'card', text: 'An empty folder, and an idea. No code yet. Watch the note, under your last line.'},
      {at: at(5.2), text: 'Pair new, and one sentence: what you want to try.'},
      {at: at(14.2), text: 'Pair starts a note with your idea, and asks one question under it.'},
      {at: at(19), text: 'You answer on the next line, in a few words.'},
      {at: at(28.2), text: 'Each answer brings the next question, one at a time. Here, how the stall happens.'},
      {at: at(59.2), text: 'And whether to cap the steps. Three short answers are enough.'},
      {at: at(95.6), text: 'Then Pair suggests a first slice, dimmed, under your answers: two files, what they print, what to poke at, and what to leave out for now.'},
      {at: at(101.4), text: 'Alt Y takes it into the note. Nothing is written to disk until you save.'},
    ],
    typed: [
      {at: at(6.4), until: at(13.6), where: 'you type', text: ':Pair new a tiny C toy with a Makefile, to see how a fixed-timestep loop catches up after a stall'},
    ],
    cams: [
      {at: at(13.8), box: G(0, 0, 105, 10)},
      {at: at(95.4), box: G(0, 0, 120, 31)},
      {at: at(103.4), box: G(0, 6, 120, 24)},
    ],
    spots: [
      {at: at(16.4), until: at(19), box: G(4, 3, 82, 1), label: 'Pair’s first question', place: 'below'},
      {at: at(28.4), until: at(31), box: G(4, 4, 72, 1), label: 'the next question', place: 'below'},
      {at: at(59.4), until: at(62), box: G(4, 5, 72, 1), label: 'the last question', place: 'below'},
      {at: at(96.4), until: at(101.2), box: G(4, 7, 98, 22), label: 'the first slice, a suggestion: not in the note yet', place: 'above'},
    ],
    keys: [{at: at(101.2), keys: ['Alt', 'Y'], note: 'take it'}],
    sum: 'Three questions, three short answers, and a first slice small enough to start.',
  },
  {chapter: 6},
  {
    id: 'hand-over', ch: 6, title: 'Hand Pair the wheel', pad: 1.4,
    card: {situation: 'You want table cases written, and you’d rather watch.', watch: 'your code, and the statusline', area: ['nvim', 'status']},
    shots: [
      {clip: 't-hand-over', from: 0, to: 6},
      {clip: 't-hand-over', from: 6, to: 25.3, rate: 4, badge: 'Pair reads and thinks'},
      {clip: 't-hand-over', from: 25.3, to: 47.2},
    ],
    say: [
      {at: 'card', text: 'You want the edge cases of a table test written, and you’d rather watch. Watch your code, and the statusline.'},
      {at: at(0.5), text: 'You hand over with Pair drive, and say what you want.'},
      {at: at(5.0), text: 'Pair is the Driver now. The statusline says it has the wheel. It reads the test and the code first.'},
      {at: at(25.6), text: 'Then it types, into your buffer, where you can see every line arrive.'},
      {at: at(30.6), text: 'It runs the tests on the unsaved buffer, in its own pane at the bottom, and hands the wheel back with a short note.'},
      {at: at(40.6), text: 'Nothing is saved yet. U takes the whole change away in one step, and control R brings it back.'},
    ],
    typed: [{at: at(1.0), until: at(4.4), where: 'you type', text: ':Pair drive the edge cases'}],
    cams: [
      {at: at(5.0), box: G(150, 46, 50, 4)},
      {at: at(24.4), box: G(0, 6, 110, 18)},
      {at: at(30.4), box: null},
    ],
    spots: [
      {at: at(5.4), until: at(24.6), area: 'pair', label: '◎ pair has the wheel', place: 'above'},
      {at: at(25.9), until: at(30.4), box: G(12, 14, 90, 9), label: 'typed by Pair, unsaved', place: 'below'},
      {at: at(30.8), until: at(33.2), box: G(0, 36, 200, 4), label: 'Pair’s own pane: go test on the unsaved buffer', place: 'above'},
      {at: at(33.4), until: at(40.6), box: G(136, 6, 64, 14), label: 'the hand-back note', place: 'below'},
    ],
    keys: [{at: at(41.25), keys: ['u'], note: 'undo it all'}, {at: at(44.25), keys: ['Ctrl', 'R'], note: 'and back'}],
    compare: {
      at: at(47.2),
      before: {clip: 't-hand-over', t: 1, box: G(0, 7, 100, 16), label: 'before: one case'},
      after: {clip: 't-hand-over', t: 30, box: G(0, 7, 100, 16), label: 'after: typed by Pair, one undo step'},
    },
    sum: 'Pair typed one change in plain sight, tested it, and gave the wheel back.',
  },
  {
    id: 'take-back', ch: 6, title: 'Take the wheel back', pad: 1.4,
    card: {situation: 'Pair is typing, and you change your mind.', watch: 'the lines it types, and the chat', area: ['nvim', 'chat']},
    shots: [
      {clip: 't-take-back', from: 0, to: 6},
      {clip: 't-take-back', from: 6, to: 26.4, rate: 5, badge: 'Pair reads and thinks'},
      {clip: 't-take-back', from: 26.4, to: 36},
    ],
    say: [
      {at: 'card', text: 'Pair is typing, and you change your mind. Watch the lines it types, and the chat.'},
      {at: at(1.0), text: 'Same hand-over as before.'},
      {at: at(26.6), text: 'Pair starts typing the cases.'},
      {at: at(29.2), text: 'You press any key. The typing stops, and what it typed is gone, as if it never started.'},
      {at: at(31.0), text: 'The chat says you have the wheel back, and Pair is the Navigator again.'},
    ],
    typed: [
      {at: at(1.0), until: at(4.4), where: 'you type', text: ':Pair drive the edge cases'},
      {at: at(29.2), until: at(31.4), where: 'you press', text: 'j'},
    ],
    cams: [
      {at: at(26.2), box: G(0, 6, 100, 16)},
      {at: at(30.6), box: G(120, 0, 80, 18)},
    ],
    spots: [
      {at: at(27.2), until: at(29.25), box: G(6, 15, 70, 4), label: 'Pair, typing', place: 'below', dim: false},
      {at: at(29.4), until: at(30.6), box: G(6, 15, 70, 4), label: 'gone', place: 'below', dim: false},
      {at: at(31.2), box: G(136, 8, 64, 3), label: 'the wheel is yours again', place: 'below'},
    ],
    sum: 'Any key takes the wheel back, and nothing Pair typed stays behind.',
  },
  {chapter: 7},
  {
    id: 'voice', ch: 7, title: 'Push-to-talk', pad: 1.6,
    card: {situation: 'Your hands are on the code, and a question comes up.', watch: 'the line under your cursor', area: ['nvim']},
    shots: [
      {clip: 't-push-to-talk', from: 0, to: 10.2},
      {clip: 't-push-to-talk', from: 10.2, to: 22},
    ],
    say: [
      {at: 'card', text: 'Your hands are on the code, and a question comes up. Watch the line under your cursor.'},
      {at: at(1.0), text: 'Hold Alt T, and ask out loud. The meter shows Pair hears you.'},
      {at: at(6.3), text: 'Let go, and whisper dot c p p writes down what it heard, on your own machine. That is your question, under your line.'},
      {at: at(11.6), text: 'Then Pair answers in the same place, and points at line thirty-five. Alt J would go there.'},
    ],
    cams: [
      {at: at(1.6), box: G(0, 15, 110, 7)},
      {at: at(11.4), box: G(0, 14, 115, 12)},
    ],
    spots: [
      {at: at(2.2), until: at(6.2), box: G(14, 18, 44, 1), label: 'listening, while you hold the key', place: 'below'},
      {at: at(6.6), until: at(10.4), box: G(14, 18, 60, 1), label: 'what whisper.cpp heard', place: 'below'},
      {at: at(12.4), box: G(14, 18, 92, 3), label: 'the answer, where you asked', place: 'below'},
    ],
    keys: [{at: at(2), keys: ['Alt', 'T'], note: 'hold, and ask', hold: 4}],
    sum: 'You asked out loud; the answer came where you were looking. Voice is off until you set it up.',
    sumSay: 'You asked out loud, and the answer came where you were looking. Voice is off until you set it up.',
  },
  {chapter: 8},
  {
    id: 'herdr', kind: 'panel', ch: 8, min: 4,
    panel: `<h1 class="r0">With or without herdr</h1>
      <div class="herdr">
        <div class="herdr-c r1"><div class="herdr-h">Without herdr</div>
          ${map([['your code', 2, 3, 64, 62], ['your terminal', 2, 68, 64, 14], ['Pair’s chat', 68, 3, 30, 79], ['Pair’s pane', 2, 85, 96, 11]], ['Pair’s chat', 'Pair’s pane'])}
          <div class="herdr-t">One Neovim holds it all: <b>:Pair chat</b> opens the chat, and Pair’s pane is a <b>:terminal</b>. Every scene in this tutorial ran this way.</div></div>
        <div class="herdr-c r2"><div class="herdr-h">With herdr</div>
          ${map([['Neovim', 2, 3, 47, 58], ['Pair’s chat', 51, 3, 47, 58], ['your shell', 2, 64, 47, 32], ['Pair’s pane', 51, 64, 47, 32]], ['Pair’s chat', 'Pair’s pane'])}
          <div class="herdr-t">The chat and Pair’s pane are herdr panes. Pair also sees your other agents on herdr’s board, and terminals outside Neovim.</div></div>
      </div>`,
    reveal: [0.2, {line: 1}, {line: 3}],
    say: [
      {at: 0.5, text: 'Pair works with or without herdr, the terminal workspace for coding agents.'},
      {at: 0.3, text: 'Without it, one Neovim holds everything. Pair chat opens the chat, and Pair’s own pane is a terminal at the bottom.'},
      {at: 0.3, text: 'Every scene you just saw ran this way.'},
      {at: 0.3, text: 'With herdr, the chat and Pair’s pane are panes of their own. Pair also sees your other agents on herdr’s board, and terminals outside Neovim.'},
      {at: 0.3, text: 'Either way, it is the same Pair, with the same keys.'},
    ],
  },
  {
    id: 'keys', kind: 'panel', min: 4,
    panel: `<h1 class="r0">The keys to remember</h1>
      <div class="cheats">${CHEATS.map((row, i) => `<div class="cheat r${i + 1}"><span class="cheat-k">${key(row.keys)}</span><span class="cheat-w">${row.what}</span></div>`).join('')}</div>
      <div class="url r${CHEATS.length + 1}">github.com/makefunstuff/pairing-buddy</div>`,
    reveal: [0.2, ...CHEATS.map((_, i) => 1 + i * 0.9), {line: 2}],
    say: [
      {at: 0.5, text: 'Here are the keys to remember. Alt J goes where Pair points, and Alt Y takes its suggested change. Alt question mark explains the idea behind its words. Pair drive hands over one change, U undoes it, and any key takes the wheel back. Hold Alt T to ask out loud, and run pair doctor whenever something seems off.'},
      {at: 0.5, text: 'Pairing buddy is on GitHub. Happy pairing.'},
    ],
  },
];

// The cut for social media: the three moments that matter most, from the same takes, in about a minute.
export const SHORT = [
  {
    id: 'x-open', kind: 'panel', min: 3,
    panel: `<div class="big r0">pairing-buddy</div>
      <div class="big-s r1">an AI pair programmer in Neovim that knows when to speak</div>
      <div class="big-l r2">three moments from an ordinary day</div>`,
    reveal: [0.1, 0.6, {line: 1, plus: 2.2}],
    say: [{at: 0.4, text: 'Pairing buddy is an AI pair programmer for Neovim. Here are three moments from an ordinary day.'}],
  },
  {
    id: 'x-margin', title: 'It speaks where you look', pad: 1,
    card: {situation: 'You edit the wrong file while a test is red.', watch: 'the margin', area: ['nvim']},
    shots: [
      {clip: 't-wrong-turn', from: 10, to: 15.5},
      {clip: 't-wrong-turn', from: 15.5, to: 35, rate: 8, badge: 'Pair thinks'},
      {clip: 't-wrong-turn', from: 35, to: 40.5},
      {clip: 't-wrong-turn', from: 44, to: 48.5},
    ],
    say: [
      {at: 'card', text: 'You edit the wrong file while a test is red. Watch the margin.'},
      {at: at(10.6), text: 'You change the backoff.'},
      {at: at(36.3), text: 'Pair speaks once, under your line. The real cause is in worker dot go.'},
      {at: at(44.0), text: 'Alt J goes there.'},
    ],
    cams: [
      {at: at(10), box: G(0, 12, 120, 14), cut: true},
      {at: at(35.5), box: G(0, 15, 112, 9)},
      {at: at(44.2), box: null},
      {at: at(45.1), box: G(0, 11, 105, 12)},
    ],
    spots: [
      {at: at(11.4), until: at(15.4), box: G(4, 19, 28, 1), label: 'your change', place: 'below'},
      {at: at(36.7), until: at(44.1), box: G(10, 20, 108, 2), label: 'Pair’s words, under your line', place: 'below'},
      {at: at(46.1), box: G(6, 17, 86, 1), label: 'the real cause', place: 'below'},
    ],
    keys: [{at: at(44.4), keys: ['Alt', 'J']}],
    quietSum: true,
    sum: 'One remark, in the right place.',
  },
  {
    id: 'x-tests', title: 'It runs what you’d skip', pad: 1,
    card: {situation: 'You fix one line, and save.', watch: 'the statusline, then the ghost text', area: ['status', 'nvim']},
    shots: [
      {clip: 't-tests-on-save', from: 8.6, to: 11.6},
      {clip: 't-tests-on-save', from: 11.6, to: 24, rate: 8, badge: 'Pair thinks'},
      {clip: 't-tests-on-save', from: 24, to: 27.5},
      {clip: 't-tests-on-save', from: 31, to: 39.5},
      {clip: 't-tests-on-save', from: 44.6, to: 46.5},
    ],
    say: [
      {at: 'card', text: 'You fix one line, and save. Watch the statusline, then the ghost text.'},
      {at: at(9.0), text: 'Pair runs your tests on every save.'},
      {at: at(11.6), text: 'A test that passed before now fails.'},
      {at: at(31.3), text: 'Alt J shows Pair’s fix as ghost text: the old line struck through, the new one under it.'},
      {at: at(37.3), text: 'Alt Y takes it. Save, and it’s green.'},
    ],
    cams: [
      {at: at(8.6), box: G(0, 10, 100, 13), cut: true},
      {at: at(11.4), box: null},
      {at: at(31.4), box: G(0, 12, 116, 9)},
      {at: at(44.6), box: G(128, 14, 72, 13), cut: true},
    ],
    spots: [
      {at: at(11.8), until: at(24.2), box: G(138, 48, 54, 1), label: '✗ a test that passed before', place: 'above'},
      {at: at(31.8), until: at(37.2), box: G(4, 16, 108, 3), label: 'Pair’s fix, not in your file yet', place: 'below'},
      {at: at(44.8), box: G(136, 23, 64, 2), label: '✓ green again', place: 'below'},
    ],
    keys: [{at: at(31.25), keys: ['Alt', 'J']}, {at: at(37.25), keys: ['Alt', 'Y']}],
    quietSum: true,
    sum: 'It runs the tests you would skip.',
  },
  {
    id: 'x-drive', title: 'It drives only when you ask', pad: 1,
    card: {situation: 'You hand Pair the wheel for one change.', watch: 'your code', area: ['nvim']},
    shots: [
      {clip: 't-hand-over', from: 0.5, to: 6},
      {clip: 't-hand-over', from: 6, to: 25.3, rate: 8, badge: 'Pair thinks'},
      {clip: 't-hand-over', from: 25.3, to: 33.5},
      {clip: 't-hand-over', from: 40.6, to: 44.6},
    ],
    say: [
      {at: 'card', text: 'You hand Pair the wheel for one change. Watch your code.'},
      {at: at(1.0), text: 'Pair drive, and say what you want.'},
      {at: at(25.6), text: 'It types where you can see it, tests the unsaved buffer, and hands back.'},
      {at: at(41.0), text: 'U undoes it all, in one step.'},
    ],
    typed: [{at: at(1.0), until: at(4.4), where: 'you type', text: ':Pair drive the edge cases'}],
    cams: [{at: at(24.4), box: G(0, 6, 110, 18)}],
    spots: [{at: at(25.9), until: at(30.4), box: G(12, 14, 90, 9), label: 'typed by Pair, unsaved', place: 'below'}],
    keys: [{at: at(41.25), keys: ['u'], note: 'undo it all'}],
    quietSum: true,
    sum: 'It touches your code only when you hand it the wheel.',
  },
  {
    id: 'x-end', kind: 'panel', min: 3,
    panel: `<div class="big r0">pairing-buddy</div>
      <div class="big-s r1">the full tutorial, the docs and the code</div>
      <div class="url r2" style="top:560px">github.com/makefunstuff/pairing-buddy</div>`,
    reveal: [0.1, 0.5, 0.9],
    say: [{at: 0.4, text: 'Pairing buddy. The full tutorial, the docs and the code are on GitHub.'}],
  },
];

/** The lines of voice of a scene, with their ids (the files tts.mjs writes) and the part they belong to. */
export function lines(scene) {
  const out = [];
  let n = 0;
  for (const line of scene.say ?? []) {
    if (line.at === 'card') out.push({...line, at: 0.3, part: 'card', id: `${scene.id}-card`});
    else out.push({...line, part: 'body', id: `${scene.id}-${++n}`});
  }
  if (scene.sum && !scene.quietSum) out.push({text: scene.sumSay ?? scene.sum, at: 0.5, part: 'sum', id: `${scene.id}-sum`});
  return out;
}

/** Every line of voice of both cuts, for tts.mjs and words.mjs. */
export function allLines() {
  const seen = new Set();
  return [...TOUR, ...SHORT].filter(scene => !scene.chapter).flatMap(lines).filter(line => !seen.has(line.id) && seen.add(line.id));
}
