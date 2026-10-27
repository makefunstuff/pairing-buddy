// Builds index.html, the HyperFrames composition of the tour, from the scene list below (`node build.mjs short`:
// short.html, the cut for X).
// Each scene lasts as long as its voiceover (audio/<id>.mp3, from tts.mjs) plus `pad`; its shots are ranges of
// the captures in clips/ (from capture/run.sh), played at `rate`, and the last frame holds when they end early.
// Times inside a scene are in seconds from its start, or a cue: the time the voice says a word of narration.json
// (words.json, from words.mjs). Boxes are [x, y, w, h] in the clips' pixels (1920x1080), given with I() and P().
// Usage: node build.mjs [short]   (needs ffprobe and ffmpeg; writes index.html and captions.vtt, or short.html and
// captions-short.vtt, and frames/)
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const FRAME = {x: 200, y: 112, w: 1520, h: 855}; // where the captures sit on the 1920x1080 canvas
const VOICE_AT = 0.25; // the voice starts this long into its scene
const MUSIC = {from: 'chair', volume: 0.13}; // the bed comes in with the product, low under the voice
// `node build.mjs` builds the tour (index.html); `node build.mjs short` the 60-90 s cut for X (short.html).
const CUT = process.argv[2] === 'short' ? 'short' : 'tour';

// Boxes. The setup scenes (start.tape, install.tape) are 1920x1080 at font 28: I() takes terminal cells. The
// Neovim scenes are recorded by docs/captures at 1400x840 and placed by clips.sh at 1800x1080, 60 px from the
// left: P() takes a box in the recording's own pixels (as an OCR of out/<scene>.png gives it).
const I = (col, row, cols = 1, rows = 1) => [Math.round(19 + col * 16.83) - 6, Math.round(33 + row * 37.8) - 3, Math.round(cols * 16.83) + 12, Math.round(rows * 37.8) + 6];
const K = 1080 / 840;
const P = (x, y, w, h) => [Math.round(60 + (x - 5) * K), Math.round((y - 4) * K), Math.round((w + 10) * K), Math.round((h + 8) * K)];
const STATUS = P(14, 795, 1372, 21); // the statusline of a Neovim scene
const STATUS_RIGHT = P(640, 795, 746, 21); // its right half, where Pair's segment is
const BOTTOM = P(0, 560, 1400, 280); // the lower part of a Neovim scene, with the statusline

const CHAPTERS = {
  1: ['Getting started', 'install, a login, one model, a check'],
  2: ['Exploring code', 'Pair watches, reads, and points'],
  3: ['Tests, if you have them', 'it runs what you’d skip'],
  4: ['Notes and the blank page', 'thinking before the code'],
  5: ['Handing over', 'Pair types one change while you watch'],
  6: ['The day around it', 'what it did, who needs you, where to pick up'],
  7: ['And the rest', 'in a few seconds each'],
};

const TOUR = [
  {id: 'problem', kind: 'problem', pad: 0.8},
  {id: 'chair', kind: 'chair', pad: 0.7},
  {id: 'models', kind: 'models', pad: 2.4},

  {chapter: 1},
  {
    id: 'install', ch: 1, title: 'Install: two commands', pad: 1.4,
    shots: [
      {clip: 'install', from: 0.8, to: 4.6, rate: 1.5},
      {clip: 'install', from: 4.6, to: 18, rate: 8, badge: 'npm install · 8× speed'},
      {clip: 'install', from: 18, to: 27.5, rate: 2},
    ],
    zooms: [{at: 0, box: I(0, 0, 70, 4)}, {at: 4.3, box: I(0, 3, 112, 12)}],
    chips: [
      {at: 'npm', until: 'pair', text: 'npm install -g github:makefunstuff/pairing-buddy'},
      {at: 'pair', until: 7.6, text: 'pair setup'},
    ],
    marks: [
      {at: 8.3, until: 9.7, box: I(0, 5, 112, 2), label: 'the config, written from the example', below: true},
      {at: 9.7, box: I(0, 9, 92, 1), label: 'the daemon: Pair in the background, as a service', below: true},
    ],
  },
  {
    id: 'auth', ch: 1, title: 'pair auth: your logins and keys', pad: 0.8,
    shots: [{clip: 'start', from: 0.8, to: 11.5, rate: 1.25}],
    zooms: [{at: 0, box: I(0, 0, 100, 8)}],
    chips: [{at: 0.2, until: 'Choose', text: 'pair auth login anthropic'}],
    marks: [
      {at: 'Choose', until: 'type', box: I(0, 1, 50, 3), label: 'a subscription, or an API key', below: true},
      {at: 'never', box: I(0, 5, 112, 3), label: 'stored in auth.json, readable by you only, never printed', below: true},
    ],
  },
  {
    id: 'onemodel', ch: 1, title: 'One model can play both roles', pad: 0.8,
    shots: [{clip: 'start', from: 15.6, to: 20.4, rate: 0.6}],
    zooms: [{at: 0, box: I(0, 0, 95, 6)}],
    marks: [{at: 0.6, box: I(1, 3, 94, 2), label: '"model": one local model for the Watcher and the Partner', below: true}],
  },
  {
    id: 'doctor', ch: 1, title: 'pair doctor checks every part', pad: 0.9,
    shots: [{clip: 'start', from: 20.4, to: 31.4, rate: 1.4}],
    zooms: [{at: 0, box: I(0, 6, 90, 9)}, {at: 'thinks,', box: I(0, 12, 112, 10)}],
    marks: [
      {at: 1.2, until: 'thinks,', box: I(0, 12, 85, 1), label: 'herdr, a terminal workspace, is optional', below: true},
      {at: 'thinks,', until: 'sandbox', box: I(0, 17, 75, 3), label: 'the Partner thinks; one model serves both roles', above: true},
      {at: 'sandbox', box: I(0, 14, 64, 1), label: 'Pair’s commands run in a bubblewrap sandbox', above: true},
    ],
  },
  {id: 'roles', kind: 'roles', pad: 1},

  {chapter: 2},
  {
    id: 'red', ch: 2, title: 'A test is red', pad: 0.6,
    shots: [{clip: 'wrong-turn', from: 0, to: 8.4, rate: 1.15}],
    zooms: [{at: 0, box: P(0, 600, 900, 160)}, {at: 'you', box: P(0, 250, 1400, 340)}],
    marks: [
      {at: 'red,', until: 'you', box: P(3, 633, 860, 42), label: '✗ 4 attempts, where the test wants 5', above: true},
      {at: 'backoff', box: P(2, 443, 400, 24), label: 'you change the shift in backoff.go', below: true},
    ],
  },
  {
    id: 'reads', ch: 2, title: 'Pair reads the code first', pad: 0.6,
    shots: [{clip: 'wrong-turn', from: 8.4, to: 12.6, rate: 0.62}],
    zooms: [{at: 0, box: P(0, 420, 1400, 420)}],
    roles: [{at: 'Navigator,', glyph: '●', name: 'Navigator', text: 'Pair’s default role: it watches and points'}],
    marks: [
      {at: 'name', until: 'Navigator,', box: P(3, 633, 860, 42), label: 'the failure names worker_test.go, not backoff.go', above: true},
      {at: 'reads', box: STATUS_RIGHT, label: 'Pair reads backoff.go, then worker.go', above: true},
    ],
  },
  {
    id: 'words', ch: 2, title: 'Then it speaks, under your line', pad: 1,
    shots: [{clip: 'wrong-turn', from: 12.6, to: 16.2, rate: 0.5}],
    zooms: [{at: 0, box: P(0, 400, 1200, 160)}],
    quote: {at: 'speaks,', text: 'the shift is fine: 1s 2s 4s 8s, as the test wants. attempt 5 lands at exactly 15s, and worker.go:35 gives up on >=, one attempt early'},
    marks: [{at: 'speaks,', box: P(105, 466, 1040, 50), label: 'here, under the line you changed', below: true}],
  },
  {
    id: 'jump', ch: 2, title: 'Alt-J jumps to the cause', pad: 1.4,
    shots: [{clip: 'wrong-turn', from: 17.3, to: 20.2, rate: 0.66}],
    zooms: [{at: 0, box: P(0, 150, 1000, 260)}],
    keys: [{at: 0.4, keys: ['Alt', 'J'], note: 'M- is Alt: Pair writes it M-j'}],
    marks: [{at: 'exact', box: P(2, 280, 991, 23), label: '7s + 8s = 15s is inside the budget, but >= gives up', above: true}],
  },
  {
    id: 'trail', ch: 2, title: 'Searching in circles? The search trail', pad: 0.8,
    shots: [
      {clip: 'search-trail', from: 4.2, to: 15.6, rate: 3, badge: 'three searches · 3× speed'},
      {clip: 'search-trail', from: 19.5, to: 24.4},
    ],
    zooms: [{at: 0, box: null}, {at: 'where', box: P(0, 240, 1100, 120)}],
    marks: [{at: 'word.', box: P(68, 281, 1010, 72), label: 'its word: ErrBudget, and where it fires', below: true}],
  },
  {
    id: 'context', ch: 2, title: 'What Pair knows: the context card', pad: 0.9,
    shots: [{clip: 'context-card', from: 10.8, to: 16.9, rate: 0.75}],
    zooms: [{at: 0, box: null}, {at: 2.4, box: P(140, 30, 1130, 600)}],
    chips: [{at: 0, until: 2.3, text: ':Pair context'}],
    marks: [
      {at: 'goal', until: 'commands', box: P(140, 114, 830, 26), label: 'the goal, from your branch’s task on the herdr board, your task tracker', below: true},
      {at: 'commands', box: P(140, 396, 1110, 210), label: 'your commands, buffers, jumps and searches', above: true},
    ],
  },
  {
    id: 'crash', ch: 2, title: 'A crash and a compiler error', pad: 0.8,
    shots: [{clip: 'crash', from: 1.6, to: 6.4, rate: 0.9}, {clip: 'crash', from: 8.6, to: 16.6, rate: 1.6}],
    zooms: [{at: 0, box: P(0, 150, 1240, 340)}],
    marks: [
      {at: 'compiler', until: 'so', box: P(2, 233, 645, 24), label: 'a compiler error, on its line', below: true},
      {at: 'crash.', box: P(2, 373, 1200, 50), label: 'a crash found by AddressSanitizer, the compiler’s memory check, on its line', below: true},
    ],
  },
  {
    id: 'loop', ch: 2, title: 'The exploration loop: every run counts', pad: 0.8,
    shots: [{clip: 'loop', from: 0, to: 16.5, rate: 4, badge: 'three runs of make · 4× speed'}, {clip: 'loop', from: 16.5, to: 23}],
    zooms: [{at: 0, box: null}],
    marks: [
      {at: 'number,', until: 'If', box: STATUS_RIGHT, label: 'run 3: same avg probe (slots tried per lookup) as run 2', above: true},
      {at: 'If', box: P(110, 186, 760, 72), label: 'why nothing moved: the ids come 64 apart', below: true},
    ],
  },
  {
    id: 'runs', ch: 2, title: ':Pair runs keeps the notebook', pad: 0.9,
    shots: [{clip: 'loop', from: 34.4, to: 44.2, rate: 1.55}],
    zooms: [{at: 0, box: null}],
    marks: [
      {at: 0.2, until: 2.4, box: STATUS_RIGHT, label: 'run 4: avg probe 23.7 → 1.1', above: true},
      {at: 2.5, until: 4.6, box: P(60, 232, 1300, 180), label: 'every run, with the change before it', below: true},
    ],
    keys: [{at: 'one', keys: ['x'], note: 'removes the debug printf'}],
  },
  {
    id: 'teach', ch: 2, title: 'Alt-? : the idea behind it', pad: 0.8,
    shots: [{clip: 'teach', from: 5.4, to: 15.6, rate: 1.6}],
    zooms: [{at: 0, box: P(0, 250, 1200, 180)}],
    keys: [{at: 3.1, keys: ['Alt', '?']}],
    marks: [{at: 4.3, box: P(108, 349, 1100, 50), label: 'the one idea worth keeping, and a link to the docs', below: true}],
  },
  {
    id: 'held', ch: 2, title: 'A held thought waits for your save', pad: 0.9,
    shots: [{clip: 'held-thought', from: 14.5, to: 23.4, rate: 1.4}],
    zooms: [{at: 0, box: P(0, 450, 1000, 380)}],
    marks: [
      {at: 'dot', until: 'save.', box: P(0, 583, 30, 24), label: 'a thought, held', below: true},
      {at: 'save.', box: P(60, 600, 480, 200), label: 'shown at your save', above: true},
    ],
  },

  {chapter: 3},
  {
    id: 'save', ch: 3, title: 'Save, and Pair runs your tests', pad: 0.8,
    shots: [{clip: 'tests-on-save', from: 0, to: 7, rate: 1.05}],
    keys: [{at: 0.85, keys: [':w']}, {at: 5.9, keys: [':w']}],
    zooms: [{at: 0, box: P(0, 330, 1400, 510)}],
    marks: [{at: 'command,', box: STATUS_RIGHT, label: 'go test ./... ran in Pair’s pane when you saved', above: true}],
  },
  {
    id: 'regression', ch: 3, title: 'A test that passed now fails', pad: 0.8,
    shots: [{clip: 'tests-on-save', from: 7, to: 14.2, rate: 1.1}],
    zooms: [{at: 0, box: P(0, 0, 1400, 420)}, {at: 'queue', box: P(0, 330, 1400, 510)}],
    marks: [{at: 'queue', box: STATUS_RIGHT, label: 'TestNoDoubleDelivery: green before your change', above: true}],
    tags: [{at: 'regression,', text: 'a regression'}],
  },
  {
    id: 'accept', ch: 3, title: 'Alt-Y takes Pair’s fix', pad: 0.9,
    shots: [{clip: 'tests-on-save', from: 14.6, to: 18.45, rate: 0.55}, {clip: 'tests-on-save', from: 18.45, to: 24.4, rate: 1.3}],
    zooms: [{at: 0, box: P(0, 80, 1150, 150)}, {at: 8.4, box: P(0, 560, 1400, 280)}],
    marks: [
      {at: 'ghost', until: 'Alt', box: P(110, 163, 980, 50), label: 'ghost text: dim, not in your file yet', below: true},
      {at: 'it.', box: STATUS_RIGHT, label: '✓ all green after :w', above: true},
    ],
    keys: [{at: 'Alt', keys: ['Alt', 'Y']}],
  },
  {
    id: 'green', ch: 3, title: 'A number moves: it lights up once', pad: 0.9,
    shots: [{clip: 'delight', from: 0, to: 12.9, rate: 4, badge: 'three runs · 4× speed'}, {clip: 'delight', from: 12.9, to: 16}],
    zooms: [{at: 0, box: null}],
    marks: [{at: 'lights', box: STATUS_RIGHT, label: 'avg probe 1893.7 → 1.0', above: true}],
  },

  {chapter: 4},
  {
    id: 'notes', ch: 4, title: 'Notes in the margin', pad: 0.8,
    shots: [{clip: 'notes', from: 0, to: 14.2, rate: 3.2, badge: 'Pair reads the note · 3× speed'}, {clip: 'notes', from: 14.2, to: 15.4, rate: 0.16}],
    zooms: [{at: 0, box: null}],
    marks: [
      {at: 'question,', until: 'two', box: P(0, 443, 1350, 50), label: '? a question the note leaves open', above: true},
      {at: 'two', until: 'what', box: P(0, 347, 1080, 52), label: '≠ two lines that cannot both hold', above: true},
      {at: 'what', box: P(0, 67, 1230, 76), label: '→ what the code it names really does', below: true},
    ],
  },
  {
    id: 'decision', ch: 4, title: 'Alt-D logs a decision; :Pair tasks lists the work', pad: 1,
    shots: [{clip: 'notes', from: 29.2, to: 38.6, rate: 1.65}],
    zooms: [{at: 0, box: null}],
    keys: [{at: 0.4, keys: ['Alt', 'D']}],
    marks: [
      {at: 0.9, until: 'Pair', box: P(40, 605, 1350, 170), label: 'logged in decisions.md, as a buffer you save', above: true},
      {at: 'tasks', box: P(270, 228, 860, 330), label: 'nothing is added until you say so', below: true},
    ],
  },
  {
    id: 'blank', ch: 4, title: 'The blank page: :Pair new', pad: 2.2,
    shots: [
      {clip: 'blank-page', from: 2.2, to: 10.6, rate: 2},
      {clip: 'blank-page', from: 10.6, to: 29, rate: 6, badge: 'three questions · 6× speed'},
      {clip: 'blank-page', from: 29, to: 38.6, rate: 2.2},
    ],
    zooms: [{at: 0, box: null}],
    marks: [{at: 10.6, box: P(60, 160, 1130, 500), label: 'a first slice: two files, what to poke at, what to leave out', above: true}],
  },
  {
    id: 'firstrun', ch: 4, title: 'Hand it over: two files, typed', pad: 0.8,
    shots: [{clip: 'first-run', from: 0.8, to: 28, rate: 5, badge: 'Pair types · 5× speed'}, {clip: 'first-run', from: 28, to: 35.4, rate: 1.4}],
    zooms: [{at: 0, box: null}],
    chips: [{at: 0, until: 2.6, text: ':Pair drive the Makefile from the slice'}],
    keys: [{at: 5.5, keys: [':wa'], note: 'you save both files'}],
    marks: [{at: 8.4, box: P(702, 2, 696, 785), label: 'then make run: frame 20 takes 25 steps', below: false, inside: true}],
  },

  {chapter: 5},
  {
    id: 'drive', ch: 5, title: 'Hand Pair the wheel', pad: 0.8,
    shots: [{clip: 'hand-over', from: 0.6, to: 10.2, rate: 1.05}],
    zooms: [{at: 0, box: null}, {at: 'watch', box: P(0, 150, 1100, 460)}],
    chips: [{at: 0.5, until: 'Driver,', text: ':Pair drive the edge cases', note: 'or, in the chat: “you take it”'}],
    roles: [{at: 'Driver,', glyph: '◎', name: 'Driver', text: 'Pair has the wheel for one change'}],
  },
  {
    id: 'handback', ch: 5, title: 'It tests, then hands back', pad: 0.8,
    shots: [{clip: 'hand-over', from: 10.2, to: 17.8, rate: 1.05}],
    zooms: [{at: 0, box: P(400, 640, 1000, 200)}, {at: 'hands', box: P(0, 300, 1150, 260)}],
    marks: [
      {at: 'tests', until: 'hands', box: STATUS_RIGHT, label: '✓ go test on the unsaved buffer', above: true},
      {at: 'hands', until: 5.7, box: P(150, 488, 950, 52), label: 'a short note, and “u undoes it”', above: true},
    ],
    keys: [{at: 'undo', keys: ['u']}],
  },
  {
    id: 'takeback', ch: 5, title: 'Any key takes the wheel back', pad: 1.4,
    shots: [{clip: 'take-back', from: 0.8, to: 8.2, rate: 1.5}],
    zooms: [{at: 0, box: P(0, 150, 1100, 460)}],
    chips: [{at: 0, until: 2.2, text: ':Pair drive the edge cases', note: 'again'}],
    keys: [{at: 3.1, keys: ['j'], note: 'any key'}],
  },
  {
    id: 'intent', ch: 5, title: 'No test? Say what you expect to see', pad: 0.9,
    shots: [{clip: 'hand-over-run', from: 3.6, to: 19.4, rate: 2}],
    zooms: [{at: 0, box: P(0, 560, 1400, 280)}, {at: 'checks', box: P(0, 230, 1000, 200)}],
    chips: [{at: 0.2, until: 'Pair', text: ':Pair drive make the ids spread over the table, avg probe stays under 2'}],
    marks: [
      {at: 'scratch', until: 'checks', box: STATUS_RIGHT, label: 'make -s run on the unsaved buffer, in a scratch copy', above: true},
      {at: 'checks', box: P(105, 300, 480, 75), label: '✓ avg probe 1.1, under 2', below: true},
    ],
  },

  {chapter: 6},
  {
    id: 'ledger', ch: 6, title: ':Pair today, the ledger', pad: 0.8,
    shots: [{clip: 'ledger', from: 0.8, to: 11.4, rate: 1.3}],
    zooms: [{at: 0, box: null}, {at: 2.2, box: P(0, 530, 1400, 290)}],
    marks: [{at: 'U', box: P(3, 700, 1392, 23), label: 'typed 6 lines: u undoes them, after your own edits too', above: true}],
    keys: [{at: 'U', keys: ['u']}],
  },
  {
    id: 'agents', ch: 6, title: 'Your other agents, at your breaks', pad: 1.6,
    shots: [{clip: 'agents', from: 4, to: 20.6, rate: 2.6}],
    zooms: [{at: 0, box: null}, {at: 'next', box: P(0, 560, 1400, 280)}],
    marks: [
      {at: 'next', until: 5, box: STATUS_RIGHT, label: '#21 needs you · M-a (Alt-A) goes there', above: true},
      {at: 5.1, box: P(0, 670, 1290, 120), label: ':Pair agents lists them, the ones that need you first', above: true},
    ],
  },
  {
    id: 'debrief', ch: 6, title: 'The day’s end: a debrief', pad: 0.9,
    shots: [{clip: 'debrief', from: 7.4, to: 15.4, rate: 1.1}],
    zooms: [{at: 0, box: P(740, 280, 660, 300)}],
    marks: [{at: "tomorrow's", box: P(800, 440, 600, 50), label: 'tomorrow’s first step, as a place', below: true}],
  },
  {
    id: 'pickup', ch: 6, title: 'The morning pick-up', pad: 0.9,
    shots: [{clip: 'pickup', from: 0, to: 9.3, rate: 1.5}],
    zooms: [{at: 0, box: null}, {at: 'opens', box: P(0, 330, 1200, 140)}],
    marks: [{at: 'one', box: P(108, 396, 960, 50), label: 'what is left, in one line', below: true}],
  },

  {chapter: 7},
  {
    id: 'montage', ch: 7, title: 'And the rest', pad: 1,
    shots: [
      {clip: 'push-to-talk', from: 0.4, to: 12.4, rate: 2.85},
      {clip: 'delight', from: 15, to: 17.2},
      {clip: 'start', from: 29.6, to: 31.3, rate: 0.47},
      {clip: 'no-herdr', from: 0, to: 1, rate: 0.38},
      {clip: 'no-herdr', from: 2, to: 24, rate: 3.3},
    ],
    zooms: [{at: 0, box: null}, {at: 6.45, box: I(0, 12, 112, 4)}, {at: 10.1, box: null}],
    cards: [
      {at: 0.35, until: 4.1, title: 'Push-to-talk', text: 'hold Alt-T, ask aloud, let go: whisper.cpp on your CPU'},
      {at: 4.3, until: 6.3, title: 'Earcons', text: 'short sounds for a green, only while you are away from Neovim (off by default)'},
      {at: 6.6, until: 9.9, title: 'Pair’s pane: your rc file, in a sandbox', text: 'where Scout, the role that runs commands, works: your aliases; only the project writable, no network'},
      {at: 10.1, until: 12.6, title: 'Several Neovims, one session', text: 'Pair shows its words in the one you are in; each git worktree is a session of its own'},
      {at: 12.8, until: 15.5, title: 'Pair without herdr', text: ':Pair chat opens the chat inside Neovim; Scout’s pane is a :terminal'},
    ],
  },
  {id: 'keys', kind: 'keys', pad: 3},
];

// The cut for X: the three moments that matter most each day, then the rest in a breath.
const SHORT = [
  {
    id: 'x-open', title: 'pairing-buddy: an AI pair in Neovim', pad: 0.4,
    shots: [{clip: 'wrong-turn', from: 12.8, to: 16.2, rate: 0.62}],
    zooms: [{at: 0, box: P(0, 400, 1200, 160)}],
    marks: [{at: 'speaks', box: P(105, 466, 1040, 50), label: 'it speaks under your line, only when it matters', below: true}],
  },
  {
    id: 'x-wrong', title: 'It stops the wrong turn', pad: 1,
    shots: [{clip: 'wrong-turn', from: 4, to: 8.4, rate: 1.4}, {clip: 'wrong-turn', from: 8.4, to: 16}, {clip: 'wrong-turn', from: 17.3, to: 20.2, rate: 0.8}],
    zooms: [{at: 0, box: P(0, 250, 1400, 340)}],
    marks: [
      {at: 'line:', until: 10.5, box: P(105, 466, 1040, 50), label: 'under your line: the cause is elsewhere', below: true},
      {at: 11.8, box: P(2, 280, 991, 23), label: 'worker.go:35 gives up on >=', above: true},
    ],
    keys: [{at: 11, keys: ['Alt', 'J']}],
  },
  {
    id: 'x-tests', title: 'It runs what you’d skip', pad: 1.4,
    shots: [{clip: 'tests-on-save', from: 5.6, to: 12, rate: 1.6}, {clip: 'tests-on-save', from: 14.6, to: 23, rate: 1.6}],
    zooms: [{at: 0, box: null}],
    marks: [{at: 'queue', until: 'Alt', box: STATUS_RIGHT, label: 'a test that passed now fails', above: true}],
    keys: [{at: 'Alt', keys: ['Alt', 'Y']}],
  },
  {
    id: 'x-drive', title: 'The visible hand-over', pad: 1.4,
    shots: [{clip: 'hand-over', from: 0.6, to: 17.8, rate: 2.1}],
    zooms: [{at: 0, box: null}],
    chips: [{at: 0.2, until: 'watch', text: ':Pair drive the edge cases'}],
    keys: [{at: 'undo', keys: ['u']}],
  },
  {
    id: 'x-more', title: 'And the day around it', pad: 1.2,
    shots: [
      {clip: 'notes', from: 10, to: 15.4, rate: 2.2},
      {clip: 'blank-page', from: 33, to: 38.6, rate: 2.2},
      {clip: 'ledger', from: 2, to: 8, rate: 2.4},
      {clip: 'pickup', from: 2, to: 9.3, rate: 2.9},
    ],
    zooms: [{at: 0, box: null}],
    chips: [
      {at: 0, until: 2.4, text: 'notes in the margin', plain: true},
      {at: 2.5, until: 4.9, text: ':Pair new: a first slice'},
      {at: 5.0, until: 7.4, text: ':Pair today: the ledger'},
      {at: 7.5, until: 9.9, text: 'the morning pick-up', plain: true},
    ],
  },
  {id: 'x-end', kind: 'outro', pad: 4.5},
];
const SCENES = CUT === 'short' ? SHORT : TOUR;

const CHEATS = [
  {cue: 'J,', keys: ['Alt', 'J'], what: 'go where Pair points'},
  {cue: 'Y,', keys: ['Alt', 'Y'], what: 'take Pair’s suggested change'},
  {cue: 'mark,', keys: ['Alt', '?'], what: 'the idea behind Pair’s words'},
  {cue: 'drive,', keys: [':Pair drive …'], what: 'hand Pair one change'},
  {cue: 'U.', keys: ['u'], what: 'undo Pair’s change in one step'},
  {cue: 'U.', delay: 0.5, keys: ['any key'], what: 'while Pair types: take the wheel back'},
  {cue: 'U.', delay: 1, keys: ['pair doctor'], what: 'check every part of the setup'},
];

const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8'}).trim();
const seconds = file => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${here}${file}`]));
const r = value => Math.round(value * 1000) / 1000;
const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const WORDS = JSON.parse(readFileSync(`${here}words.json`, 'utf8'));

/** A time in a scene: seconds, or the moment the voice starts saying a word ("tick," matches that spelling). */
function cue(scene, at) {
  if (typeof at === 'number') return at;
  const word = WORDS[scene.id]?.find(entry => entry.text === at || entry.text.replace(/[.,:;?!]$/, '') === at);
  if (!word) throw new Error(`${scene.id}: no word "${at}" in the narration`);
  return r(VOICE_AT + word.start);
}

/** The camera that fits a box of a capture into the frame (null: all of it); the same function runs in the page. */
function view(box) {
  const base = FRAME.w / 1920;
  if (!box) return {x: 0, y: 0, scale: base};
  const [x, y, w, h] = box;
  const scale = Math.min(Math.max(Math.min(FRAME.w / w, FRAME.h / h) * 0.92, base), 2.2);
  const clamp = (value, low) => Math.min(0, Math.max(low, value));
  return {scale, x: clamp(FRAME.w / 2 - scale * (x + w / 2), FRAME.w - scale * 1920), y: clamp(FRAME.h / 2 - scale * (y + h / 2), FRAME.h - scale * 1080)};
}

// Timing: each scene as long as its voice plus its pad, or its shots if those run longer; chapter cards 2.1 s.
let clock = 0;
const media = [];
const timeline = [];
mkdirSync(`${here}frames`, {recursive: true});
const still = (clip, t, name) => {
  run('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', `${here}clips/${clip}.mp4`, '-frames:v', '1', `${here}frames/${name}.png`]);
  return `frames/${name}.png`;
};
for (const [index, scene] of SCENES.entries()) {
  if (scene.chapter) {
    timeline.push({...scene, id: `ch${scene.chapter}`, kind: 'chapter', start: r(clock), length: 2.1, shots: []});
    clock += 2.1;
    continue;
  }
  const voice = seconds(`audio/${scene.id}.mp3`);
  let at = 0;
  const shots = (scene.shots ?? []).map(shot => {
    const rate = shot.rate ?? 1;
    const placed = {...shot, rate, start: at, duration: r((shot.to - shot.from) / rate)};
    at = r(at + placed.duration);
    return placed;
  });
  const length = r(Math.max(VOICE_AT + voice + (scene.pad ?? 0.8), at));
  const start = r(clock);
  shots.forEach((shot, i) => {
    const rate = shot.rate === 1 ? '' : ` data-playback-rate="${shot.rate}"`;
    media.push(`<video id="v-${scene.id}-${i}" class="clip shot" src="clips/${shot.clip}.mp4" data-start="${r(start + shot.start)}" data-duration="${shot.duration}" data-media-start="${shot.from}"${rate} data-track-index="1" muted playsinline></video>`);
  });
  if (shots.length && at < length - 0.02) { // hold the last frame for the rest of the scene
    const last = shots.at(-1);
    const src = still(last.clip, last.to - 0.05, `${scene.id}-hold`);
    media.push(`<img id="h-${scene.id}" class="clip shot" src="${src}" alt="" data-start="${r(start + at)}" data-duration="${r(length - at)}" data-track-index="1" />`);
  }
  media.push(`<audio id="vo-${scene.id}" class="clip" src="audio/${scene.id}.mp3" data-start="${r(start + VOICE_AT)}" data-duration="${r(voice)}" data-track-index="10" data-volume="1"></audio>`);
  const compare = scene.compare && {...scene.compare, rows: scene.compare.rows.map((row, i) => ({...row, src: still(row.clip, row.t, `${scene.id}-compare-${i}`)}))};
  timeline.push({...scene, kind: scene.kind ?? 'shots', start, length, shots, compare, index});
  clock += length;
}
const total = r(clock);

// The music bed: from the scene MUSIC.from to the end, faded in and out.
// A bed shorter than that starts later instead, so it still ends with the film.
const musicStart = r(Math.max((timeline.find(scene => scene.id === MUSIC.from) ?? timeline[0]).start, total - seconds('audio/music.mp3')));
const musicLength = total - musicStart;
media.push(`<audio id="music" class="clip" src="audio/music.mp3" data-start="${musicStart}" data-duration="${r(musicLength)}" data-track-index="11" data-volume="${MUSIC.volume}" data-fade-in="1.5" data-fade-out="3"></audio>`);

// Every overlay, written out with its absolute times for the script.
const html = [];
const plan = [];
const shortMarks = []; // marks that would fade out before they finish fading in
const tw = (selector, at, until, extra = {}) => plan.push({selector, at: r(at), until: until === undefined ? undefined : r(until), ...extra});
const zoomScaleAt = (scene, t) => view([...(scene.zooms ?? [])].reverse().find(zoom => cue(scene, zoom.at) <= t)?.box ?? null).scale;

for (const scene of timeline) {
  const t0 = scene.start;
  const end = t0 + scene.length;
  const at = value => t0 + cue(scene, value);
  if (scene.kind === 'chapter') {
    const [title, sub] = CHAPTERS[scene.chapter];
    html.push(`<div class="chapter" id="${scene.id}"><div class="chapter-n">${scene.chapter}</div><div class="chapter-t">${esc(title)}</div><div class="chapter-s">${esc(sub)}</div></div>`);
    tw(`#${scene.id}`, t0, end, {kind: 'chapter'});
    continue;
  }
  if (scene.kind !== 'shots') {
    tw(`#p-${scene.kind === 'outro' ? 'outro' : scene.id}`, t0, end, {kind: 'panel'});
    if (scene.kind === 'problem') {
      tw('#problem-0', t0, end, {kind: 'line', still: true});
      for (const [i, word] of ['wrong', 'skip', 'wait', 'rewrite'].entries()) tw(`#problem-${i + 1}`, at(word) - 0.1, end, {kind: 'line'});
    }
    if (scene.kind === 'chair') {
      tw('#chair-title', t0 + 0.3, end, {kind: 'line'});
      for (const [i, word] of ['second', 'Neovim,', 'speaks', 'never'].entries()) tw(`#chair-${i}`, at(word) - 0.1, end, {kind: 'line'});
    }
    if (scene.kind === 'models') {
      tw('#models-title', t0 + 0.2, end, {kind: 'line'});
      for (const [i, word] of ['work.', 'Watcher', 'moment', 'Partner', 'writes'].entries()) tw(`#models-${i}`, at(word) - 0.1, end, {kind: 'node'});
      tw('#models-5', at('remark.') - 0.2, end, {kind: 'line'});
    }
    if (scene.kind === 'roles') {
      tw('#roles-title', at('three') - 0.1, end, {kind: 'line'});
      for (const [i, word] of ['Navigator', 'Scout', 'Driver'].entries()) tw(`#role-${i}`, at(word) - 0.1, end, {kind: 'node'});
    }
    if (scene.kind === 'outro') {
      tw('#outro-title', t0 + 0.2, end, {kind: 'line'});
      for (const [i, word] of ['Any', 'Pairing'].entries()) tw(`#outro-${i}`, at(word) - 0.1, end, {kind: 'line'});
    }
    if (scene.kind === 'keys') {
      tw('#keys-title', t0 + 0.2, end, {kind: 'line'});
      CHEATS.forEach((row, i) => tw(`#cheat-${i}`, at(row.cue) - 0.15 + (row.delay ?? 0), end, {kind: 'node'}));
      tw('#keys-end', at('stays') - 0.1, end, {kind: 'line'});
    }
    continue;
  }
  tw(`#hd-${scene.id}`, t0 + 0.1, end, {kind: 'header'});
  html.push(`<div class="hd" id="hd-${scene.id}">${scene.ch ? `<div class="hd-c">${scene.ch} · ${esc(CHAPTERS[scene.ch][0])}</div>` : ''}<div class="hd-t">${esc(scene.title)}</div></div>`);
  for (const zoom of scene.zooms ?? []) plan.push({camera: view(zoom.box), at: r(at(zoom.at)), cut: cue(scene, zoom.at) === 0});
  (scene.marks ?? []).forEach((mark, i) => {
    const [x, y, w, h] = mark.box;
    const id = `mark-${scene.id}-${i}`;
    const size = Math.round(30 / zoomScaleAt(scene, cue(scene, mark.at)));
    const place = mark.above ? 'above' : mark.below === false ? 'right' : mark.below ? 'below' : 'above';
    if (mark.until !== undefined && cue(scene, mark.until) < cue(scene, mark.at) + 0.7) shortMarks.push(`${scene.id}: ${mark.at} → ${mark.until} (${r(cue(scene, mark.until) - cue(scene, mark.at))} s)`);
    const side = mark.inside ? ' mark-inside' : x + w / 2 > 1150 && place !== 'right' ? ' mark-end' : ''; // a label on the right half grows leftwards, inside the frame
    html.push(`<div class="mark mark-${place}${side}" id="${id}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;--label:${size}px"><span class="mark-l"><b>●</b> ${esc(mark.label)}</span></div>`);
    tw(`#${id}`, at(mark.at), mark.until === undefined ? end - 0.1 : at(mark.until), {kind: 'mark'});
  });
  (scene.keys ?? []).forEach((press, i) => {
    const id = `keys-${scene.id}-${i}`;
    html.push(`<div class="keys" id="${id}">${press.keys.map(key => `<span class="key">${esc(key)}</span>`).join('<span class="plus">+</span>')}${press.note ? `<span class="key-note">${esc(press.note)}</span>` : ''}</div>`);
    const next = scene.keys[i + 1];
    tw(`#${id}`, at(press.at), Math.min(at(press.at) + 2.4, next ? at(next.at) - 0.05 : Infinity, end - 0.1), {kind: 'keys'});
  });
  (scene.chips ?? []).forEach((chip, i) => {
    const id = `chip-${scene.id}-${i}`;
    html.push(`<div class="chip" id="${id}"><span class="chip-p">${chip.text.startsWith(':') || chip.plain ? '' : '$ '}</span>${esc(chip.text)}${chip.note ? `<span class="chip-n">${esc(chip.note)}</span>` : ''}</div>`);
    tw(`#${id}`, at(chip.at), at(chip.until) - 0.05, {kind: 'chip'});
  });
  (scene.roles ?? []).forEach((role, i) => {
    const id = `role-${scene.id}-${i}`;
    html.push(`<div class="rolecard" id="${id}"><span class="rolecard-g">${role.glyph}</span><span class="rolecard-n">${esc(role.name)}</span><span class="rolecard-t">${esc(role.text)}</span></div>`);
    tw(`#${id}`, at(role.at), role.until === undefined ? end - 0.1 : t0 + cue(scene, role.until), {kind: 'chip'});
  });
  (scene.cards ?? []).forEach((card, i) => {
    const id = `card-${scene.id}-${i}`;
    html.push(`<div class="card" id="${id}"><div class="card-t">${esc(card.title)}</div><div class="card-x">${esc(card.text)}</div></div>`);
    tw(`#${id}`, at(card.at), at(card.until), {kind: 'chip'});
  });
  if (scene.quote) {
    const id = `quote-${scene.id}`;
    html.push(`<div class="quote" id="${id}"><div class="quote-l"><b>●</b> Pair says, under your line</div><div class="quote-t">${esc(scene.quote.text)}</div></div>`);
    tw(`#${id}`, at(scene.quote.at), scene.quote.until === undefined ? end - 0.1 : at(scene.quote.until), {kind: 'chip'});
  }
  (scene.tags ?? []).forEach((tag, i) => {
    const id = `tag-${scene.id}-${i}`;
    html.push(`<div class="tag" id="${id}">${esc(tag.text)}</div>`);
    tw(`#${id}`, at(tag.at), end - 0.1, {kind: 'chip'});
  });
  scene.shots.filter(shot => shot.badge).forEach((shot, i) => {
    const id = `badge-${scene.id}-${i}`;
    html.push(`<div class="badge" id="${id}">${esc(shot.badge)}</div>`);
    tw(`#${id}`, t0 + shot.start, t0 + shot.start + shot.duration, {kind: 'chip'});
  });
  if (scene.compare) {
    const id = `cmp-${scene.id}`;
    const rows = scene.compare.rows.map(row => {
      const [x, y, w, h] = row.box;
      const scale = Math.min(1240 / w, 2.2);
      return `<div class="cmp-row"><div class="cmp-l">${esc(row.label)}</div><div class="cmp-img" style="width:${Math.round(w * scale)}px;height:${Math.round(h * scale)}px"><img src="${row.src}" alt="" style="width:${Math.round(1920 * scale)}px;left:${Math.round(-x * scale)}px;top:${Math.round(-y * scale)}px" /></div></div>`;
    });
    html.push(`<div class="cmp" id="${id}">${rows.join('')}</div>`);
    tw(`#${id}`, at(scene.compare.at), end, {kind: 'compare'});
  }
}

if (shortMarks.length) throw new Error(`a mark must show for 0.7 s at least:\n  ${shortMarks.join('\n  ')}`);

// Captions: the script's words a sentence at a time (a long one split at a comma), one group at a time.
const captions = [];
for (const scene of timeline.filter(scene => WORDS[scene.id])) {
  let group = [];
  const sentences = [];
  for (const word of WORDS[scene.id]) {
    group.push(word);
    if (/[.?!:]$/.test(word.text)) { sentences.push(group); group = []; }
  }
  if (group.length) sentences.push(group);
  group = [];
  const flush = () => {
    if (!group.length) return;
    const id = `cap-${captions.length}`;
    const start = r(scene.start + VOICE_AT + group[0].start - 0.05);
    const until = r(scene.start + VOICE_AT + group.at(-1).end + 0.25);
    captions.push({id, start, until, text: group.map(word => word.text).join(' ')});
    group = [];
  };
  for (const sentence of sentences) {
    if (sentence.length <= 10) { group = sentence; flush(); continue; }
    const commas = sentence.map((word, i) => (/,$/.test(word.text) && i >= 2 && i <= sentence.length - 4 ? i : -1)).filter(i => i >= 0);
    const middle = sentence.length / 2;
    const cut = commas.length ? commas.reduce((best, i) => (Math.abs(i - middle) < Math.abs(best - middle) ? i : best)) : Math.ceil(middle) - 1;
    group = sentence.slice(0, cut + 1); flush();
    group = sentence.slice(cut + 1); flush();
  }
}
captions.forEach((caption, i) => { // a group stays until the next one starts, when the gap is short
  const next = captions[i + 1];
  if (next && next.start - caption.until < 0.9) caption.until = next.start;
});

const panels = `
      <div class="panel" id="p-problem">
        <div class="problem-h" id="problem-0">Coding alone, you lose time in small ways.</div>
        <div class="problem-list">
          <div class="problem-l" id="problem-1"><b>✗</b> You fix the wrong file.</div>
          <div class="problem-l" id="problem-2"><b>✗</b> You skip the tests.</div>
          <div class="problem-l" id="problem-3"><b>✗</b> Your AI tool waits to be asked…</div>
          <div class="problem-l" id="problem-4"><b>✗</b> …or rewrites your code behind your back.</div>
        </div>
      </div>
      <div class="panel" id="p-chair">
        <div class="chair-title" id="chair-title">pairing-buddy</div>
        <div class="chair-sub" id="chair-0">the person in the second chair · “Pair” for short</div>
        <div class="chair-list">
          <div class="chair-l" id="chair-1"><b>●</b> sits beside you in Neovim</div>
          <div class="chair-l" id="chair-2"><b>●</b> speaks up only when it matters</div>
          <div class="chair-l" id="chair-3"><b>◎</b> never touches your files, unless you hand it the wheel</div>
        </div>
      </div>
      <div class="panel" id="p-models">
        <div class="models-title" id="models-title">Two models share the work</div>
        <div class="flow">
          <div class="node" id="models-0"><div class="node-n">You work</div><div class="node-t">edits · saves · test runs</div></div>
          <div class="node node-accent" id="models-1"><div class="node-n">Watcher</div><div class="node-k">a small, fast model</div><div class="node-t">scores each moment from 0 to 10: an edit, a save, a test run</div></div>
          <div class="node gate" id="models-2"><div class="node-n">worth a word?</div><div class="node-t">only high scores pass</div></div>
          <div class="node node-accent" id="models-3"><div class="node-n">Partner</div><div class="node-k">a larger model</div><div class="node-t">thinks first, reads your code, writes the remark</div></div>
          <div class="node node-out" id="models-4"><div class="node-n"><b>●</b> words</div><div class="node-t">under your line, in Neovim</div></div>
        </div>
        <div class="models-foot" id="models-5">Any OpenAI-compatible server, local or cloud, Anthropic, or a provider you log in to with pair auth. One model can play both roles.</div>
      </div>
      <div class="panel" id="p-roles">
        <div class="models-title" id="roles-title">Three roles</div>
        <div class="roles">
          <div class="role" id="role-0"><div class="role-n">Navigator</div><div class="role-d">the default</div><div class="role-t">watches and points at code</div><div class="role-s"><b>●</b> pair</div></div>
          <div class="role" id="role-1"><div class="role-n">Scout</div><div class="role-d">/scout in Pair’s chat pane</div><div class="role-t">searches and runs commands in a terminal pane of its own</div><div class="role-s"><b>●</b> pair · scout</div></div>
          <div class="role" id="role-2"><div class="role-n">Driver</div><div class="role-d">:Pair drive &lt;what you want&gt;</div><div class="role-t">makes one change, then gives the wheel back</div><div class="role-s"><b>◎</b> pair has the wheel</div></div>
        </div>
      </div>
      <div class="panel" id="p-outro">
        <div class="chair-title" id="outro-title">pairing-buddy</div>
        <div class="chair-sub" id="outro-0">an AI pair in Neovim · any model, local or cloud</div>
        <div class="keys-end outro-end" id="outro-1"><span><b>●</b> the person in the second chair</span><span class="url">github.com/makefunstuff/pairing-buddy</span></div>
      </div>
      <div class="panel" id="p-keys">
        <div class="models-title" id="keys-title">The keys to remember</div>
        <div class="cheats">
          ${CHEATS.map((row, i) => `<div class="cheat" id="cheat-${i}"><span class="cheat-k">${row.keys.map(key => `<span class="key">${esc(key)}</span>`).join('<span class="plus">+</span>')}</span><span class="cheat-w">${esc(row.what)}</span></div>`).join('\n          ')}
        </div>
        <div class="keys-end" id="keys-end"><span><b>●</b> Pair stays in the second chair.</span><span class="url">github.com/makefunstuff/pairing-buddy</span></div>
      </div>`;

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>pairing-buddy: ${CUT === 'short' ? 'the short cut' : 'the tour'}</title>
    <!-- Generated by build.mjs: edit the scene list there, then run node build.mjs -->
    <script src="vendor/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Inter"; font-weight: 500; src: url("fonts/inter-500.woff2") format("woff2"); }
      @font-face { font-family: "Inter"; font-weight: 700; src: url("fonts/inter-700.woff2") format("woff2"); }
      @font-face { font-family: "Inter"; font-weight: 800; src: url("fonts/inter-800.woff2") format("woff2"); }
      @font-face { font-family: "JetBrains Mono"; font-weight: 400; src: url("fonts/jetbrains-mono-400.woff2") format("woff2"); }
      @font-face { font-family: "JetBrains Mono"; font-weight: 700; src: url("fonts/jetbrains-mono-700.woff2") format("woff2"); }
      :root { /* ayu dark, the colorscheme of the captures, and the plugin's accent on it */
        --bg: #0a0d12; --term: #0f1419; --panel: #131a22; --line: #253340; --text: #e6e1cf; --dim: #8a9199; --faint: #5c6773;
        --accent: #95e6cb; --red: #ff6565; --green: #b8cc52; --key: #1b232d;
      }
      html, body { margin: 0; background: var(--bg); color: var(--text); font-family: "Inter", sans-serif; font-variant-ligatures: none; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--bg); }
      #bg { position: absolute; inset: 0; background: radial-gradient(1100px 620px at 50% 0%, rgba(149,230,203,0.07), transparent 70%), var(--bg); }
      #frame { position: absolute; left: ${FRAME.x}px; top: ${FRAME.y}px; width: ${FRAME.w}px; height: ${FRAME.h}px; border-radius: 14px;
        overflow: hidden; background: var(--term); opacity: 0; box-shadow: 0 0 0 1px var(--line), 0 30px 90px rgba(0,0,0,0.6); }
      #cam { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
      .shot { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: cover; }
      #veil { position: absolute; inset: 0; background: var(--term); opacity: 0; }
      .hd { position: absolute; left: ${FRAME.x}px; top: 14px; opacity: 0; }
      .hd-c { font-family: "JetBrains Mono", monospace; font-size: 28px; color: var(--accent); letter-spacing: 0.5px; }
      .hd-t { margin-top: 4px; font-weight: 700; font-size: 46px; color: #f3f0e6; letter-spacing: -0.6px; }
      .mark { position: absolute; border-radius: 6px; opacity: 0;
        box-shadow: 0 0 0 3px var(--accent), 0 0 0 4000px rgba(5,8,11,0.68); }
      .mark-l { position: absolute; left: -3px; white-space: nowrap; font-family: "JetBrains Mono", monospace; font-weight: 700;
        font-size: var(--label); color: var(--term); background: var(--accent); padding: 0.18em 0.5em; border-radius: 0.25em; }
      .mark-l b { font-weight: 700; color: var(--term); }
      .mark-above .mark-l { bottom: calc(100% + 0.5em); }
      .mark-below .mark-l { top: calc(100% + 0.5em); }
      .mark-right .mark-l { left: calc(100% + 0.6em); top: 0; }
      .mark-end .mark-l { left: auto; right: -3px; }
      .mark-inside .mark-l { top: auto; bottom: 0.6em; left: 0.6em; right: auto; }
      .keys { position: absolute; right: ${1920 - FRAME.x - FRAME.w + 28}px; top: ${FRAME.y + 28}px; display: flex; align-items: center; gap: 10px; opacity: 0; }
      .key { display: inline-block; min-width: 54px; text-align: center; font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 34px;
        color: #f3f0e6; padding: 12px 20px; border-radius: 12px; background: var(--key);
        box-shadow: inset 0 -5px 0 rgba(0,0,0,0.45), 0 0 0 2px var(--accent), 0 14px 30px rgba(0,0,0,0.5); }
      .plus { font-family: "JetBrains Mono", monospace; font-size: 30px; color: var(--dim); }
      .key-note { margin-left: 8px; font-size: 28px; font-weight: 700; color: var(--accent); }
      .chip, .rolecard, .tag, .badge { position: absolute; opacity: 0; }
      .chip { left: ${FRAME.x + 28}px; top: ${FRAME.y + FRAME.h - 104}px; font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 32px;
        color: #f3f0e6; padding: 14px 24px; border-radius: 12px; background: rgba(10,13,18,0.94); box-shadow: 0 0 0 2px var(--accent), 0 12px 30px rgba(0,0,0,0.5); }
      .chip-p { color: var(--accent); }
      .chip-n { display: block; margin-top: 6px; font-family: "Inter", sans-serif; font-weight: 500; font-size: 28px; color: var(--accent); }
      .rolecard { left: ${FRAME.x + 28}px; top: ${FRAME.y + 28}px; display: flex; align-items: baseline; gap: 16px; padding: 18px 26px; border-radius: 14px;
        background: rgba(10,13,18,0.95); box-shadow: 0 0 0 2px var(--accent), 0 16px 40px rgba(0,0,0,0.55); }
      .rolecard-g { font-size: 34px; color: var(--accent); }
      .rolecard-n { font-weight: 800; font-size: 38px; color: #f3f0e6; }
      .rolecard-t { font-weight: 500; font-size: 32px; color: var(--text); }
      .quote { position: absolute; left: ${FRAME.x + 60}px; right: ${1920 - FRAME.x - FRAME.w + 60}px; top: ${FRAME.y + 24}px; opacity: 0;
        padding: 22px 30px; border-radius: 14px; background: rgba(10,13,18,0.96); box-shadow: 0 0 0 2px var(--accent), 0 18px 50px rgba(0,0,0,0.6); }
      .quote-l { font-family: "JetBrains Mono", monospace; font-size: 28px; color: var(--accent); }
      .quote-l b { font-weight: 400; }
      .quote-t { margin-top: 10px; font-family: "JetBrains Mono", monospace; font-size: 36px; line-height: 1.4; color: #f3f0e6; }
      .tag { right: ${1920 - FRAME.x - FRAME.w + 28}px; top: ${FRAME.y + 28}px; font-weight: 800; font-size: 34px; color: var(--term);
        background: var(--red); padding: 12px 26px; border-radius: 999px; }
      .badge { left: ${FRAME.x + 28}px; bottom: ${1080 - FRAME.y - FRAME.h + 28}px; font-family: "JetBrains Mono", monospace; font-size: 28px; color: var(--text);
        background: rgba(10,13,18,0.92); padding: 10px 18px; border-radius: 10px; box-shadow: 0 0 0 1px var(--line); }
      .cmp { position: absolute; left: ${FRAME.x}px; top: ${FRAME.y}px; width: ${FRAME.w}px; height: ${FRAME.h}px; border-radius: 14px; opacity: 0;
        background: var(--term); display: flex; flex-direction: column; justify-content: center; gap: 44px; padding: 0 64px; box-sizing: border-box; }
      .cmp-l { font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 28px; color: var(--accent); margin-bottom: 14px; }
      .cmp-img { position: relative; overflow: hidden; border-radius: 10px; box-shadow: 0 0 0 1px var(--line); }
      .cmp-img img { position: absolute; max-width: none; }
      .chapter { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding-left: 300px; opacity: 0; }
      .chapter-n { font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 120px; color: var(--accent); line-height: 1; }
      .chapter-t { margin-top: 22px; font-weight: 800; font-size: 92px; letter-spacing: -2px; color: #f3f0e6; }
      .chapter-s { margin-top: 16px; font-weight: 500; font-size: 40px; color: var(--dim); }
      .panel { position: absolute; inset: 0; opacity: 0; }
      .problem-h { position: absolute; left: 300px; top: 230px; font-weight: 800; font-size: 72px; letter-spacing: -1.5px; color: #f3f0e6; }
      .problem-list { position: absolute; left: 300px; top: 420px; display: flex; flex-direction: column; gap: 30px; }
      .problem-l { font-weight: 500; font-size: 52px; color: var(--text); }
      .problem-l b { color: var(--red); font-weight: 700; margin-right: 18px; }
      .chair-title { position: absolute; left: 0; right: 0; top: 230px; text-align: center; font-weight: 800; font-size: 150px; letter-spacing: -4px; color: #f3f0e6; }
      .chair-sub { position: absolute; left: 0; right: 0; top: 430px; text-align: center; font-weight: 700; font-size: 56px; color: var(--accent); }
      .chair-list { position: absolute; left: 470px; top: 600px; display: flex; flex-direction: column; gap: 26px; }
      .chair-l { font-weight: 500; font-size: 44px; color: var(--text); }
      .chair-l b { color: var(--accent); margin-right: 18px; }
      .models-title { position: absolute; left: 0; right: 0; top: 150px; text-align: center; font-weight: 800; font-size: 72px; letter-spacing: -1.5px; color: #f3f0e6; }
      .flow { position: absolute; left: 110px; right: 110px; top: 400px; display: flex; gap: 34px; align-items: stretch; }
      .node { flex: 1; padding: 30px 26px; border-radius: 18px; background: var(--panel); box-shadow: 0 0 0 2px var(--line); }
      .node-accent { box-shadow: 0 0 0 3px var(--accent), 0 0 50px rgba(149,230,203,0.18); }
      .gate { background: transparent; box-shadow: 0 0 0 2px var(--line) inset; border: 0; }
      .node-out { background: #0f1419; }
      .node-n { font-weight: 800; font-size: 42px; color: #f3f0e6; }
      .node-n b { color: var(--accent); }
      .node-k { margin-top: 8px; font-family: "JetBrains Mono", monospace; font-size: 28px; color: var(--accent); }
      .node-t { margin-top: 14px; font-weight: 500; font-size: 30px; line-height: 1.3; color: var(--text); }
      .models-foot { position: absolute; left: 0; right: 0; top: 800px; text-align: center; font-weight: 500; font-size: 32px; color: var(--dim); }
      .roles { position: absolute; left: 140px; right: 140px; top: 340px; display: flex; gap: 40px; }
      .role { flex: 1; padding: 40px 36px; border-radius: 20px; background: var(--panel); box-shadow: 0 0 0 2px var(--line); }
      .role-n { font-weight: 800; font-size: 56px; color: #f3f0e6; }
      .role-d { margin-top: 8px; font-family: "JetBrains Mono", monospace; font-size: 28px; color: var(--accent); }
      .role-t { margin-top: 22px; min-height: 130px; font-weight: 500; font-size: 36px; line-height: 1.3; color: var(--text); }
      .role-s { margin-top: 26px; font-family: "JetBrains Mono", monospace; font-size: 28px; color: var(--dim); background: var(--term); padding: 12px 16px; border-radius: 8px; }
      .role-s b { color: var(--accent); font-weight: 400; }
      .cheats { position: absolute; left: 300px; top: 300px; display: flex; flex-direction: column; gap: 24px; }
      .cheat { display: flex; align-items: center; gap: 40px; }
      .cheat-k { flex: 0 0 470px; display: flex; align-items: center; gap: 10px; }
      .cheat .key { font-size: 30px; padding: 8px 18px; }
      .cheat-w { font-weight: 500; font-size: 40px; color: var(--text); }
      .keys-end { position: absolute; left: 300px; right: 300px; top: 880px; display: flex; justify-content: space-between; align-items: baseline;
        font-weight: 700; font-size: 40px; color: #f3f0e6; }
      .keys-end b { color: var(--accent); }
      .url { font-family: "JetBrains Mono", monospace; font-weight: 400; font-size: 30px; color: var(--accent); }
      .outro-end { top: 760px; }
      .card { position: absolute; left: ${FRAME.x + 60}px; right: ${1920 - FRAME.x - FRAME.w + 60}px; bottom: ${1080 - FRAME.y - FRAME.h + 120}px; opacity: 0;
        padding: 26px 34px; border-radius: 16px; background: rgba(10,13,18,0.96); box-shadow: 0 0 0 2px var(--accent), 0 18px 50px rgba(0,0,0,0.6); }
      .card-t { font-weight: 800; font-size: 46px; letter-spacing: -0.5px; color: #f3f0e6; }
      .card-x { margin-top: 10px; font-weight: 500; font-size: 32px; line-height: 1.35; color: var(--text); }
      .cap { position: absolute; left: 160px; right: 160px; bottom: 12px; text-align: center; opacity: 0; }
      .cap span { display: inline-block; font-weight: 700; font-size: 36px; line-height: 1.3; color: #f3f0e6; padding: 8px 22px; border-radius: 10px; background: rgba(10,13,18,0.82); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="${total}">
      <div id="bg"></div>
      <div id="frame">
        <div id="cam" data-layout-allow-overflow>
          ${media.filter(tag => !tag.startsWith('<audio')).join('\n          ')}
          ${html.filter(tag => tag.startsWith('<div class="mark')).join('\n          ')}
        </div>
        <div id="veil"></div>
      </div>
      ${html.filter(tag => !tag.startsWith('<div class="mark')).join('\n      ')}
      ${panels}
      ${captions.map(caption => `<div class="cap" id="${caption.id}"><span>${esc(caption.text)}</span></div>`).join('\n      ')}
      ${media.filter(tag => tag.startsWith('<audio')).join('\n      ')}
    </div>
    <script>
      const PLAN = ${JSON.stringify(plan)};
      const CAPTIONS = ${JSON.stringify(captions.map(({id, start, until}) => ({id, start, until})))};
      const SCENES = ${JSON.stringify(timeline.map(({start, length, kind}) => ({start, length, kind})))};
      const BASE = ${FRAME.w / 1920};
      const tl = gsap.timeline({paused: true});
      tl.set('#cam', {transformOrigin: '0 0', x: 0, y: 0, scale: BASE}, 0);
      // The terminal frame shows during the scenes made of captures, and hides behind cards and panels.
      SCENES.forEach((scene, i) => {
        const before = SCENES[i - 1]?.kind === 'shots';
        if (scene.kind === 'shots' && !before) tl.fromTo('#frame', {opacity: 0, scale: 0.96}, {opacity: 1, scale: 1, duration: 0.6, ease: 'expo.out'}, scene.start);
        if (scene.kind !== 'shots' && before) tl.to('#frame', {opacity: 0, scale: 0.97, duration: 0.35, ease: 'power3.in'}, scene.start - 0.35);
        // A cut between two scenes of captures dips through the terminal's own background.
        if (scene.kind === 'shots' && before) {
          tl.to('#veil', {opacity: 1, duration: 0.18, ease: 'power2.in'}, scene.start - 0.18);
          tl.to('#veil', {opacity: 0, duration: 0.3, ease: 'power2.out'}, scene.start);
        }
      });
      const fadeIn = (selector, at, from, duration = 0.45) => tl.fromTo(selector, {opacity: 0, ...from}, {opacity: 1, x: 0, y: 0, scale: 1, filter: 'blur(0px)', duration, ease: 'expo.out'}, at);
      const fadeOut = (selector, until, duration = 0.25) => tl.to(selector, {opacity: 0, duration, ease: 'power2.in'}, until - duration);
      for (const step of PLAN) {
        if (step.camera) {
          if (step.cut) tl.set('#cam', step.camera, step.at);
          else tl.to('#cam', {...step.camera, duration: 1.1, ease: 'power2.inOut'}, step.at);
          continue;
        }
        const {selector, at, until, kind} = step;
        if (step.still) {
          tl.set(selector, {opacity: 1}, at);
        } else if (kind === 'panel' || kind === 'chapter') {
          if (at === 0) tl.set(selector, {opacity: 1}, 0);
          else tl.fromTo(selector, {opacity: 0}, {opacity: 1, duration: 0.4, ease: 'power2.out'}, at);
          if (kind === 'chapter') tl.fromTo(selector + ' > *', {opacity: 0, y: 30, filter: 'blur(8px)'}, {opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.6, stagger: 0.12, ease: 'expo.out'}, at + 0.05);
          fadeOut(selector, until, 0.35);
        } else if (kind === 'line') {
          fadeIn(selector, at, {filter: 'blur(8px)'}, 0.5);
        } else if (kind === 'node') {
          fadeIn(selector, at, {y: 24, filter: 'blur(6px)'}, 0.55);
        } else if (kind === 'header') {
          fadeIn(selector, at, {y: 14, filter: 'blur(6px)'});
          fadeOut(selector, until);
        } else if (kind === 'mark') {
          fadeIn(selector, at, {scale: 1.04}, 0.4);
          fadeOut(selector, until);
        } else if (kind === 'keys') {
          fadeIn(selector, at, {y: 20}, 0.3);
          tl.to(selector + ' .key', {y: 5, duration: 0.08, ease: 'power1.in'}, at + 0.3);
          tl.to(selector + ' .key', {y: 0, duration: 0.2, ease: 'power2.out'}, at + 0.38);
          fadeOut(selector, until);
        } else if (kind === 'compare') {
          fadeIn(selector, at, {scale: 0.98}, 0.5);
          fadeOut(selector, until, 0.3);
        } else {
          fadeIn(selector, at, {y: 12}, 0.4);
          fadeOut(selector, until);
        }
      }
      for (const caption of CAPTIONS) {
        tl.fromTo('#' + caption.id, {opacity: 0}, {opacity: 1, duration: 0.12, ease: 'power1.out'}, caption.start);
        tl.to('#' + caption.id, {opacity: 0, duration: 0.1, ease: 'power1.in'}, caption.until - 0.1);
        tl.set('#' + caption.id, {opacity: 0, visibility: 'hidden'}, caption.until);
      }
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
writeFileSync(`${here}${CUT === 'short' ? 'short' : 'index'}.html`, page);
// The same captions as a WebVTT file, for players that show their own.
const stamp = t => new Date(t * 1000).toISOString().slice(11, 23);
writeFileSync(`${here}captions${CUT === 'short' ? '-short' : ''}.vtt`, `WEBVTT\n\n${captions.map(caption => `${stamp(caption.start)} --> ${stamp(caption.until)}\n${caption.text}\n`).join('\n')}`);
console.log(`${CUT === 'short' ? 'short' : 'index'}.html: ${timeline.length} scenes, ${total} s`);
// The chapters, for the README and the site: where each starts.
const clockText = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
if (CUT === 'tour') {
  const chapters = [{at: 0, title: 'Why'}, ...timeline.filter(scene => scene.kind === 'chapter').map(scene => ({at: scene.start, title: CHAPTERS[scene.chapter][0]})), {at: timeline.find(scene => scene.kind === 'keys').start, title: 'The keys to remember'}];
  const scenes = Object.fromEntries(timeline.filter(scene => scene.kind !== 'chapter').map(scene => [scene.id, r(scene.start)]));
  writeFileSync(`${here}chapters.json`, `${JSON.stringify({chapters: chapters.map(c => ({...c, at: r(c.at), clock: clockText(c.at)})), scenes}, null, 1)}\n`);
  writeFileSync(`${here}chapters.vtt`, `WEBVTT\n\n${chapters.map((c, i) => `${stamp(c.at)} --> ${stamp(chapters[i + 1]?.at ?? total)}\n${c.title}\n`).join('\n')}`);
  for (const c of chapters) console.log(`  chapter ${clockText(c.at)} ${c.title}`);
}
for (const scene of timeline) console.log(`  ${scene.id.padEnd(10)} ${scene.start.toFixed(1).padStart(6)} s  ${scene.length.toFixed(1)} s`);
