// Builds index.html, the HyperFrames composition of the tutorial, from the scene list below.
// Each scene lasts as long as its voiceover (audio/<id>.mp3, from tts.mjs); its shots are ranges of the
// screen recordings in clips/ (played at `rate`), and the last frame holds when the shots end early.
// Coordinates (`zoom`, `box`) are in the recordings' own pixels (1920x1080).
// Usage: node build.mjs   (needs ffprobe and ffmpeg; writes index.html and frames/)
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const FRAME = {x: 120, y: 112, w: 1680, h: 945}; // where the recordings sit on the canvas
const PANES = { // the panes of the herdr session recordings
  editor: [50, 38, 1072, 603],
  shell: [50, 663, 1072, 402],
  chat: [1132, 38, 780, 1030],
};

const SCENES = [
  {id: 'intro', kind: 'intro', pad: 1.1},
  {
    id: 'install', n: '01', title: 'Install once',
    shots: [{clip: 'install', from: 0.3, to: 17.3, rate: 0.876}],
    chips: [
      {at: 0.6, until: 10.5, text: 'npm install -g github:makefunstuff/pairing-buddy'},
      {at: 10.5, until: 19.4, text: 'pair setup'},
    ],
    marks: [{at: 12.4, until: 18.6, box: [4, 322, 1340, 32], label: 'a systemd user service', below: true}],
  },
  {
    id: 'config', n: '02', title: 'Set your models',
    shots: [{clip: 'install', from: 17.3, to: 36.3, rate: 0.84}],
    chips: [
      {at: 0.5, until: 7.5, text: '~/.config/pairing-buddy/config.json'},
      {at: 18.6, until: 22.6, text: 'systemctl --user restart pairing-buddy'},
    ],
    zooms: [{at: 4.6, box: [60, 130, 1800, 760]}, {at: 17.2, box: 'full'}],
    marks: [
      {at: 6, until: 11, box: [150, 258, 1620, 222], label: 'Watcher: fast, scores with one number'},
      {at: 11, until: 16.6, box: [150, 578, 1620, 200], label: 'Partner: writes the words, calls the tools'},
    ],
  },
  {
    id: 'plugin', n: '03', title: 'Add the Neovim plugin',
    shots: [{clip: 'install', from: 36.3, to: 48.4, rate: 0.864}],
    zooms: [{at: 4.6, box: [40, 250, 1300, 520]}],
    marks: [
      {at: 5.2, until: 9.4, box: [120, 316, 500, 140], label: 'lazy.nvim, auto_connect'},
      {at: 9.6, until: 14, box: [84, 694, 1080, 40], label: "require('pair').status()"},
    ],
  },
  {
    id: 'start', n: '04', title: 'Start a session in herdr',
    shots: [{clip: 'session', from: 0, to: 13, rate: 0.81}],
    chips: [
      {at: 0.3, until: 5.5, text: 'pair'},
      {at: 6, until: 12, text: 'type the session goal'},
    ],
    marks: [
      {at: 5.9, until: 10.4, box: PANES.chat, label: 'the chat pane'},
      {at: 12.2, until: 16, box: [770, 580, 345, 32], label: 'already connected'},
    ],
  },
  {
    id: 'doctor', n: '05', title: 'Check it: pair doctor',
    shots: [{clip: 'session', from: 13, to: 21}],
    chips: [{at: 0.3, until: 6, text: 'pair doctor'}],
    zooms: [{at: 2.6, box: PANES.shell}, {at: 12.6, box: 'full'}],
  },
  {
    id: 'ask', n: '06', title: 'Ask, and take a suggestion',
    shots: [
      {clip: 'session', from: 21, to: 35, rate: 1.3},
      {clip: 'session', from: 35, to: 45, rate: 4, badge: 'waiting for the model · 4× speed'},
      {clip: 'session', from: 45, to: 48},
      {clip: 'session', from: 86.5, to: 97.5},
    ],
    chips: [
      {at: 3.6, until: 10.6, text: 'ask in the chat'},
      {at: 17.2, until: 19.6, text: 'Alt-y  accept'},
      {at: 19.6, until: 22.2, text: ':w'},
      {at: 22.4, until: 27.3, text: 'npm test'},
    ],
    zooms: [
      {at: 0.5, box: PANES.shell}, {at: 3.4, box: [1132, 38, 780, 500]},
      {at: 13.4, box: [50, 150, 1100, 330]}, {at: 22.4, box: PANES.shell},
    ],
    marks: [
      {at: 13.8, until: 17.4, box: [125, 291, 480, 29], label: 'the old line', tone: 'red'},
      {at: 14.6, until: 17.4, box: [125, 320, 480, 29], label: 'ghost text: the fix', tone: 'green', below: true},
    ],
  },
  {
    id: 'watcher', n: '07', title: 'The Watcher speaks up',
    shots: [
      {clip: 'watcher', from: 0, to: 4.7},
      {clip: 'watcher', from: 4.7, to: 19, rate: 3, badge: '3× speed'},
      {clip: 'watcher', from: 19, to: 22},
      {clip: 'watcher', from: 116, to: 120.5, badge: '90 s later'},
      {clip: 'watcher', from: 158, to: 172, rate: 2.5, badge: '2.5× speed'},
      {clip: 'watcher', from: 207.5, to: 213},
    ],
    chips: [{at: 0.6, until: 6.4, text: '/level quiet | normal | chatty'}],
    zooms: [
      {at: 0, box: [1132, 38, 780, 420]}, {at: 4.7, box: 'full'}, {at: 9.6, box: [1132, 180, 780, 360]},
      {at: 13.4, box: [1132, 260, 780, 340]}, {at: 17, box: PANES.editor}, {at: 24.4, box: [1132, 300, 780, 360]},
    ],
    tags: [
      {at: 10.2, until: 12.47, text: 'repeated failure'},
      {at: 14.4, until: 16.97, text: 'stall after a failure'},
      {at: 25.8, until: 28.3, text: 'drift from the goal'},
    ],
  },
  {
    id: 'feedback', n: '08', title: 'Tell it what helped',
    shots: [{clip: 'watcher', from: 152, to: 158}, {clip: 'down', from: 0, to: 7.8}],
    chips: [
      {at: 0.4, until: 3.6, text: '+ useful    - noise'},
      {at: 3.6, until: 6.4, text: 'Alt-u / Alt-n in Neovim'},
      {at: 6.4, until: 13.8, text: 'pair stats'},
    ],
    zooms: [{at: 0, box: [1132, 300, 780, 340]}, {at: 6, box: [50, 663, 1072, 402]}],
  },
  {
    id: 'down', n: '09', title: 'When a model is down',
    shots: [{clip: 'down', from: 10, to: 20}, {clip: 'down', from: 25, to: 29.8, badge: 'a probe every 30 s'}],
    zooms: [{at: 0, box: [1132, 420, 780, 330]}, {at: 8.2, box: [420, 520, 720, 120]}, {at: 11, box: [1132, 470, 780, 300]}],
    marks: [{at: 8.6, until: 10.8, box: [780, 582, 345, 30], label: 'partner down', tone: 'red'}],
  },
  {id: 'outro', kind: 'outro', pad: 3},
];

const CHEATS = [
  ['/goal <text>', 'set the session goal'],
  ['/level quiet | normal | chatty', 'how often Pair speaks up'],
  ['+  -   ·   Alt-u  Alt-n', 'rate a remark'],
  ['Alt-y', 'accept a suggestion'],
  ['your turn   ·   :Pair drive', 'hand over one change'],
  ['/scout', 'search and run tests in its own pane'],
  ['/end', 'end the session with a note'],
  ['pair doctor   ·   pair stats', 'check every part · see the numbers'],
];

const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8'}).trim();
const seconds = file => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${here}${file}`]));
const r = value => Math.round(value * 1000) / 1000;
const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Timing: each scene as long as its voice (plus a pause), or its shots if those run longer.
let clock = 0;
const media = [];
const timeline = [];
mkdirSync(`${here}frames`, {recursive: true});
for (const scene of SCENES) {
  const voice = seconds(`audio/${scene.id}.mp3`);
  let at = 0;
  const shots = (scene.shots ?? []).map(shot => {
    const rate = shot.rate ?? 1;
    const duration = r((shot.to - shot.from) / rate);
    const placed = {...shot, rate, start: at, duration};
    at = r(at + duration);
    return placed;
  });
  const length = r(Math.max(voice + (scene.pad ?? 0.8), at));
  const start = r(clock);
  shots.forEach((shot, i) => {
    const rate = shot.rate === 1 ? '' : ` data-playback-rate="${shot.rate}"`;
    media.push(`<video id="v-${scene.id}-${i}" class="shot" src="clips/${shot.clip}.mp4" data-start="${r(start + shot.start)}" data-duration="${shot.duration}" data-media-start="${shot.from}"${rate} data-track-index="1" muted playsinline></video>`);
  });
  if (shots.length && at < length - 0.02) { // hold the last frame for the rest of the voice
    const last = shots.at(-1);
    const still = `frames/${scene.id}-hold.png`;
    run('ffmpeg', ['-v', 'error', '-y', '-ss', String(last.to - 0.08), '-i', `${here}clips/${last.clip}.mp4`, '-frames:v', '1', `${here}${still}`]);
    media.push(`<img id="h-${scene.id}" class="shot" src="${still}" alt="" data-start="${r(start + at)}" data-duration="${r(length - at)}" data-track-index="1" />`);
  }
  media.push(`<audio id="vo-${scene.id}" src="audio/${scene.id}.mp3" data-start="${r(start + 0.3)}" data-duration="${r(voice)}" data-track-index="10" data-volume="1"></audio>`);
  timeline.push({...scene, start, length, shots});
  clock += length;
}
const total = r(clock);

const headers = timeline.filter(scene => scene.n).map(scene =>
  `<div class="hd" id="hd-${scene.id}"><span class="hd-n">${scene.n}</span><span class="hd-t">${esc(scene.title)}</span></div>`);
const chips = timeline.flatMap(scene => (scene.chips ?? []).map((chip, i) =>
  `<div class="chip" id="chip-${scene.id}-${i}"><span class="chip-k">${esc(chip.text)}</span></div>`));
const tags = timeline.flatMap(scene => (scene.tags ?? []).map((tag, i) =>
  `<div class="tag" id="tag-${scene.id}-${i}">${esc(tag.text)}</div>`));
const badges = timeline.flatMap(scene => scene.shots.filter(shot => shot.badge).map((shot, i) =>
  `<div class="badge" id="badge-${scene.id}-${i}">${esc(shot.badge)}</div>`));
const marks = timeline.flatMap(scene => (scene.marks ?? []).map((mark, i) => {
  const [x, y, w, h] = mark.box;
  return `<div class="mark mark-${mark.tone ?? 'blue'}${mark.below ? ' mark-below' : ''}" id="mark-${scene.id}-${i}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"><span class="mark-l">${esc(mark.label)}</span></div>`;
}));
const cheats = CHEATS.map(([keys, what], i) =>
  `<div class="cheat" id="cheat-${i}"><span class="cheat-k">${esc(keys)}</span><span class="cheat-w">${esc(what)}</span></div>`);

// What the script animates, at absolute times.
const plan = timeline.map(scene => ({
  id: scene.id, kind: scene.kind ?? 'shots', start: scene.start, length: scene.length, header: Boolean(scene.n),
  chips: scene.chips ?? [], tags: scene.tags ?? [], marks: scene.marks ?? [],
  zooms: (scene.zooms ?? []).map(zoom => ({at: zoom.at, box: zoom.box === 'full' ? null : zoom.box})),
  badges: scene.shots.filter(shot => shot.badge).map(shot => ({at: shot.start, until: r(shot.start + shot.duration)})),
}));

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>pairing-buddy: how to use it</title>
    <!-- Generated by build.mjs: edit the scene list there, then run node build.mjs -->
    <script src="vendor/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Inter"; font-weight: 500; src: url("fonts/inter-500.woff2") format("woff2"); }
      @font-face { font-family: "Inter"; font-weight: 700; src: url("fonts/inter-700.woff2") format("woff2"); }
      @font-face { font-family: "Inter"; font-weight: 800; src: url("fonts/inter-800.woff2") format("woff2"); }
      @font-face { font-family: "JetBrains Mono"; font-weight: 400; src: url("fonts/jetbrains-mono-400.woff2") format("woff2"); }
      @font-face { font-family: "JetBrains Mono"; font-weight: 700; src: url("fonts/jetbrains-mono-700.woff2") format("woff2"); }
      :root {
        --bg: #0d0f17; --panel: #16161e; --line: #2a2e42; --text: #c0caf5; --dim: #8a92b8;
        --blue: #7aa2f7; --cyan: #7dcfff; --green: #9ece6a; --red: #f7768e; --orange: #ff9e64; --violet: #bb9af7;
      }
      html, body { margin: 0; background: var(--bg); color: var(--text); font-family: "Inter", sans-serif; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--bg); }
      #bg { position: absolute; inset: 0;
        background: radial-gradient(1200px 700px at 78% -10%, rgba(122,162,247,0.16), transparent 70%),
                    radial-gradient(900px 600px at 0% 110%, rgba(187,154,247,0.12), transparent 70%), var(--bg); }
      #grid { position: absolute; inset: 0; opacity: 0.35;
        background-image: linear-gradient(rgba(122,162,247,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(122,162,247,0.06) 1px, transparent 1px);
        background-size: 48px 48px; }
      #frame { position: absolute; left: ${FRAME.x}px; top: ${FRAME.y}px; width: ${FRAME.w}px; height: ${FRAME.h}px;
        border-radius: 16px; overflow: hidden; background: #16161e; opacity: 0;
        box-shadow: 0 0 0 1px var(--line), 0 30px 80px rgba(0,0,0,0.55); }
      #cam { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
      .shot { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: cover; }
      #wipe { position: absolute; inset: 0; background: linear-gradient(90deg, var(--blue), var(--violet)); }
      .hd { position: absolute; left: ${FRAME.x}px; top: 34px; display: flex; align-items: baseline; gap: 20px; opacity: 0; }
      .hd-n { font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 30px; color: var(--blue); }
      .hd-t { font-weight: 700; font-size: 44px; color: #e3e8ff; letter-spacing: -0.5px; }
      #brand { position: absolute; right: ${1920 - FRAME.x - FRAME.w}px; top: 48px; font-family: "JetBrains Mono", monospace;
        font-size: 22px; color: var(--dim); opacity: 0; }
      .chip { position: absolute; left: ${FRAME.x + 36}px; top: ${FRAME.y + FRAME.h - 112}px; opacity: 0; }
      .chip-k { display: inline-block; font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 34px; color: #e3e8ff;
        padding: 16px 26px; border-radius: 12px; background: rgba(13,15,23,0.92);
        box-shadow: 0 0 0 2px var(--blue), 0 12px 32px rgba(0,0,0,0.5); }
      .tag { position: absolute; right: ${1920 - FRAME.x - FRAME.w + 36}px; top: ${FRAME.y + 32}px; opacity: 0;
        font-weight: 700; font-size: 32px; color: #0d0f17; background: var(--orange); padding: 12px 24px; border-radius: 999px; }
      .badge { position: absolute; left: ${FRAME.x + 36}px; top: ${FRAME.y + 32}px; opacity: 0;
        font-family: "JetBrains Mono", monospace; font-size: 24px; color: var(--text);
        background: rgba(13,15,23,0.88); padding: 10px 18px; border-radius: 10px; box-shadow: 0 0 0 1px var(--line); }
      .mark { position: absolute; border-radius: 8px; opacity: 0; box-shadow: 0 0 0 3px var(--blue), 0 0 24px rgba(122,162,247,0.55); }
      .mark-red { box-shadow: 0 0 0 3px var(--red), 0 0 24px rgba(247,118,142,0.55); }
      .mark-green { box-shadow: 0 0 0 3px var(--green), 0 0 24px rgba(158,206,106,0.55); }
      .mark-l { position: absolute; left: 0; bottom: calc(100% + 10px); white-space: nowrap; font-weight: 700; font-size: 22px;
        color: #0d0f17; background: var(--blue); padding: 6px 12px; border-radius: 6px; }
      .mark-red .mark-l { background: var(--red); }
      .mark-green .mark-l { background: var(--green); }
      .mark-below .mark-l { bottom: auto; top: calc(100% + 10px); }
      #intro, #outro { position: absolute; inset: 0; opacity: 0; }
      .intro-stack { position: absolute; left: 0; right: 0; top: 250px; display: flex; flex-direction: column; align-items: center; }
      #intro-eyebrow { font-family: "JetBrains Mono", monospace; font-size: 26px; letter-spacing: 6px; color: var(--blue); }
      #intro-title { margin-top: 18px; font-weight: 800; font-size: 150px; letter-spacing: -4px; color: #eef1ff; }
      #intro-sub { margin-top: 8px; font-weight: 500; font-size: 44px; color: var(--dim); }
      .intro-row { position: absolute; left: 0; right: 0; top: 720px; display: flex; justify-content: center; align-items: center; gap: 0; }
      .node { font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 30px; padding: 20px 32px; border-radius: 14px;
        background: var(--panel); box-shadow: 0 0 0 2px var(--line); color: var(--text); opacity: 0; }
      #node-pair { color: #0d0f17; background: var(--blue); box-shadow: 0 0 0 2px var(--blue), 0 0 40px rgba(122,162,247,0.5); }
      .wire { width: 150px; height: 3px; background: linear-gradient(90deg, var(--blue), var(--violet)); transform-origin: 0 50%; }
      #outro-title { position: absolute; left: 160px; top: 96px; font-weight: 800; font-size: 76px; letter-spacing: -2px; color: #eef1ff; opacity: 0; }
      .cheats { position: absolute; left: 160px; right: 160px; top: 230px; display: flex; flex-direction: column; gap: 22px; }
      .cheat { display: flex; align-items: center; gap: 34px; opacity: 0; }
      .cheat-k { flex: 0 0 820px; font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 34px; color: var(--cyan);
        padding: 14px 24px; border-radius: 12px; background: var(--panel); box-shadow: 0 0 0 1px var(--line); }
      .cheat-w { font-size: 34px; font-weight: 500; color: var(--text); }
      #outro-url { position: absolute; left: 160px; top: 960px; font-family: "JetBrains Mono", monospace; font-size: 30px; color: var(--blue); opacity: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="${total}">
      <div id="bg"></div>
      <div id="grid"></div>
      <div id="frame">
        <div id="cam" data-layout-allow-overflow>
          ${media.filter(tag => !tag.startsWith('<audio')).join('\n          ')}
          ${marks.join('\n          ')}
        </div>
        <div id="wipe" data-layout-allow-overflow></div>
      </div>
      ${headers.join('\n      ')}
      <div id="brand">pairing-buddy · tutorial</div>
      ${badges.join('\n      ')}
      ${tags.join('\n      ')}
      ${chips.join('\n      ')}
      <div id="intro">
        <div class="intro-stack">
          <div id="intro-eyebrow">TUTORIAL</div>
          <div id="intro-title">pairing-buddy</div>
          <div id="intro-sub">How to use it, day to day</div>
        </div>
        <div class="intro-row">
          <div class="node" id="node-nvim">Neovim</div>
          <div class="wire" id="wire-a"></div>
          <div class="node" id="node-pair">pair</div>
          <div class="wire" id="wire-b"></div>
          <div class="node" id="node-herdr">herdr chat pane</div>
        </div>
      </div>
      <div id="outro">
        <div id="outro-title">The daily loop</div>
        <div class="cheats">
          ${cheats.join('\n          ')}
        </div>
        <div id="outro-url">github.com/makefunstuff/pairing-buddy</div>
      </div>
      ${media.filter(tag => tag.startsWith('<audio')).join('\n      ')}
    </div>
    <script>
      const PLAN = ${JSON.stringify(plan)};
      const FRAME = ${JSON.stringify(FRAME)};
      const BASE = FRAME.w / 1920;
      // The camera transform that fits a box of the recording into the frame (null: the whole recording).
      function view(box) {
        if (!box) return {x: 0, y: 0, scale: BASE};
        const [x, y, w, h] = box;
        const scale = Math.min(Math.max(Math.min(FRAME.w / w, FRAME.h / h) * 0.94, BASE), 2.4);
        const clamp = (value, low) => Math.min(0, Math.max(low, value));
        return {
          scale,
          x: clamp(FRAME.w / 2 - scale * (x + w / 2), FRAME.w - scale * 1920),
          y: clamp(FRAME.h / 2 - scale * (y + h / 2), FRAME.h - scale * 1080),
        };
      }
      const tl = gsap.timeline({paused: true});
      tl.set('#cam', {transformOrigin: '0 0', ...view(null)}, 0);
      tl.set('#wipe', {xPercent: -101}, 0);
      const show = (target, at, until, from = {y: 16}) => {
        tl.fromTo(target, {opacity: 0, ...from}, {opacity: 1, x: 0, y: 0, duration: 0.35, ease: 'power3.out'}, at);
        tl.to(target, {opacity: 0, duration: 0.25, ease: 'power1.in'}, until - 0.25);
      };
      for (const scene of PLAN) {
        const t0 = scene.start;
        const end = t0 + scene.length;
        if (scene.kind === 'intro') {
          tl.to('#intro', {opacity: 1, duration: 0.5}, t0);
          tl.from('#intro-eyebrow', {opacity: 0, y: 20, duration: 0.6, ease: 'power3.out'}, t0 + 0.2);
          tl.from('#intro-title', {opacity: 0, y: 60, scale: 0.94, duration: 0.9, ease: 'expo.out'}, t0 + 0.35);
          tl.from('#intro-sub', {opacity: 0, y: 24, duration: 0.7, ease: 'power3.out'}, t0 + 0.9);
          ['#node-nvim', '#node-pair', '#node-herdr'].forEach((node, i) =>
            tl.fromTo(node, {opacity: 0, y: 30}, {opacity: 1, y: 0, duration: 0.6, ease: 'back.out(1.6)'}, t0 + 2.4 + i * 0.9));
          tl.fromTo('#wire-a', {scaleX: 0}, {scaleX: 1, duration: 0.6, ease: 'power2.inOut'}, t0 + 2.9);
          tl.fromTo('#wire-b', {scaleX: 0}, {scaleX: 1, duration: 0.6, ease: 'power2.inOut'}, t0 + 3.8);
          tl.to('#node-pair', {scale: 1.08, duration: 0.5, yoyo: true, repeat: 3, ease: 'sine.inOut'}, t0 + 5.2);
          tl.to('#intro', {opacity: 0, y: -30, duration: 0.6, ease: 'power2.in'}, end - 0.6);
          continue;
        }
        if (scene.kind === 'outro') {
          tl.to('#frame', {opacity: 0, scale: 0.96, duration: 0.5, ease: 'power2.in'}, t0 - 0.5);
          tl.to('#brand', {opacity: 0, duration: 0.4}, t0 - 0.4);
          tl.to('#outro', {opacity: 1, duration: 0.3}, t0);
          tl.fromTo('#outro-title', {opacity: 0, y: 30}, {opacity: 1, y: 0, duration: 0.7, ease: 'expo.out'}, t0 + 0.1);
          const step = 15 / ${CHEATS.length};
          document.querySelectorAll('.cheat').forEach((row, i) =>
            tl.fromTo(row, {opacity: 0, x: -40}, {opacity: 1, x: 0, duration: 0.5, ease: 'power3.out'}, t0 + 1.2 + i * step));
          tl.fromTo('#outro-url', {opacity: 0, y: 16}, {opacity: 1, y: 0, duration: 0.6, ease: 'power3.out'}, end - 4);
          continue;
        }
        if (t0 > 0 && PLAN[0].kind === 'intro' && scene === PLAN[1]) {
          tl.fromTo('#frame', {opacity: 0, y: 40, scale: 0.97}, {opacity: 1, y: 0, scale: 1, duration: 0.8, ease: 'expo.out'}, t0);
          tl.to('#brand', {opacity: 1, duration: 0.6}, t0 + 0.4);
        } else {
          // A wipe across the frame hides the cut between two scenes.
          tl.fromTo('#wipe', {xPercent: -101}, {xPercent: 0, duration: 0.22, ease: 'power2.in'}, t0 - 0.22);
          tl.to('#wipe', {xPercent: 101, duration: 0.32, ease: 'power2.out'}, t0);
        }
        tl.set('#cam', view(null), t0);
        if (scene.header) show('#hd-' + scene.id, t0 + 0.15, end, {y: 24});
        scene.zooms.forEach(zoom => tl.to('#cam', {...view(zoom.box), duration: 1.1, ease: 'power3.inOut'}, t0 + zoom.at));
        scene.chips.forEach((chip, i) => show('#chip-' + scene.id + '-' + i, t0 + chip.at, t0 + chip.until));
        scene.tags.forEach((tag, i) => show('#tag-' + scene.id + '-' + i, t0 + tag.at, t0 + tag.until, {y: -12}));
        scene.badges.forEach((badge, i) => show('#badge-' + scene.id + '-' + i, t0 + badge.at, t0 + badge.until, {y: -8}));
        scene.marks.forEach((mark, i) => show('#mark-' + scene.id + '-' + i, t0 + mark.at, t0 + mark.until, {scale: 1.06}));
      }
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
writeFileSync(`${here}index.html`, html);
console.log(`index.html: ${timeline.length} scenes, ${total} s`);
for (const scene of timeline) console.log(`  ${scene.id.padEnd(9)} ${scene.start.toFixed(1).padStart(6)} s  ${scene.length.toFixed(1)} s`);
