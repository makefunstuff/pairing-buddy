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
  3: ['The chat pane', 'talk to Pair, and act on what it says'],
  4: ['Exploring code', 'it watches, reads, and points'],
  5: ['Tests', 'it runs what you’d skip'],
  6: ['Notes and the blank page', 'thinking before the code'],
  7: ['The hand-over', 'Pair types one change while you watch'],
  8: ['Asking for code', '/gen: code when you ask, yours once you read it'],
  9: ['The board', 'other agents’ work, in one place'],
  10: ['Several worktrees', 'one project and one session each'],
  11: ['Voice', 'ask out loud'],
  12: ['With or without herdr', 'where the panes live'],
};

export const CHEATS = [
  {keys: ['Alt', 'J'], what: 'go where Pair points'},
  {keys: ['Alt', 'Y'], what: 'take Pair’s suggested change'},
  {keys: ['Alt', '↑'], what: 'in the chat: pick a message, then act on it'},
  {keys: ['/gen here …'], what: 'ask for code; /undo takes it back'},
  {keys: [':Pair drive …'], what: 'hand Pair one change; any key takes it back'},
  {keys: [':Pair agents'], what: 'your other agents; Alt-R reviews a task'},
  {keys: ['Alt', 'T'], what: 'hold, ask aloud, let go'},
  {keys: ['pair doctor'], what: 'check every part of the setup'},
];

const at = (t, plus) => (plus ? {t, plus} : {t}); // a time in the take

// The five roles' sprites, 12x12 pixels each: w white, b blue, k black, y yellow, g green, r red, o orange, l grey.
const COLORS = {w: '#fff1e8', b: '#29adff', k: '#000000', y: '#ffec27', g: '#00e436', r: '#ff004d', o: '#ffa300', l: '#c2c3c7'};
const SPRITES = {
  watcher: ['............', '....wwww....', '..ww....ww..', '.w..bbbb..w.', 'w..bbkkbb..w', 'w..bkkkkb..w',
    'w..bkkkkb..w', 'w..bbkkbb..w', '.w..bbbb..w.', '..ww....ww..', '....wwww....', '............'],
  partner: ['............', '.wwwwwwwwww.', 'w..........w', 'w..........w', 'w.gg.gg.gg.w', 'w.gg.gg.gg.w',
    'w..........w', 'w..........w', '.wwwwww.www.', '.......ww...', '......w.....', '............'],
  navigator: ['....yyyy....', '..yy....yy..', '.y...rr...y.', '.y...rr...y.', 'y...rrrr...y', 'y....rr....y',
    'y....ll....y', 'y....ll....y', '.y...ll...y.', '.y........y.', '..yy....yy..', '....yyyy....'],
  scout: ['...bbbb.....', '..b....b....', '.b..ww..b...', '.b.w....b...', '.b......b...', '.b......b...',
    '..b....b....', '...bbbbo....', '.......oo...', '........oo..', '.........oo.', '..........o.'],
  driver: ['....wwww....', '..ww....ww..', '.w........w.', '.w........w.', 'w....oo....w', 'wwwwwoowwwww',
    'w....oo....w', 'w....ww....w', '.w...ww...w.', '.w...ww...w.', '..ww.ww.ww..', '....wwww....'],
};
const sprite = name => `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">${SPRITES[name]
  .flatMap((row, y) => [...row].map((c, x) => (c === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${COLORS[c]}"/>`))).join('')}</svg>`;

const key = list => list.map(k => `<span class="key">${k}</span>`).join('<span class="plus">+</span>');
const node = (i, name, kind, text, status) => `<div class="node r${i}">${sprite(name.toLowerCase())}<div class="node-n">${name}</div><div class="node-k">${kind}</div><div class="node-t">${text}</div>${status ? `<div class="node-s">${status}</div>` : ''}</div>`;
const map = (areas, lit) => `<div class="map">${areas.map(([name, x, y, w, h]) => `<div class="map-a${lit.includes(name) ? ' map-on' : ''}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"><span>${name}</span></div>`).join('')}</div>`;

// The panels of the new chapters: what /gen can make, several worktrees, and voice through OpenRouter.
const SHAPES = [
  ['/gen here', 'code at your cursor'],
  ['/gen file', 'new files, as buffers to review'],
  ['/gen try', 'a sample to run, outside the project'],
  ['/gen scaffold', 'many files and their wiring, built aside'],
  ['/gen board', 'a task for another agent'],
];
const GEN_SHAPES = {
  id: 'gen-shapes', kind: 'panel', ch: 8, min: 4,
  panel: `<h1 class="r0">Five shapes of /gen</h1>
    <div class="cheats shapes">${SHAPES.map(([cmd, what], i) => `<div class="cheat r${i + 1}"><span class="cheat-k"><span class="key">${cmd}</span></span><span class="cheat-w">${what}</span></div>`).join('')}</div>
    <div class="url r6">nothing reaches your project until you take it</div>`,
  reveal: [0.2, {line: 2}, {line: 2, plus: 1.6}, {line: 2, plus: 3.6}, {line: 2, plus: 6.0}, {line: 2, plus: 9.4}, {line: 3}],
  say: [
    {at: 0.5, text: 'Pair writes code when you ask for it, and only then. You ask with slash gen, in one of five shapes.'},
    {at: 0.3, text: 'Here is code at your cursor. File makes new files, as buffers to review. Try writes a sample to run, outside your project. Scaffold builds many files and their wiring, away from your project. And board hands the work to another agent.'},
    {at: 0.3, text: 'Whatever the shape, nothing reaches your project until you take it.'},
  ],
};
const WORKTREES = {
  id: 'worktrees', kind: 'panel', ch: 10, min: 4,
  panel: `<h1 class="r0">Several worktrees</h1>
    <div class="herdr">
      <div class="herdr-c r1"><div class="herdr-h">~/hookd</div>
        ${map([['Neovim', 2, 3, 62, 92], ['chat · goal A', 66, 3, 32, 92]], ['chat · goal A'])}
        <div class="herdr-t">branch <b>main</b>: one project, one session, its goal and its chat.</div></div>
      <div class="herdr-c r2"><div class="herdr-h">~/hookd-22</div>
        ${map([['Neovim', 2, 3, 62, 92], ['chat · goal B', 66, 3, 32, 92]], ['chat · goal B'])}
        <div class="herdr-t">branch <b>work/22-park</b>: another project, with its own session.</div></div>
    </div>
    <div class="url r3">to switch, go to the Neovim started there · not :cd</div>`,
  reveal: [0.2, {line: 2}, {line: 2, plus: 2.4}, {line: 3}],
  say: [
    {at: 0.5, text: 'You can work in several git worktrees at once.'},
    {at: 0.3, text: 'A project is the git root of the folder Neovim starts in. So each worktree is a project of its own, with its own session, goal, chat and memory.'},
    {at: 0.3, text: 'To switch, go to the Neovim you started in the other worktree, rather than colon c d in this one.'},
    {at: 0.3, text: 'A scaffold made with dash dash branch is a worktree too. Open a Neovim there, and it pairs on its own.'},
  ],
};
const OPENROUTER = {
  id: 'openrouter', kind: 'panel', ch: 11, min: 4,
  panel: `<h1 class="r0">Voice through OpenRouter</h1>
    <pre class="conf r1">"voice": {
  "openrouter": {
    "apiKeyFile": "~/.config/openrouter.key",
    "hear": "openai/whisper-large-v3-turbo",
    "speak": {"model": "x-ai/grok-voice-tts-1.0", "voice": "eve"}
  }
}</pre>
    <div class="conf-t r2">no whisper.cpp to build · answers read aloud only when you are away · the recording leaves your machine</div>`,
  reveal: [0.2, {line: 1, plus: 1}, {line: 2}],
  say: [
    {at: 0.5, text: 'No whisper dot c p p to build? OpenRouter can hear you instead, and read the answer aloud when you are away from the editor.'},
    {at: 0.3, text: 'Name its models and your key in the config, and pair doctor checks them. The recording then leaves your machine.'},
  ],
};

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
    card: {situation: 'You want to know why a test fails, without digging yourself.', watch: 'the chat, and the pane at the bottom', area: ['chat', 'term']},
    shots: [{clip: 't-scout', from: 1.6, to: 26}],
    say: [
      {at: 'card', text: 'You want to know why a test fails, without digging yourself. Watch the chat, and the pane at the bottom.'},
      {at: at(2.4), text: 'In the chat, slash scout switches Pair to the Scout role. The header says so.'},
      {at: at(6.6), text: 'Then you ask your question, in plain words.'},
      {at: at(10.8), text: 'Scout runs the test in Pair’s own pane at the bottom, where you can see every command, in a sandbox: only the project is writable, and there is no network.'},
      {at: at(15.2), text: 'The answer comes back in the chat, and under your line in Neovim: the greater-or-equal on line thirty-five rejects the wait that fits exactly.'},
    ],
    typed: [
      {at: at(3.4), until: at(4.8), where: 'in the chat', text: '/scout'},
      {at: at(6.4), until: at(10.6), where: 'in the chat', text: 'why does the delivery test fail? run it'},
    ],
    cams: [
      {at: at(2.6), box: G(128, 0, 72, 18)},
      {at: at(10.8), box: G(0, 14, 140, 16)},
      {at: at(15.0), box: null},
    ],
    spots: [
      {at: at(3.2), until: at(6.4), box: G(176, 0, 24, 1), label: 'role: scout', place: 'below'},
      {at: at(11.6), until: at(15.0), box: G(0, 18, 140, 4), label: 'Pair’s pane: the test, where you see it', place: 'below'},
      {at: at(15.6), until: at(20.6), box: G(136, 27, 64, 6), label: 'Scout’s answer', place: 'above'},
      {at: at(20.8), box: G(2, 0.5, 130, 2), label: 'and under your line', place: 'below'},
    ],
    sum: 'You asked once; Scout ran the test in plain sight and answered.',
  },
  {chapter: 3},
  {
    id: 'chat-remark', ch: 3, title: 'A remark, in the chat', pad: 1.4,
    card: {situation: 'Pair’s chat is a full-screen pane beside your code.', watch: 'its header, then the newest message', area: ['chat']},
    shots: [
      {clip: 't-chat', from: 0, to: 9},
      {clip: 't-chat', from: 9, to: 26.6, rate: 4, badge: 'Pair reads and thinks'},
      {clip: 't-chat', from: 26.6, to: 39.0},
    ],
    say: [
      {at: 'card', text: 'Pair’s chat is a full screen pane beside your code. Watch its header, then the newest message.'},
      {at: at(0.3), text: 'The header names the project, the session’s goal, Pair’s role and its talk level.'},
      {at: at(1.6), text: 'You save, and the tests run in Pair’s pane at the bottom. You fix the budget check and save again: now a queue test fails.'},
      {at: at(26.8), text: 'Pair’s remark lands in the chat: the kind of moment, the file and line, the fix as a diff, and why.'},
      {at: at(31.0), text: 'Under it, its action line: the keys that work on this remark.'},
      {at: at(32.9), text: 'Alt up picks the message, and the footer lists all you can do with it. Plus rates it useful.'},
    ],
    typed: [
      {at: at(1.0), until: at(2.6), where: 'you save', text: ':w'},
      {at: at(6.6), until: at(8.8), where: 'you fix line 35, and save', text: '>=   →   >'},
    ],
    cams: [
      {at: at(0.2), box: G(130, 0, 70, 12)},
      {at: at(1.8), box: null},
      {at: at(26.7), box: G(128, 16, 72, 20)},
    ],
    spots: [
      {at: at(0.6), until: at(1.8), box: G(136, 0, 64, 1), label: 'project · goal · role · level', place: 'below'},
      {at: at(27.2), until: at(30.8), box: G(140, 19, 60, 7), label: 'the remark: its kind, file and line, the fix as a diff', place: 'above'},
      {at: at(31.1), until: at(32.8), box: G(140, 31, 60, 1), label: 'its action line', place: 'above'},
      {at: at(33.4), until: at(37.2), box: G(136, 34, 64, 1), label: 'picked: the keys that act on it', place: 'above'},
      {at: at(37.6), box: G(176, 19, 24, 1), label: '✓ useful', place: 'below'},
    ],
    keys: [{at: at(32.9), keys: ['Alt', '↑'], note: 'pick it'}, {at: at(36.9), keys: ['+'], note: 'useful'}],
    sum: 'Every remark lands in the chat too, with the keys that act on it.',
  },
  {
    id: 'chat-ask', ch: 3, title: 'Ask, with @ files', pad: 1.4,
    card: {situation: 'You have a question about the lease.', watch: 'what you type, then the answer', area: ['chat']},
    shots: [{clip: 't-chat', from: 39.0, to: 54.8}],
    say: [
      {at: 'card', text: 'You have a question about the lease. Watch what you type, then the answer.'},
      {at: at(39.4), text: 'Anything you type that is not a command is a question for Pair.'},
      {at: at(44.8), text: 'The at sign opens the project’s files. Tab puts the one you pick into your question, for Pair to read.'},
      {at: at(47.8), text: 'While Pair works, the rule over the input says what it does.'},
      {at: at(49.6), text: 'And the answer streams in, under your question.'},
    ],
    typed: [{at: at(39.6), until: at(45.8), where: 'you type, in the chat', text: 'why does the lease end before the last attempt? @queue'}],
    cams: [{at: at(39.2), box: G(128, 18, 72, 18)}],
    spots: [
      {at: at(44.8), until: at(47.0), box: G(136, 29, 64, 3), label: '@: the project’s files', place: 'above'},
      {at: at(48.0), until: at(49.5), box: G(136, 32, 64, 1), label: 'what Pair does now', place: 'above'},
      {at: at(50.0), box: G(136, 25, 64, 7), label: 'the answer', place: 'above'},
    ],
    keys: [{at: at(46.6), keys: ['Tab'], note: 'insert it'}],
    sum: 'Type a question; @ names a file for Pair to read.',
  },
  {
    id: 'chat-keys', ch: 3, title: 'Commands and keys', pad: 1.4,
    card: {situation: 'Not sure what to type?', watch: 'the menu over the input', area: ['chat']},
    shots: [{clip: 't-chat', from: 54.8, to: 69.7}],
    say: [
      {at: 'card', text: 'Not sure what to type? Watch the menu over the input.'},
      {at: at(55.3), text: 'Slash opens the commands, each with its arguments and what it does. Typing narrows them: here, all that slash gen does.'},
      {at: at(62.8), text: 'And on an empty line, question mark shows every key.'},
    ],
    typed: [{at: at(55.3), until: at(60.9), where: 'you type', text: '/gen'}],
    cams: [{at: at(55.2), box: G(128, 14, 72, 22)}, {at: at(62.7), box: G(128, 0, 72, 36)}],
    spots: [
      {at: at(55.9), until: at(62.3), box: G(136, 23, 64, 9), label: 'the commands: name, arguments, what it does', place: 'above'},
      {at: at(63.5), until: at(66.9), box: G(136, 0, 64, 32), label: 'every key', place: 'below', dim: false},
    ],
    keys: [{at: at(62.8), keys: ['?'], note: 'the keys'}],
    sum: '/ for commands, @ for files, Alt-↑ to act, ? for every key.',
  },
  {chapter: 4},
  {
    id: 'wrong-turn', ch: 4, title: 'The wrong turn', pad: 1.4, poster: 3,
    card: {situation: 'A test fails, and you start fixing the wrong file.', watch: 'the margin, under the line you change', area: ['nvim']},
    shots: [
      {clip: 't-wrong-turn', from: 0, to: 15.6},
      {clip: 't-wrong-turn', from: 15.6, to: 22.6, rate: 2, badge: 'Pair thinks'},
      {clip: 't-wrong-turn', from: 22.6, to: 37.7},
    ],
    say: [
      {at: 'card', text: 'A test fails, and you start fixing the wrong file. Watch the margin, under the line you change.'},
      {at: 2.6, text: 'In your terminal, the delivery test fails: it wants five attempts, and gets four.'},
      {at: 9.6, text: 'You guess the backoff is wrong, and change the shift on line twenty.'},
      {at: 15.8, text: 'Pair saw the red test, and an edit in a file the failure doesn’t name. The Watcher scores that a wrong turn, worth a word.'},
      {at: at(22.8), text: 'So the Partner reads the code, and speaks once, under the line you changed. The cause is the greater-or-equal in worker dot go.'},
      {at: at(29.8), text: 'Alt J goes where it points. Your cursor never moves by itself.'},
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
      {at: at(22.7), box: G(0, 15, 112, 9)},
      {at: at(30.0), box: null},
      {at: at(30.8), box: G(0, 11, 105, 12)},
    ],
    spots: [
      {at: 4.4, until: 9.6, box: G(0, 37, 82, 2), label: 'wants 5 attempts, gets 4', place: 'above'},
      {at: 11.4, until: 15.4, box: G(4, 19, 28, 1), label: 'your change', place: 'below'},
      {at: at(16.4), until: at(22.4), area: 'pair', label: 'pair · thinking', place: 'above'},
      {at: at(23.2), until: at(29.9), box: G(4, 20.3, 108, 1.9), label: 'Pair’s words, under the line you changed', place: 'below'},
      {at: at(31.4), box: G(6, 16.8, 112, 1.2), label: 'the real cause, where Alt-J landed', place: 'below'},
    ],
    keys: [{at: at(29.9), keys: ['Alt', 'J'], note: 'go where Pair points'}],
    sum: 'Pair spoke once, where you were looking, and pointed at the real cause.',
  },
  {chapter: 5},
  {
    id: 'tests', ch: 5, title: 'Tests on save', pad: 2.5,
    card: {situation: 'You fix one line, and a test somewhere else breaks.', watch: 'the statusline, then the ghost text', area: ['status', 'nvim']},
    shots: [
      {clip: 't-tests-on-save', from: 0, to: 12.4},
      {clip: 't-tests-on-save', from: 12.4, to: 30.6, rate: 4, badge: 'Pair reads and thinks'},
      {clip: 't-tests-on-save', from: 30.6, to: 38.6},
      {clip: 't-tests-on-save', from: 38.6, to: 55.2},
    ],
    say: [
      {at: 'card', text: 'You fix one line, and a test somewhere else breaks. Watch the statusline, then the ghost text.'},
      {at: at(1.6), text: 'Each time you save, Pair runs your tests, in its own pane at the bottom. The delivery test is red.'},
      {at: at(9.4), text: 'You fix the check on line thirty-five, from greater-or-equal to greater, and save again.'},
      {at: at(12.4), text: 'Delivery passes now, but a queue test that passed before now fails. That is a regression, and the Watcher scores it high.'},
      {at: at(30.8), text: 'Pair says why, under your line: the queue’s lease is only the budget, and attempt five starts just as it ends.'},
      {at: at(38.7), text: 'Alt J goes to its fix, in queue dot go. The ghost text shows the old line struck through, and the new lines under it. Nothing has changed yet.'},
      {at: at(44.0), text: 'Alt Y takes it into your buffer. You save, the tests run again, and they pass.'},
    ],
    typed: [
      {at: at(1.2), until: at(3.6), where: 'you save', text: ':w'},
      {at: at(9.6), until: at(11.0), where: 'you delete one character', text: '>=   →   >'},
      {at: at(11.0), until: at(12.4), where: 'you save', text: ':w'},
      {at: at(45.6), until: at(47.6), where: 'you save', text: ':w'},
    ],
    cams: [
      {at: at(9.4), box: G(0, 10, 100, 13)},
      {at: at(12.2), box: G(0, 30, 200, 19)},
      {at: at(30.7), box: G(0, 12, 120, 10)},
      {at: at(38.7), box: G(0, 12, 120, 11)},
      {at: at(46.4), box: G(100, 34, 100, 15)},
    ],
    spots: [
      {at: at(2.4), until: at(5.4), box: G(0, 41, 200, 3), label: 'Pair’s pane: go test, after each save', place: 'above'},
      {at: at(5.6), until: at(9.4), box: G(150, 48, 42, 1), label: '✗ the delivery test fails', place: 'above'},
      {at: at(12.8), until: at(30.6), box: G(150, 48, 42, 1), label: '✗ TestNoDoubleDelivery: it passed before your change', place: 'above'},
      {at: at(31.4), until: at(38.6), box: G(4, 17, 116, 3), label: 'why, under your line', place: 'below'},
      {at: at(39.4), until: at(44.0), box: G(4, 16.5, 100, 4), label: 'the fix: old line struck through, new lines under it', place: 'below'},
      {at: at(46.8), box: G(140, 48, 52, 1), label: '✓ the tests pass again', place: 'above'},
    ],
    keys: [{at: at(38.6), keys: ['Alt', 'J'], note: 'go to the fix'}, {at: at(44.0), keys: ['Alt', 'Y'], note: 'take it'}],
    compare: {
      at: at(55.1),
      before: {clip: 't-tests-on-save', t: 40, box: G(0, 13, 118, 9), label: 'before: Pair’s suggestion, not in your file'},
      after: {clip: 't-tests-on-save', t: 50, box: G(0, 13, 118, 9), label: 'after Alt-Y: in your buffer, saved with :w'},
    },
    sum: 'Pair ran the tests you might skip, caught a regression, and showed its fix before you took it.',
  },

  {chapter: 6},
  {
    id: 'notes', ch: 6, title: 'Notes in the margin', pad: 1.2,
    card: {situation: 'You are writing a design note, not code yet.', watch: 'the margin of the note', area: ['nvim']},
    shots: [
      {clip: 't-notes', from: 0, to: 6},
      {clip: 't-notes', from: 6, to: 15.4, rate: 3, badge: 'Pair reads the note'},
      {clip: 't-notes', from: 15.4, to: 43.6},
      {clip: 't-notes', from: 43.6, to: 56},
    ],
    say: [
      {at: 'card', text: 'You are writing a design note, not code yet. Watch the margin of the note.'},
      {at: at(1.2), text: 'You finish a sentence about dead letters, and stop to think.'},
      {at: at(6.4), text: 'When you stop, Pair reads the whole note, and the code it names.'},
      {at: at(15.6), text: 'Its notes land in the margin, each with a sign. A question mark is a question the note leaves open.'},
      {at: 0.5, text: 'The not-equal sign marks two lines that can’t both be true: five attempts here, six there.'},
      {at: 0.5, text: 'The arrow says what the code really does. Here, the note is wrong about worker dot go.'},
      {at: 0.5, text: 'Nothing in the note changed. The marks are only in the margin.'},
      {at: at(44.0), text: 'When you are ready to build, Pair tasks lists the work the note asks for. Nothing is added until you say so.'},
    ],
    typed: [
      {at: at(1.6), until: at(3.6), where: 'you finish the sentence', text: '…still gets the webhook.'},
      {at: at(43.8), until: at(46.2), where: 'you type', text: ':Pair tasks'},
    ],
    cams: [
      {at: at(0.4), box: G(0, 15, 110, 9)},
      {at: at(6.0), box: null},
      {at: at(15.6), box: G(0, 0, 130, 34)},
      {at: {line: 4}, box: G(0, 12, 120, 11)},
      {at: {line: 5}, box: G(0, 1, 130, 6)},
      {at: {line: 6}, box: G(0, 0, 130, 34)},
      {at: at(43.6), box: null},
      {at: at(46.4), box: G(56, 12, 92, 24)},
    ],
    spots: [
      {at: at(1.8), until: at(6.0), box: G(2, 19, 60, 2), label: 'the paragraph you just finished', place: 'below'},
      {at: {line: 3, plus: 2.4}, until: {line: 4}, box: G(0, 11, 125, 1), label: '? an open question', place: 'below'},
      {at: {line: 4, plus: 0.4}, until: {line: 5}, box: G(0, 16, 100, 1), label: '≠ line 14 and line 20 disagree', place: 'below'},
      {at: {line: 5, plus: 0.4}, until: {line: 6}, box: G(0, 4, 130, 1), label: '→ what worker.go really returns', place: 'below'},
      {at: at(46.8), box: G(60, 13, 82, 22), label: 'the tasks, each with its lines', place: 'below', dim: false},
    ],
    sum: 'Pair read the note like a colleague: questions, contradictions, facts, in the margin.',
  },
  {
    id: 'blank-page', ch: 6, title: 'The blank page', pad: 1.4,
    card: {situation: 'An empty folder, and an idea. No code yet.', watch: 'the note, under your last line', area: ['nvim']},
    shots: [
      {clip: 't-blank-page', from: 0, to: 17.4},
      {clip: 't-blank-page', from: 17.4, to: 24.4, rate: 2, badge: 'you answer'},
      {clip: 't-blank-page', from: 24.4, to: 29},
      {clip: 't-blank-page', from: 29, to: 49.6, rate: 6, badge: 'you think'},
      {clip: 't-blank-page', from: 49.6, to: 56.0, rate: 2, badge: 'you answer'},
      {clip: 't-blank-page', from: 56.0, to: 60},
      {clip: 't-blank-page', from: 60, to: 79.4, rate: 6, badge: 'you think'},
      {clip: 't-blank-page', from: 79.4, to: 85.8, rate: 2, badge: 'you answer'},
      {clip: 't-blank-page', from: 85.8, to: 89.0, rate: 2, badge: 'Pair writes the slice'},
      {clip: 't-blank-page', from: 89.0, to: 100.8},
    ],
    say: [
      {at: 'card', text: 'An empty folder, and an idea. No code yet. Watch the note, under your last line.'},
      {at: at(4.6), text: 'Pair new, and one sentence: what you want to try.'},
      {at: at(14.4), text: 'Pair starts a note with your idea, and asks one question under it.'},
      {at: at(17.6), text: 'You answer on the next line, in a few words.'},
      {at: at(26.6), text: 'Each answer brings the next question, one at a time. Here, how the stall happens.'},
      {at: at(57.2), text: 'And whether to cap the steps. Three short answers are enough.'},
      {at: at(89.2), text: 'Then Pair suggests a first slice, dimmed, under your answers: what to build first, what it prints, and what to leave out for now.'},
      {at: at(95.6), text: 'Alt Y takes it into the note. Nothing is written to disk until you save.'},
    ],
    typed: [
      {at: at(5.4), until: at(13.0), where: 'you type', text: ':Pair new a tiny C toy with a Makefile, to see how a fixed-timestep loop catches up after a stall'},
    ],
    cams: [
      {at: at(13.4), box: G(0, 0, 105, 10)},
      {at: at(89.2), box: G(0, 0, 120, 31)},
      {at: at(97.0), box: G(0, 0, 120, 24)},
    ],
    spots: [
      {at: at(15.4), until: at(17.6), box: G(4, 2, 82, 1), label: 'Pair’s first question', place: 'below'},
      {at: at(27.0), until: at(29), box: G(4, 3, 72, 1), label: 'the next question', place: 'below'},
      {at: at(57.6), until: at(60), box: G(4, 4, 80, 1), label: 'the last question', place: 'below'},
      {at: at(89.8), until: at(95.4), box: G(0, 6, 110, 20), label: 'the first slice, a suggestion: not in the note yet', place: 'above'},
    ],
    keys: [{at: at(95.6), keys: ['Alt', 'Y'], note: 'take it'}],
    sum: 'Three questions, three short answers, and a first slice small enough to start.',
  },
  {chapter: 7},
  {
    id: 'hand-over', ch: 7, title: 'Hand Pair the wheel', pad: 1.4,
    card: {situation: 'You want edge cases added to a table test, and you’d rather watch.', watch: 'your code, and the statusline', area: ['nvim', 'status']},
    shots: [
      {clip: 't-hand-over', from: 0, to: 8.4},
      {clip: 't-hand-over', from: 8.4, to: 12.0, rate: 2, badge: 'Pair reads'},
      {clip: 't-hand-over', from: 12.0, to: 30.6},
    ],
    say: [
      {at: 'card', text: 'You want edge cases added to a table test, and you’d rather watch. Watch your code, and the statusline.'},
      {at: at(1.8), text: 'You hand over with Pair drive, and say what you want.'},
      {at: at(8.2), text: 'Pair is the Driver now. The statusline says it has the wheel. It reads the test and the code first.'},
      {at: at(12.1), text: 'Then it types, into your buffer, where you can see every line arrive.'},
      {at: at(16.4), text: 'It runs the tests on the unsaved buffer, in its own pane at the bottom, and hands the wheel back with a short note.'},
      {at: at(23.0), text: 'Nothing is saved yet. U takes the whole change away in one step, and control R brings it back.'},
    ],
    typed: [{at: at(1.8), until: at(7.6), where: 'you type', text: ':Pair drive add edge cases to this table: 0, 2, 7, 64'}],
    cams: [
      {at: at(8.2), box: G(130, 44, 70, 5)},
      {at: at(11.8), box: G(0, 5, 120, 18)},
      {at: at(16.8), box: null},
    ],
    spots: [
      {at: at(8.6), until: at(11.8), area: 'pair', label: '◎ pair has the wheel', place: 'above'},
      {at: at(12.6), until: at(16.6), box: G(4, 15, 80, 5), label: 'typed by Pair, unsaved', place: 'below'},
      {at: at(17.0), until: at(19.0), box: G(120, 48, 80, 1), label: '✓ the tests, on the unsaved buffer', place: 'above'},
      {at: at(19.2), until: at(23.0), box: G(136, 37, 64, 4), label: 'the hand-back note', place: 'above'},
    ],
    keys: [{at: at(24.5), keys: ['u'], note: 'undo it all'}, {at: at(27.5), keys: ['Ctrl', 'R'], note: 'and back'}],
    compare: {
      at: at(30.6),
      before: {clip: 't-hand-over', t: 6, box: G(0, 7, 100, 14), label: 'before: one case'},
      after: {clip: 't-hand-over', t: 21, box: G(0, 7, 100, 14), label: 'after: typed by Pair, one undo step'},
    },
    sum: 'Pair typed one change in plain sight, tested it, and gave the wheel back.',
  },
  {
    id: 'take-back', ch: 7, title: 'Take the wheel back', pad: 1.4,
    card: {situation: 'Pair is typing, and you change your mind.', watch: 'the lines it types, and the chat', area: ['nvim', 'chat']},
    shots: [{clip: 't-take-back', from: 0, to: 20.6}],
    say: [
      {at: 'card', text: 'Pair is typing, and you change your mind. Watch the lines it types, and the chat.'},
      {at: at(1.6), text: 'The same hand-over as before.'},
      {at: at(10.8), text: 'Pair starts typing the cases.'},
      {at: at(13.4), text: 'You press any key. The typing stops, and what it typed is gone, as if it never started.'},
      {at: 0.3, text: 'The chat says you have the wheel back, and Pair is the Navigator again.'},
    ],
    typed: [
      {at: at(1.8), until: at(7.6), where: 'you type', text: ':Pair drive add edge cases to this table: 0, 2, 7, 64'},
      {at: at(13.4), until: at(15.2), where: 'you press', text: 'j'},
    ],
    cams: [
      {at: at(10.6), box: G(0, 5, 100, 14)},
      {at: at(15.6), box: G(120, 26, 80, 22)},
    ],
    spots: [
      {at: at(11.2), until: at(13.45), box: G(6, 15, 70, 4), label: 'Pair, typing', place: 'below', dim: false},
      {at: at(13.6), until: at(15.4), box: G(6, 15, 70, 4), label: 'gone', place: 'below', dim: false},
      {at: at(16.0), box: G(136, 34.5, 64, 3), label: 'the wheel is yours again', place: 'above'},
    ],
    sum: 'Any key takes the wheel back, and nothing Pair typed stays behind.',
  },
  {chapter: 8},
  GEN_SHAPES,
  {
    id: 'gen-here', ch: 8, title: 'Code at your cursor', pad: 1.4,
    card: {situation: 'You want a small method, right under your cursor.', watch: 'the gen card in the chat, then your code', area: ['chat', 'nvim']},
    shots: [
      {clip: 't-gen-here', from: 1.6, to: 11.0},
      {clip: 't-gen-here', from: 11.0, to: 20.4, rate: 3, badge: 'Pair writes the code'},
      {clip: 't-gen-here', from: 20.4, to: 41.6},
    ],
    say: [
      {at: 'card', text: 'You want a small method, right under your cursor. Watch the gen card in the chat, then your code.'},
      {at: at(2.0), text: 'In the chat, slash gen here, and what you want. Your cursor in Neovim says where it goes.'},
      {at: at(20.6), text: 'The request gets a number, and runs on its own. Its card shows the code as a diff, with its keys, and Neovim shows it as ghost lines under your cursor.'},
      {at: at(27.2), text: 'Alt up picks the card, and K keeps it: the code lands in your buffer, unsaved, as one undo step, and the tests run on it.'},
      {at: at(32.6), text: 'The thin bar in the sign column marks code that is not yours yet. It stays until you edit it, or say Pair own.'},
      {at: at(36.4), text: 'Slash undo takes the whole request back, in one step.'},
    ],
    typed: [
      {at: at(2.0), until: at(10.6), where: 'in the chat', text: '/gen here a Total method on Backoff: the sum of the waits before attempt n, no new imports'},
      {at: at(36.2), until: at(38.6), where: 'then', text: '/undo'},
    ],
    cams: [{at: at(20.5), box: null}, {at: at(32.4), box: G(0, 22, 70, 14)}, {at: at(37.0), box: null}],
    spots: [
      {at: at(21.0), until: at(24.2), box: G(136, 4, 64, 30), label: 'the gen card: the code as a diff', place: 'below', dim: false},
      {at: at(24.4), until: at(27.0), box: G(2, 26, 130, 9), label: 'ghost lines: not in your file yet', place: 'above'},
      {at: at(30.4), until: at(32.4), box: G(136, 34, 64, 2), label: '✓ taken, and tested', place: 'above'},
      {at: at(32.8), until: at(36.2), box: G(0, 26, 3, 9), label: '┊ not yours yet', place: 'above', dim: false},
      {at: at(39.4), box: G(136, 40, 64, 4), label: 'undone: gen #1, in one step', place: 'above'},
    ],
    keys: [{at: at(27.2), keys: ['Alt', '↑'], note: 'pick the card'}, {at: at(29.6), keys: ['k'], note: 'keep it'}],
    sum: 'Asked for, kept with one key, marked until you own it, undone in one step.',
  },
  {
    id: 'gen-brief', ch: 8, title: 'The brief', pad: 1.4,
    card: {situation: 'NOTES.md says logs go through slog. You ask for fmt.Printf.', watch: 'the question in the chat', area: ['chat']},
    shots: [
      {clip: 't-gen-here', from: 41.6, to: 56.4},
      {clip: 't-gen-here', from: 56.4, to: 71.0, rate: 4, badge: 'Pair writes the code'},
      {clip: 't-gen-here', from: 71.0, to: 77.0},
    ],
    say: [
      {at: 'card', text: 'Your notes say logs go through slog, and you ask for f m t dot printf. Watch the question in the chat.'},
      {at: at(41.8), text: 'Every request runs against the brief: the session’s goal and your notes, NOTES dot md by default. Pair reads it, and never edits it.'},
      {at: at(49.6), text: 'This request goes against a line of it, so Pair asks first, and quotes the line. Y goes as asked, N follows the brief, and E opens the note there.'},
      {at: at(56.6), text: 'You press N. The code follows the brief: slog, not printf. And the card says where it went against your words.'},
    ],
    typed: [{at: at(42.0), until: at(48.2), where: 'in the chat', text: '/gen here log each wait in Next with fmt.Printf instead of slog'}],
    cams: [{at: at(49.0), box: G(128, 14, 72, 34)}, {at: at(71.0), box: null}],
    spots: [
      {at: at(50.0), until: at(55.4), box: G(136, 38.4, 64, 4.6), label: 'the brief’s line, quoted: as asked, or follow it?', place: 'above'},
      {at: at(71.4), box: G(0, 0, 130, 34), label: 'the code: slog, as the brief says', place: 'below', dim: false},
    ],
    keys: [{at: at(55.5), keys: ['n'], note: 'follow the brief'}],
    sum: 'Your notes are the brief: Pair asks before it goes against them.',
  },
  {
    id: 'gen-file', ch: 8, title: 'New files', pad: 1.4,
    card: {situation: 'You want a new test file.', watch: 'the gen card, then Neovim', area: ['chat', 'nvim']},
    shots: [
      {clip: 't-gen-file', from: 2.6, to: 9.4},
      {clip: 't-gen-file', from: 9.4, to: 31.4, rate: 4, badge: 'Pair writes and checks'},
      {clip: 't-gen-file', from: 31.4, to: 55.1},
    ],
    say: [
      {at: 'card', text: 'You want a new test file. Watch the gen card, then Neovim.'},
      {at: at(3.0), text: 'Slash gen file asks for new files.'},
      {at: at(31.8), text: 'It comes back as a buffer to review, and nothing is on disk yet. Its check ran your tests with it: here, the new test fails, and the card says why. Schedule overflows past thirty attempts.'},
      {at: at(40.4), text: 'K opens the file in Neovim. Its winbar says it is generated, and that colon w takes it.'},
      {at: at(49.4), text: 'Colon w writes it to its path: your own save is the one way Pair’s code reaches your disk. The tests run, and the bar marks lines that are not yours yet.'},
    ],
    typed: [
      {at: at(2.8), until: at(8.6), where: 'in the chat', text: '/gen file internal/retry/schedule_test.go, a table test for Schedule'},
      {at: at(49.0), until: at(51.0), where: 'in the file', text: ':w'},
    ],
    cams: [{at: at(31.6), box: G(128, 0, 72, 36)}, {at: at(40.2), box: G(0, 0, 130, 34)}, {at: at(50.0), box: null}],
    spots: [
      {at: at(32.2), until: at(36.0), box: G(140, 0, 64, 12), label: '✗ its check: the new test fails, and why', place: 'below'},
      {at: at(36.2), until: at(40.0), box: G(140, 13, 60, 16), label: 'one new file, to review', place: 'above'},
      {at: at(40.8), until: at(48.8), box: G(0, 0, 60, 1), label: 'generated · :w takes it', place: 'below'},
      {at: at(51.0), box: G(150, 48, 50, 1), label: 'saved: the tests run on it', place: 'above'},
    ],
    keys: [{at: at(37.6), keys: ['Alt', '↑'], note: 'pick the card'}, {at: at(40.1), keys: ['k'], note: 'open it'}],
    sum: 'New files arrive as buffers to review; your :w takes them.',
  },
  {
    id: 'gen-try', ch: 8, title: 'A sample to try', pad: 1.4,
    card: {situation: 'You want to see an idea run before it touches your project.', watch: 'the split, then the chat', area: ['nvim', 'chat']},
    shots: [
      {clip: 't-gen-try', from: 1.6, to: 8.4},
      {clip: 't-gen-try', from: 8.4, to: 26.8, rate: 4, badge: 'Pair writes the sample'},
      {clip: 't-gen-try', from: 26.8, to: 49.8},
    ],
    say: [
      {at: 'card', text: 'You want to see an idea run before it touches your project. Watch the split, then the chat.'},
      {at: at(2.0), text: 'Slash gen try writes a sample in a folder of its own, outside the project.'},
      {at: at(27.0), text: 'Pair runs it in its pane, in a sandbox: only that folder is writable, and there is no network.'},
      {at: at(31.0), text: 'The sample opens in a split, as a real file. Change it, and the run key runs it again. The card says how its run went.'},
      {at: at(39.2), text: 'Slash keep moves it into the project, as a buffer to review.'},
    ],
    typed: [
      {at: at(1.8), until: at(7.6), where: 'in the chat', text: '/gen try how context.WithTimeout stops a retry loop, in 30 lines'},
      {at: at(39.0), until: at(42.2), where: 'then', text: '/keep cmd/trytimeout/main.go'},
    ],
    cams: [{at: at(27.0), box: null}, {at: at(31.0), box: G(128, 0, 72, 31)}, {at: at(42.4), box: G(128, 0, 72, 36)}],
    spots: [
      {at: at(31.6), until: at(35.4), box: G(136, 15, 64, 15), label: 'the try’s winbar: outside the project · \\r runs it', place: 'above'},
      {at: at(35.6), until: at(39.0), box: G(136, 0, 64, 12), label: 'how its run went, and how to take it', place: 'below'},
      {at: at(42.8), box: G(136, 12, 64, 1), label: 'kept: a buffer to review, :w takes it', place: 'below'},
    ],
    sum: 'Try it outside the project; /keep moves in what you want.',
  },
  {
    id: 'gen-scaffold', ch: 8, title: 'Many files: a scaffold', pad: 1.4,
    card: {situation: 'You want a small command and its test, wired to your code.', watch: 'the gen card', area: ['chat']},
    shots: [
      {clip: 't-gen-scaffold', from: 2.4, to: 12.0},
      {clip: 't-gen-scaffold', from: 12.0, to: 39.8, rate: 4, badge: 'Pair builds and tests it'},
      {clip: 't-gen-scaffold', from: 39.8, to: 61.3},
    ],
    say: [
      {at: 'card', text: 'You want a small command and its test, wired to your code. Watch the gen card.'},
      {at: at(2.8), text: 'Slash gen scaffold builds many files and their wiring away from your project. With dash dash branch, in a git worktree, on a branch of its own.'},
      {at: at(40.0), text: 'Pair wrote it, built it and ran the tests there. The card lists every file, new or changed, how the check went, and what it guessed.'},
      {at: at(47.8), text: 'K puts slash keep on the line, with the scaffold’s files in a menu. Enter keeps one, as a buffer to review. No key keeps them all: you read each one.'},
    ],
    typed: [{at: at(2.6), until: at(11.0), where: 'in the chat', text: '/gen scaffold --branch a cmd/schedule command that prints the waits for -base -max -n, using retry.Backoff, with a test'}],
    cams: [{at: at(39.9), box: G(128, 0, 72, 36)}, {at: at(53.8), box: G(128, 0, 72, 36)}],
    spots: [
      {at: at(40.6), until: at(44.2), box: G(140, 13, 60, 4), label: 'in a worktree, on the branch gen/1', place: 'above'},
      {at: at(44.4), until: at(47.6), box: G(140, 17, 60, 7), label: 'the check, the files, what it guessed', place: 'above'},
      {at: at(51.0), until: at(53.6), box: G(136, 27, 64, 6), label: '/keep, and the files left to keep', place: 'above'},
      {at: at(54.4), box: G(136, 26, 64, 6), label: 'kept: a buffer to review, :w takes it', place: 'below'},
    ],
    keys: [{at: at(47.9), keys: ['Alt', '↑'], note: 'pick the card'}, {at: at(50.4), keys: ['k'], note: 'keep one'}, {at: at(53.4), keys: ['Enter']}],
    sum: 'A scaffold is built aside; you keep it a file at a time.',
  },
  {chapter: 9},
  {
    id: 'board-handoff', ch: 9, title: 'Hand it to the board', pad: 1.4,
    card: {situation: 'Some work is too big to watch: it should be another agent’s task.', watch: 'the chat', area: ['chat']},
    shots: [{clip: 't-board', from: 2.6, to: 20.0}],
    say: [
      {at: 'card', text: 'Some work is too big to watch: it should be another agent’s task. Watch the chat.'},
      {at: at(3.0), text: 'Slash gen board hands it to the board, Shepherdr, as a task.'},
      {at: at(8.0), text: 'No model runs. Pair writes the task’s brief from yours, and shows the whole command before anything is added.'},
      {at: 0.4, text: 'Each pick is one key. Y adds it for later, and D adds it and delegates it. P asks for a plan first, R for research only, and C copies the command.'},
      {at: at(15.0), text: 'You press D. The board adds the task, and its agent starts on the brief.'},
    ],
    typed: [
      {at: at(3.0), until: at(6.8), where: 'in the chat', text: '/gen board a dead-letter replay command'},
      {at: {line: 3, plus: 0.2}, until: at(14.8), where: 'the picks', text: 'y add · d add and delegate · p plan first · r research · c copy · n nothing'},
    ],
    cams: [{at: at(7.6), box: G(128, 12, 72, 24)}],
    spots: [
      {at: at(8.4), until: at(14.8), box: G(140, 17, 60, 14), label: 'the task, and the whole command', place: 'above'},
      {at: at(15.4), box: G(136, 32, 64, 2), label: 'added, and delegated', place: 'above'},
    ],
    keys: [{at: at(14.9), keys: ['d'], note: 'add and delegate'}],
    sum: 'One request, one key: a task for another agent.',
  },
  {
    id: 'board-news', ch: 9, title: 'News from other agents', pad: 1.4,
    card: {situation: 'While you work, another agent finishes its task.', watch: 'the statusline and the chat, when you save', area: ['status', 'chat']},
    shots: [{clip: 't-board', from: 20.0, to: 56.4}],
    say: [
      {at: 'card', text: 'While you work, another agent finishes its task. Watch the statusline and the chat, when you save.'},
      {at: at(21.6), text: 'You type, and Pair holds the news: it never speaks while you type.'},
      {at: at(28.4), text: 'You save, a breakpoint, and one line says it: in the statusline, and in the chat, with its keys.'},
      {at: at(36.6), text: 'Pair agents lists every task, the ones that need you first. O opens its report or pull request, and D its branch’s diff, read only.'},
      {at: at(47.2), text: 'And T opens a terminal in its worktree.'},
    ],
    typed: [
      {at: at(22.0), until: at(27.4), where: 'you type', text: '// a webhook out of budget is parked as a dead letter'},
      {at: at(36.4), until: at(38.4), where: 'you type', text: ':Pair agents'},
    ],
    cams: [{at: at(28.6), box: null}, {at: at(37.6), box: G(0, 32, 140, 17)}, {at: at(41.4), box: G(0, 22, 150, 27)}, {at: at(54.0), box: null}],
    spots: [
      {at: at(29.6), until: at(33.4), box: G(52, 48, 120, 1), label: 'one line, at your pause', place: 'above'},
      {at: at(33.6), until: at(36.4), box: G(136, 15, 64, 2), label: 'and in the chat: o open · d diff · t terminal', place: 'below'},
      {at: at(38.6), until: at(40.8), box: G(0, 46.6, 110, 2.6), label: 'every task, the ones that need you first: #24 is the one you just handed over', place: 'above'},
      {at: at(41.8), until: at(46.6), box: G(0, 36.6, 150, 12), label: 'd: its branch’s diff, read only', place: 'above'},
      {at: at(48.4), until: at(54.0), box: G(0, 36.6, 140, 3), label: 't: a terminal in its worktree', place: 'above'},
    ],
    keys: [{at: at(40.4), keys: ['d'], note: 'diff'}, {at: at(47.4), keys: ['t'], note: 'terminal'}],
    sum: 'Other agents’ news waits for your pause, with keys to what they left.',
  },
  {
    id: 'board-review', ch: 9, title: 'Review a task', pad: 1.4,
    card: {situation: 'A task is ready to merge. Read it before it lands.', watch: 'the review list', area: ['nvim']},
    shots: [{clip: 't-board', from: 56.4, to: 76.6}],
    say: [
      {at: 'card', text: 'A task is ready to merge. Read it before it lands. Watch the review list.'},
      {at: at(56.8), text: 'Alt R, on the line of a task ready to merge, opens its branch as a review. Pair review, and the task, does the same.'},
      {at: at(60.6), text: 'On top, what its reviewer said, and what is not proven. Then what the branch guessed that your brief does not settle.'},
      {at: at(69.4), text: 'Then its files. K keeps one in your checkout, unsaved and marked, for you to make your own.'},
    ],
    cams: [{at: at(57.6), box: G(0, 30, 130, 19)}],
    spots: [
      {at: at(61.0), until: at(65.0), box: G(0, 37.6, 120, 3.2), label: 'the reviewer, the agent, and what is not proven', place: 'above'},
      {at: at(65.2), until: at(69.2), box: G(0, 40.6, 120, 3.2), label: 'what it guessed, for you to settle', place: 'above'},
      {at: at(72.6), box: G(0, 47.6, 200, 2.2), label: 'kept: unsaved, marked not yours yet', place: 'above'},
    ],
    keys: [{at: at(56.9), keys: ['Alt', 'R'], note: 'review it'}, {at: at(72.0), keys: ['k'], note: 'keep the file'}],
    sum: 'Review a task’s branch, and keep the pieces you want.',
  },
  {
    id: 'overlap', ch: 9, title: 'When a task changes your file', pad: 1.4,
    card: {situation: 'Another agent is changing the file you have open.', watch: 'the top of the window, then under your line', area: ['nvim']},
    shots: [{clip: 't-overlap', from: 0, to: 17.4}],
    say: [
      {at: 'card', text: 'Another agent is changing the file you have open. Watch the top of the window, then under your line.'},
      {at: at(0.3), text: 'Each task’s agent works in its own worktree, and Pair reads what its branch changes. The winbar says this file is one of them.'},
      {at: at(4.8), text: 'You change the same line, and save.'},
      {at: at(11.2), text: 'Pair says what the other task writes there, and that whichever merges second meets a conflict. The chat has it too.'},
    ],
    typed: [{at: at(4.6), until: at(6.6), where: 'you change line 35, and save', text: '>=   →   >'}],
    cams: [{at: at(0.2), box: G(0, 0, 110, 14)}, {at: at(4.6), box: G(0, 18, 120, 14)}, {at: at(15.0), box: null}],
    spots: [
      {at: at(0.8), until: at(4.6), box: G(0, 0, 76, 1), label: 'the winbar: HKD-8 is changing this file', place: 'below'},
      {at: at(11.6), until: at(15.0), box: G(6, 25, 104, 3), label: 'what HKD-8 writes on this line', place: 'below'},
      {at: at(15.2), box: G(136, 23, 64, 9), label: 'overlap, in the chat', place: 'above'},
    ],
    sum: 'Pair tells you before two agents’ changes collide.',
  },
  {
    id: 'brief-sync', ch: 9, title: 'Keep the task in step', pad: 1.4,
    card: {situation: 'Your notes moved on since your task’s brief was written.', watch: 'the chat', area: ['chat']},
    shots: [{clip: 't-overlap', from: 17.4, to: 32.8}],
    say: [
      {at: 'card', text: 'Your notes moved on since your task’s brief was written. Watch the chat.'},
      {at: at(18.8), text: 'You work on a board task’s branch. Slash brief sync says what the task’s brief on the board lacks from NOTES dot md.'},
      {at: at(24.0), text: 'Y tells the task’s agent, C copies the command, and N leaves it.'},
    ],
    typed: [{at: at(17.6), until: at(20.0), where: 'in the chat', text: '/brief sync'}],
    cams: [{at: at(18.7), box: G(128, 5, 72, 31)}],
    spots: [
      {at: at(20.6), until: at(24.0), box: G(136, 16, 64, 9), label: 'what HKD-7’s brief lacks', place: 'below'},
      {at: at(24.2), until: at(28.6), box: G(136, 25, 64, 8), label: 'the message to its agent', place: 'above'},
      {at: at(29.2), box: G(136, 31, 64, 1), label: 'told', place: 'above'},
    ],
    keys: [{at: at(28.6), keys: ['y'], note: 'tell its agent'}],
    sum: '/brief sync keeps the board’s task in step with your notes.',
  },
  {chapter: 10},
  WORKTREES,
  {chapter: 11},
  {
    id: 'voice', ch: 11, title: 'Push-to-talk', pad: 1.6,
    card: {situation: 'Your hands are on the code, and a question comes up.', watch: 'the line under your cursor', area: ['nvim']},
    shots: [{clip: 't-push-to-talk', from: 0, to: 24}],
    say: [
      {at: 'card', text: 'Your hands are on the code, and a question comes up. Watch the line under your cursor.'},
      {at: at(1.0), text: 'Hold Alt T, and ask out loud. The meter shows Pair hears you.'},
      {at: at(5.8), text: 'Let go, and whisper dot c p p writes down what it heard, on your own machine. That is your question, under your line.'},
      {at: at(11.2), text: 'Then Pair answers in the same place, and marks line thirty-five. Alt J would go there.'},
    ],
    cams: [
      {at: at(1.6), box: G(0, 13, 110, 9)},
      {at: at(10.8), box: G(0, 13, 120, 12)},
    ],
    spots: [
      {at: at(2.2), until: at(5.8), box: G(14, 18, 44, 1), label: 'listening, while you hold the key', place: 'below'},
      {at: at(7.0), until: at(10.8), box: G(14, 18, 60, 1), label: 'what whisper.cpp heard', place: 'below'},
      {at: at(13.2), box: G(14, 18, 106, 3), label: 'the answer, where you asked', place: 'below'},
    ],
    keys: [{at: at(2), keys: ['Alt', 'T'], note: 'hold, and ask', hold: 4}],
    sum: 'You asked out loud; the answer came where you were looking. Voice is off until you set it up.',
    sumSay: 'You asked out loud, and the answer came where you were looking. Voice is off until you set it up.',
  },
  OPENROUTER,
  {chapter: 12},
  {
    id: 'herdr', kind: 'panel', ch: 12, min: 4,
    panel: `<h1 class="r0">With or without herdr</h1>
      <div class="herdr">
        <div class="herdr-c r1"><div class="herdr-h">Without herdr</div>
          ${map([['your code', 2, 3, 64, 62], ['your terminal', 2, 68, 64, 14], ['Pair’s chat', 68, 3, 30, 79], ['Pair’s pane', 2, 85, 96, 11]], ['Pair’s chat', 'Pair’s pane'])}
          <div class="herdr-t">One Neovim holds it all: <b>:Pair chat</b> opens the chat, and Pair’s pane is a <b>:terminal</b>. Every scene in this tutorial ran this way.</div></div>
        <div class="herdr-c r2"><div class="herdr-h">With herdr</div>
          ${map([['Neovim', 2, 3, 47, 58], ['Pair’s chat', 51, 3, 47, 58], ['your shell', 2, 64, 47, 32], ['Pair’s pane', 51, 64, 47, 32]], ['Pair’s chat', 'Pair’s pane'])}
          <div class="herdr-t">The chat and Pair’s pane are herdr panes. Pair also sees herdr’s agents, and terminals outside Neovim.</div></div>
      </div>`,
    reveal: [0.2, {line: 1}, {line: 3}],
    say: [
      {at: 0.5, text: 'Pair works with or without herdr, the terminal workspace for coding agents.'},
      {at: 0.3, text: 'Without it, one Neovim holds everything. Pair chat opens the chat, and Pair’s own pane is a terminal at the bottom.'},
      {at: 0.3, text: 'Every scene you just saw ran this way.'},
      {at: 0.3, text: 'With herdr, the chat and Pair’s pane are panes of their own. Pair also sees the agents herdr runs, and terminals outside Neovim.'},
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
      {at: 0.5, text: 'Here are the keys to remember. Alt J goes where Pair points, and Alt Y takes its suggested change. In the chat, Alt up picks a message, to act on it. Slash gen here asks for code, and slash undo takes it back. Pair drive hands over one change, and any key takes the wheel back. Pair agents shows your other agents, and Alt R reviews a task. Hold Alt T to ask out loud, and run pair doctor whenever something seems off.'},
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
      {clip: 't-wrong-turn', from: 10, to: 15.6},
      {clip: 't-wrong-turn', from: 15.6, to: 22.6, rate: 4, badge: 'Pair thinks'},
      {clip: 't-wrong-turn', from: 22.6, to: 27.4},
      {clip: 't-wrong-turn', from: 29.4, to: 34.4},
    ],
    say: [
      {at: 'card', text: 'You edit the wrong file while a test is red. Watch the margin.'},
      {at: at(10.6), text: 'You change the backoff.'},
      {at: at(22.8), text: 'Pair speaks once, under your line. The real cause is in worker dot go.'},
      {at: at(29.6), text: 'Alt J goes there.'},
    ],
    cams: [
      {at: at(10), box: G(0, 12, 120, 14), cut: true},
      {at: at(22.7), box: G(0, 15, 112, 9)},
      {at: at(30.0), box: null},
      {at: at(30.8), box: G(0, 11, 105, 12)},
    ],
    spots: [
      {at: at(11.4), until: at(15.4), box: G(4, 19, 28, 1), label: 'your change', place: 'below'},
      {at: at(23.2), until: at(27.4), box: G(4, 20.3, 108, 1.9), label: 'Pair’s words, under your line', place: 'below'},
      {at: at(31.4), box: G(6, 16.8, 112, 1.2), label: 'the real cause', place: 'below'},
    ],
    keys: [{at: at(29.9), keys: ['Alt', 'J']}],
    quietSum: true,
    sum: 'One remark, in the right place.',
  },
  {
    id: 'x-tests', title: 'It runs what you’d skip', pad: 1,
    card: {situation: 'You fix one line, and save.', watch: 'the statusline, then the ghost text', area: ['status', 'nvim']},
    shots: [
      {clip: 't-tests-on-save', from: 9.4, to: 12.4},
      {clip: 't-tests-on-save', from: 12.4, to: 30.6, rate: 8, badge: 'Pair thinks'},
      {clip: 't-tests-on-save', from: 30.6, to: 34},
      {clip: 't-tests-on-save', from: 38.4, to: 46.4},
      {clip: 't-tests-on-save', from: 46.4, to: 49},
    ],
    say: [
      {at: 'card', text: 'You fix one line, and save. Watch the statusline, then the ghost text.'},
      {at: at(9.6), text: 'Pair runs your tests on every save.'},
      {at: at(12.4), text: 'A test that passed before now fails.'},
      {at: at(38.6), text: 'Alt J shows Pair’s fix as ghost text: the old line struck through, the new ones under it.'},
      {at: at(44.0), text: 'Alt Y takes it. Save, and it’s green.'},
    ],
    cams: [
      {at: at(9.4), box: G(0, 10, 100, 13), cut: true},
      {at: at(12.2), box: null},
      {at: at(38.6), box: G(0, 12, 120, 11)},
      {at: at(46.4), box: G(100, 34, 100, 15), cut: true},
    ],
    spots: [
      {at: at(12.8), until: at(30.6), box: G(150, 48, 42, 1), label: '✗ a test that passed before', place: 'above'},
      {at: at(39.4), until: at(44.0), box: G(4, 16.5, 100, 4), label: 'Pair’s fix, not in your file yet', place: 'below'},
      {at: at(46.8), box: G(140, 48, 52, 1), label: '✓ green again', place: 'above'},
    ],
    keys: [{at: at(38.6), keys: ['Alt', 'J']}, {at: at(44.0), keys: ['Alt', 'Y']}],
    quietSum: true,
    sum: 'It runs the tests you would skip.',
  },
  {
    id: 'x-drive', title: 'It drives only when you ask', pad: 1,
    card: {situation: 'You hand Pair the wheel for one change.', watch: 'your code', area: ['nvim']},
    shots: [
      {clip: 't-hand-over', from: 1.6, to: 8.4},
      {clip: 't-hand-over', from: 8.4, to: 12.0, rate: 4, badge: 'Pair reads'},
      {clip: 't-hand-over', from: 12.0, to: 20.0},
      {clip: 't-hand-over', from: 23.6, to: 26.6},
    ],
    say: [
      {at: 'card', text: 'You hand Pair the wheel for one change. Watch your code.'},
      {at: at(1.8), text: 'Pair drive, and say what you want.'},
      {at: at(12.1), text: 'It types where you can see it, tests the unsaved buffer, and hands back.'},
      {at: at(23.8), text: 'U undoes it all, in one step.'},
    ],
    typed: [{at: at(1.8), until: at(7.6), where: 'you type', text: ':Pair drive add edge cases to this table: 0, 2, 7, 64'}],
    cams: [{at: at(11.8), box: G(0, 5, 120, 18)}],
    spots: [{at: at(12.6), until: at(16.6), box: G(4, 15, 80, 5), label: 'typed by Pair, unsaved', place: 'below'}],
    keys: [{at: at(24.5), keys: ['u'], note: 'undo it all'}],
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
