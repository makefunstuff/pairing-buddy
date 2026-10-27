// Builds the HyperFrames composition of the tutorial from script.mjs: index.html (the tutorial) or, with
// `node build.mjs short`, short.html (the cut for social media). Also writes the captions (captions.vtt or
// captions-short.vtt), and for the tutorial chapters.json and chapters.vtt, and stills into frames/.
//
// Every scene has three parts, so it is clear what to watch before anything moves:
//   1. a title card: the situation, and where to look (a small map of the screen lights that area up);
//   2. the capture, at its real size first, then the camera moves in on the spot that changes, the rest dims, and a
//      box with a label points at it; a before/after when the code changes;
//   3. one line that sums up what happened, over the last frame.
// The voice says each line at the time script.mjs gives it (audio/<scene>-<n>.mp3, from tts.mjs); a line that
// would start before the one before it ended waits for it, and the scene lasts until its last line and its shots end.
// Usage: node build.mjs [short]   (needs ffprobe and ffmpeg)
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {AREAS, CHAPTERS, CHEATS, SHORT, TOUR, lines} from './script.mjs';

const here = new URL('.', import.meta.url).pathname;
const CUT = process.argv[2] === 'short' ? 'short' : 'tour';
const SCENES = CUT === 'short' ? SHORT : TOUR;
// Where a capture (1920x1080) sits on the canvas: at 4/5 of its size, in a pixel window, with the captions under it.
const FRAME = {x: 192, y: 46, w: 1536, h: 864}; // 16:9, under a pixel window's title bar
const BASE = FRAME.w / 1920;
const GAP = 0.35; // between two lines of the voice
const CARD_PAD = 1.1; // a title card stays this long after its voice
const SUM_PAD = 1.3;
const CHAPTER = 2.6;
const MUSIC = {volume: 0.1};

const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8'}).trim();
const seconds = file => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${here}${file}`]));
const r = value => Math.round(value * 1000) / 1000;
const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const WORDS = existsSync(`${here}words.json`) ? JSON.parse(readFileSync(`${here}words.json`, 'utf8')) : {};
const voice = id => {
  if (!existsSync(`${here}audio/${id}.mp3`)) throw new Error(`no audio/${id}.mp3: run node tts.mjs`);
  return seconds(`audio/${id}.mp3`);
};

/** The camera that fits a box of a capture into the frame (null: all of it). */
function view(box) {
  if (!box) return {x: 0, y: 0, scale: BASE};
  const [x, y, w, h] = box;
  const scale = Math.min(Math.max(Math.min(FRAME.w / w, FRAME.h / h) * 0.9, BASE), 2.4);
  const clamp = (value, low) => Math.min(0, Math.max(low, value));
  return {scale, x: clamp(FRAME.w / 2 - scale * (x + w / 2), FRAME.w - scale * 1920), y: clamp(FRAME.h / 2 - scale * (y + h / 2), FRAME.h - scale * 1080)};
}

mkdirSync(`${here}frames`, {recursive: true});
const still = (clip, t, name) => {
  run('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', `${here}clips/${clip}.mp4`, '-frames:v', '1', `${here}frames/${name}.png`]);
  return `frames/${name}.png`;
};

/** Where a time `t` of the take falls in a scene's shots, in seconds from their start: after any hold at `t`. */
function inShots(shots, t) {
  const plays = shots.filter(shot => !shot.hold);
  const shot = plays.find(shot => t >= shot.from - 0.001 && t < shot.to - 0.001) ?? plays.find(shot => Math.abs(t - shot.to) < 0.002);
  if (!shot) throw new Error(`no shot plays ${t} s of the take`);
  return shot.start + (t - shot.from) / shot.rate;
}

/** Shots in a row: each gets its `start` and `duration` in the scene; a `hold` is a still of the take at `at`. */
function lay(list) {
  let at = 0;
  return list.map(shot => {
    const rate = shot.hold ? 1 : shot.rate ?? 1;
    const duration = r(shot.hold ? shot.hold : (shot.to - shot.from) / rate);
    const placed = shot.hold ? {...shot, from: shot.at, to: shot.at, rate, start: r(at), duration} : {...shot, rate, start: r(at), duration};
    at += duration;
    return placed;
  });
}

/** The shots with the picture held still for `hold` seconds at the take's time `t` (a hold there grows). */
function holdAt(list, {t, hold}) {
  const i = list.findIndex(shot => !shot.hold && t >= shot.from - 0.001 && t < shot.to - 0.001);
  if (i < 0) return [...list, {clip: list.at(-1).clip, hold, at: t}];
  const shot = list[i];
  if (Math.abs(t - shot.from) < 0.002) {
    if (list[i - 1]?.hold && Math.abs(list[i - 1].at - t) < 0.002) return list.map((s, k) => (k === i - 1 ? {...s, hold: r(s.hold + hold)} : s));
    return [...list.slice(0, i), {clip: shot.clip, hold, at: t}, ...list.slice(i)];
  }
  return [...list.slice(0, i), {...shot, to: t}, {clip: shot.clip, hold, at: t}, {...shot, from: t}, ...list.slice(i + 1)];
}

// Timing. A scene's lines of voice are placed in order: each at its `at` (seconds into its part), or later if the
// line before it is still being said. Lines with `at: 'card'` belong to the title card, `at: 'sum'` to the sum.
let clock = 0;
const media = [];
const timeline = [];
const said = []; // every line of voice: {id, start, length, scene}
const late = [];
for (const scene of SCENES) {
  if (scene.chapter) {
    timeline.push({kind: 'chapter', id: `ch${scene.chapter}`, chapter: scene.chapter, start: r(clock), length: CHAPTER});
    clock += CHAPTER;
    continue;
  }
  const all = lines(scene);
  const place = (part, from) => { // the lines of one part, from `from` on the clock; returns where the last one ends
    let end = from;
    for (const line of all.filter(line => line.part === part)) {
      const want = from + (line.at?.t !== undefined ? inShots(shots, line.at.t) + (line.at.plus ?? 0) : line.at ?? 0.3);
      const start = Math.max(want, end + (end > from ? GAP : 0));
      if (line.at?.t !== undefined && start > want + 0.05) late.push(`${line.id}: ${r(start - want)} s late`);
      const length = voice(line.id);
      said.push({id: line.id, start: r(start), length: r(length), scene: scene.id});
      end = start + length;
    }
    return end;
  };
  const start = clock;
  // 1. The title card (scenes of their own kind, like the intro, have only a panel).
  let cardLength = 0;
  if (scene.card) {
    cardLength = r(Math.max(place('card', start) - start + CARD_PAD, 3.2));
  }
  // 2. The shots. A line of voice timed to a moment of the take (`at: {t}`) that would start late, because the line
  // before it is still being said, holds the picture still just before that moment until the voice is there.
  const bodyStart = start + cardLength;
  let source = [...(scene.shots ?? [])];
  for (let pass = 0; pass < 60; pass++) {
    const trial = lay(source);
    let end = 0;
    let wait = null;
    for (const line of all.filter(line => line.part === 'body')) {
      const timed = line.at?.t !== undefined;
      const want = timed ? inShots(trial, line.at.t) + (line.at.plus ?? 0) : line.at ?? 0.3;
      const begin = Math.max(want, end > 0 ? end + GAP : 0);
      if (timed && begin > want + 0.05) { wait = {t: line.at.t, hold: r(begin - want + 0.2)}; break; }
      end = begin + voice(line.id);
    }
    if (!wait) break;
    source = holdAt(source, wait);
  }
  const shots = lay(source);
  const at = shots.length ? shots.at(-1).start + shots.at(-1).duration : 0;
  const voiceEnd = place('body', bodyStart) - bodyStart;
  // A before/after gets time of its own to be read.
  const compareEnd = scene.compare?.at?.t !== undefined ? inShots(shots, scene.compare.at.t) + (scene.compare.length ?? 6) : 0;
  const bodyLength = r(Math.max(at, voiceEnd + (scene.pad ?? 1), scene.min ?? 0, compareEnd));
  // 3. The sum.
  const sumStart = bodyStart + bodyLength;
  const sumLength = !scene.sum ? 0 : scene.quietSum ? 2.6 : r(place('sum', sumStart) - sumStart + SUM_PAD);
  const length = r(cardLength + bodyLength + sumLength);
  shots.forEach((shot, i) => {
    if (shot.hold) {
      media.push(`<img id="v-${scene.id}-${i}" class="clip shot" src="${still(shot.clip, Math.max(0, shot.at - 0.04), `${scene.id}-${i}`)}" alt="" data-start="${r(bodyStart + shot.start)}" data-duration="${shot.duration}" data-track-index="1" />`);
      return;
    }
    const rate = shot.rate === 1 ? '' : ` data-playback-rate="${shot.rate}"`;
    media.push(`<video id="v-${scene.id}-${i}" class="clip shot" src="clips/${shot.clip}.mp4" data-start="${r(bodyStart + shot.start)}" data-duration="${shot.duration}" data-media-start="${shot.from}"${rate} data-track-index="1" muted playsinline></video>`);
  });
  if (shots.length && at < bodyLength + sumLength - 0.02) { // the last frame holds through the rest and the sum
    const last = shots.at(-1);
    media.push(`<img id="h-${scene.id}" class="clip shot" src="${still(last.clip, last.to - 0.05, `${scene.id}-hold`)}" alt="" data-start="${r(bodyStart + at)}" data-duration="${r(bodyLength + sumLength - at)}" data-track-index="1" />`);
  }
  timeline.push({...scene, kind: scene.kind ?? 'shots', start: r(start), length, cardLength, bodyStart: r(bodyStart), bodyLength, sumStart: r(sumStart), sumLength, shots});
  clock += length;
}
const total = r(clock);
for (const line of said) {
  media.push(`<audio id="vo-${line.id}" class="clip" src="audio/${line.id}.mp3" data-start="${line.start}" data-duration="${line.length}" data-track-index="10" data-volume="1"></audio>`);
}
if (existsSync(`${here}audio/music.mp3`)) { // the bed, under the whole film, faded in and out
  const length = Math.min(total, seconds('audio/music.mp3'));
  media.push(`<audio id="music" class="clip" src="audio/music.mp3" data-start="${r(total - length)}" data-duration="${r(length)}" data-track-index="11" data-volume="${MUSIC.volume}" data-fade-in="2" data-fade-out="4"></audio>`);
}

// The overlays, with their absolute times for the script.
const html = [];
const inCam = [];
const plan = [];
// Everything that shows stays at least 0.9 s, so its fade-out never comes before its fade-in.
const tw = (selector, at, until, kind, extra = {}) => plan.push({selector, at: r(at), until: r(Math.max(until, at + 0.9)), kind, ...extra});
const sayAt = (scene, id) => said.find(line => line.id === id)?.start;
/** A time in a scene's capture part: seconds, `{t}` (a time in the take, wherever its shot plays it), or `{line: n}`,
 * when the voice starts its nth line (n from 1); either may add `plus` seconds. */
const when = (scene, value) => (typeof value === 'number' ? scene.bodyStart + value
  : value.t !== undefined ? scene.bodyStart + inShots(scene.shots, value.t) + (value.plus ?? 0)
  : sayAt(scene, `${scene.id}-${value.line}`) + (value.plus ?? 0));

// The pointer under (or over) a spot's label: a pixel triangle.
const POINTER = '<svg viewBox="0 0 5 3" shape-rendering="crispEdges" aria-hidden="true"><path d="M0 0h5v1H0zM1 1h3v1H1zM2 2h1v1H2z" fill="#000"/></svg>';

/** A little map of the screen, the area to watch lit: for the title cards. */
function screenMap(watch) {
  const boxes = Object.entries(AREAS).filter(([, area]) => area.map).map(([key, area]) => {
    const [x, y, w, h] = area.map;
    return `<div class="map-a${watch?.includes(key) ? ' map-on' : ''}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"><span>${esc(area.short)}</span></div>`;
  });
  return `<div class="map">${boxes.join('')}</div>`;
}

for (const scene of timeline) {
  const t0 = scene.start;
  const end = t0 + scene.length;
  if (scene.kind === 'chapter') {
    const [title, sub] = CHAPTERS[scene.chapter];
    html.push(`<div class="chapter" id="${scene.id}"><div class="chapter-n">${scene.chapter}</div><div class="chapter-t">${esc(title)}</div><div class="chapter-s">${esc(sub)}</div></div>`);
    tw(`#${scene.id}`, t0, end, 'chapter');
    continue;
  }
  if (scene.kind === 'panel') {
    html.push(`<div class="panel" id="p-${scene.id}">${scene.panel}</div>`);
    tw(`#p-${scene.id}`, t0, end, 'panel');
    (scene.reveal ?? []).forEach((step, i) => tw(`#p-${scene.id} .r${i}`, when(scene, step), end, 'reveal'));
    continue;
  }
  // The title card.
  if (scene.card) {
    const {situation, watch, area} = scene.card;
    html.push(`<div class="tcard" id="card-${scene.id}">
        <div class="tcard-text">
          ${scene.ch ? `<div class="tcard-c">${scene.ch} · ${esc(CHAPTERS[scene.ch][0])}</div>` : ''}
          <div class="tcard-s">${esc(situation)}</div>
          <div class="tcard-w"><span class="eye">Watch</span>${esc(watch)}</div>
        </div>
        ${screenMap(area)}
      </div>`);
    tw(`#card-${scene.id}`, t0, scene.bodyStart, 'card');
  }
  // The scene's name and chapter, small, in the band under the frame while the capture plays.
  html.push(`<div class="tag" id="tag-${scene.id}">${scene.ch ? `${scene.ch} · ` : ''}${esc(scene.title)}</div>`);
  tw(`#tag-${scene.id}`, scene.bodyStart, end, 'fade');
  // The camera: the whole screen first, unless the scene says otherwise.
  plan.push({camera: view(null), at: r(scene.bodyStart), cut: true});
  for (const cam of scene.cams ?? []) plan.push({camera: view(cam.box ?? AREAS[cam.area]?.box ?? null), at: r(when(scene, cam.at)), cut: cam.cut ?? false, slow: cam.slow ?? 1.4});
  // The names of the areas, on the whole screen.
  (scene.areas ?? []).forEach((group, g) => {
    for (const key of group.show) {
      const area = AREAS[key];
      const [x, y, w, h] = area.box;
      const id = `area-${scene.id}-${g}-${key}`;
      inCam.push(`<div class="area" id="${id}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"><span class="area-l">${esc(area.label)}</span></div>`);
      const at = when(scene, group.at) + (group.step ?? 0) * group.show.indexOf(key);
      tw(`#${id}`, at, group.until === undefined ? scene.sumStart : when(scene, group.until), 'area');
    }
  });
  // The spot that changes: the rest dims, a box around it, a label with a pointer.
  (scene.spots ?? []).forEach((spot, i) => {
    const box = spot.box ?? AREAS[spot.area].box;
    const [x, y, w, h] = box;
    const id = `spot-${scene.id}-${i}`;
    const cam = [...(scene.cams ?? [])].reverse().find(c => when(scene, c.at) <= when(scene, spot.at) + 0.01);
    const size = Math.round(28 / view(cam ? cam.box ?? AREAS[cam.area]?.box ?? null : null).scale);
    const place = spot.place ?? 'below';
    const end2 = x + w / 2 > 1300 ? ' spot-end' : '';
    inCam.push(`<div class="spot spot-${place}${end2}${spot.dim === false ? ' spot-nodim' : ''}" id="${id}" style="left:${x - 4}px;top:${y - 3}px;width:${w + 8}px;height:${h + 6}px;--label-size:${size}px">${spot.label ? `<span class="spot-l">${POINTER}${esc(spot.label)}</span>` : ''}</div>`);
    tw(`#${id}`, when(scene, spot.at), spot.until === undefined ? scene.sumStart : when(scene, spot.until), 'spot');
  });
  // What you type, as you type it, and the keys you press.
  (scene.typed ?? []).forEach((typed, i) => {
    const id = `typed-${scene.id}-${i}`;
    html.push(`<div class="typed" id="${id}"><span class="typed-k">${esc(typed.where ?? 'you type')}</span>${esc(typed.text)}</div>`);
    tw(`#${id}`, when(scene, typed.at), typed.until === undefined ? when(scene, typed.at) + 3.2 : when(scene, typed.until), 'chip');
  });
  (scene.keys ?? []).forEach((press, i) => {
    const id = `keys-${scene.id}-${i}`;
    html.push(`<div class="keys" id="${id}">${press.keys.map(key => `<span class="key">${esc(key)}</span>`).join('<span class="plus">+</span>')}${press.note ? `<span class="key-note">${esc(press.note)}</span>` : ''}</div>`);
    tw(`#${id}`, when(scene, press.at), when(scene, press.at) + (press.hold ?? 2.6), 'keys');
  });
  // Shots sped up say so.
  // (one badge over the pieces of a shot that holds for the voice split it into)
  const fast = [];
  for (const shot of scene.shots) {
    if (shot.hold) continue;
    const last = fast.at(-1);
    if (shot.rate > 1.3 && last && last.badge === shot.badge && last.rate === shot.rate && Math.abs(last.to - shot.from) < 0.002) Object.assign(last, {to: shot.to, end: shot.start + shot.duration});
    else if (shot.rate > 1.3) fast.push({badge: shot.badge, rate: shot.rate, to: shot.to, start: shot.start, end: shot.start + shot.duration});
  }
  fast.forEach((span, i) => {
    const id = `fast-${scene.id}-${i}`;
    html.push(`<div class="fast" id="${id}">${esc(span.badge ?? 'waiting')} · ${span.rate}× speed</div>`);
    tw(`#${id}`, scene.bodyStart + span.start, scene.bodyStart + span.end, 'fade');
  });
  // Before and after: two stills of the same box, one over the other.
  if (scene.compare) {
    const {before, after, at, until} = scene.compare;
    const id = `cmp-${scene.id}`;
    const row = (side, name) => {
      const [x, y, w, h] = side.box;
      const scale = Math.min(1440 / w, 360 / h, 2.4);
      const src = still(side.clip, side.t, `${scene.id}-${name}`);
      return `<div class="cmp-row"><div class="cmp-l cmp-${name}">${esc(side.label)}</div><div class="cmp-img" style="width:${Math.round(w * scale)}px;height:${Math.round(h * scale)}px"><img src="${src}" alt="" style="width:${Math.round(1920 * scale)}px;left:${Math.round(-x * scale)}px;top:${Math.round(-y * scale)}px" /></div></div>`;
    };
    html.push(`<div class="cmp" id="${id}">${row(before, 'before')}${row(after, 'after')}</div>`);
    tw(`#${id}`, when(scene, at), until === undefined ? scene.sumStart : when(scene, until), 'compare');
  }
  // The sum.
  if (scene.sum) {
    html.push(`<div class="sum" id="sum-${scene.id}"><span class="sum-m">✓</span>${esc(scene.sum)}</div>`);
    tw(`#sum-${scene.id}`, scene.sumStart, end, 'sum');
  }
}
// The chiptune accents (sfx.sh), quiet under the voice: a blip as each card comes in, a tick for each key press.
plan.filter(step => step.kind === 'card' || step.kind === 'chapter' || step.kind === 'keys').forEach((step, i) => {
  const sound = step.kind === 'keys' ? 'key' : 'card';
  media.push(`<audio id="sfx-${i}" class="clip" src="audio/sfx-${sound}.mp3" data-start="${r(step.at + (sound === 'key' ? 0.25 : 0.05))}" data-duration="${sound === 'key' ? 0.12 : 0.32}" data-track-index="${12 + (i % 2)}" data-volume="${sound === 'key' ? 0.1 : 0.12}"></audio>`);
});
if (late.length) console.warn(`lines that wait for the one before them:\n  ${late.join('\n  ')}`);

// Captions: every line of voice, a sentence at a time (a long one split at a comma), timed by its words.
const captions = [];
for (const line of said) {
  const words = WORDS[line.id];
  if (!words) throw new Error(`no words for ${line.id}: run node words.mjs`);
  const sentences = [];
  let group = [];
  for (const word of words) {
    group.push(word);
    if (/[.?!:]$/.test(word.text)) { sentences.push(group); group = []; }
  }
  if (group.length) sentences.push(group);
  const flush = part => part.length && captions.push({id: `cap-${captions.length}`, start: r(line.start + part[0].start - 0.05), until: r(line.start + part.at(-1).end + 0.3), text: part.map(word => word.text).join(' ')});
  for (const sentence of sentences) {
    if (sentence.length <= 14) { flush(sentence); continue; }
    const commas = sentence.map((word, i) => (/[,;]$/.test(word.text) && i >= 3 && i <= sentence.length - 4 ? i : -1)).filter(i => i >= 0);
    const middle = sentence.length / 2;
    const cut = commas.length ? commas.reduce((best, i) => (Math.abs(i - middle) < Math.abs(best - middle) ? i : best)) : Math.ceil(middle) - 1;
    flush(sentence.slice(0, cut + 1));
    flush(sentence.slice(cut + 1));
  }
}
captions.forEach((caption, i) => { // a caption stays until the next one, when the gap is short
  const next = captions[i + 1];
  if (next && next.start - caption.until < 0.8) caption.until = next.start;
});

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>pairing-buddy: ${CUT === 'short' ? 'the short cut' : 'the tutorial'}</title>
    <!-- Generated by build.mjs from script.mjs: edit the scenes there, then run node build.mjs -->
    <script src="vendor/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Press Start 2P"; font-weight: 400; src: url("fonts/press-start-2p-400.woff2") format("woff2"); }
      @font-face { font-family: "Silkscreen"; font-weight: 400; src: url("fonts/silkscreen-400.woff2") format("woff2"); }
      @font-face { font-family: "Silkscreen"; font-weight: 700; src: url("fonts/silkscreen-700.woff2") format("woff2"); }
      @font-face { font-family: "Pixelify Sans"; font-weight: 400 700; src: url("fonts/pixelify-sans.woff2") format("woff2"); }
      @font-face { font-family: "JetBrains Mono"; font-weight: 400; src: url("fonts/jetbrains-mono-400.woff2") format("woff2"); }
      @font-face { font-family: "JetBrains Mono"; font-weight: 700; src: url("fonts/jetbrains-mono-700.woff2") format("woff2"); }
      :root { /* a small console palette, flat colours only: no gradients, glows, blur or soft shadows */
        --ink: #000000; --bg: #1d2b53; --plum: #7e2553; --leaf: #008751; --grey: #5f574f; --silver: #c2c3c7; --paper: #fff1e8;
        --red: #ff004d; --orange: #ffa300; --yellow: #ffec27; --green: #00e436; --blue: #29adff; --term: #0f1419;
        --pixel: "Press Start 2P", "JetBrains Mono", monospace; --label: "Silkscreen", "JetBrains Mono", monospace;
        --body: "Pixelify Sans", "JetBrains Mono", monospace; --code: "JetBrains Mono", monospace;
      }
      html, body { margin: 0; background: var(--bg); color: var(--paper); font-family: var(--body); font-variant-ligatures: none; -webkit-font-smoothing: none; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--bg); }
      #win { position: absolute; left: ${FRAME.x - 8}px; top: ${FRAME.y - 40}px; width: ${FRAME.w + 16}px; height: ${FRAME.h + 48}px;
        background: var(--paper); box-shadow: 12px 12px 0 var(--ink); }
      .win-b { position: absolute; top: 9px; width: 16px; height: 16px; border: 3px solid var(--ink); box-sizing: border-box; }
      #frame { position: absolute; left: ${FRAME.x}px; top: ${FRAME.y}px; width: ${FRAME.w}px; height: ${FRAME.h}px;
        overflow: hidden; background: var(--term); }
      #cam { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
      .shot { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: cover; }
      #veil { position: absolute; inset: 0; background: var(--bg); opacity: 0; }
      .area { position: absolute; opacity: 0; box-shadow: inset 0 0 0 5px var(--green); }
      .area-l { position: absolute; left: 5px; top: 5px; font-family: var(--label); font-weight: 700; font-size: 30px; line-height: 1;
        color: var(--ink); background: var(--green); padding: 8px 14px 10px; }
      .spot { position: absolute; opacity: 0; box-shadow: 0 0 0 4px var(--yellow), 0 0 0 8px var(--ink), 0 0 0 4000px rgba(0,0,0,0.62); }
      .spot-nodim { box-shadow: 0 0 0 4px var(--yellow), 0 0 0 8px var(--ink); }
      .spot-l { position: absolute; left: -4px; white-space: nowrap; font-family: var(--label); font-weight: 700; font-size: var(--label-size);
        line-height: 1; color: var(--ink); background: var(--yellow); padding: 0.3em 0.5em 0.4em; border: 0.12em solid var(--ink); box-shadow: 0.2em 0.2em 0 var(--ink); }
      .spot-l svg { position: absolute; left: 0.8em; width: 0.9em; height: 0.6em; }
      .spot-below .spot-l { top: calc(100% + 0.9em); }
      .spot-below .spot-l svg { bottom: calc(100% + 0.12em); transform: scaleY(-1); }
      .spot-above .spot-l { bottom: calc(100% + 0.9em); }
      .spot-above .spot-l svg { top: calc(100% + 0.12em); }
      .spot-end .spot-l { left: auto; right: -4px; }
      .spot-end .spot-l svg { left: auto; right: 0.8em; }
      .tag, .fast { position: absolute; top: ${FRAME.y - 33}px; opacity: 0; font-family: var(--label); font-weight: 700; font-size: 22px; line-height: 26px; }
      .tag { left: ${FRAME.x + 6}px; color: var(--bg); }
      .fast { right: ${1920 - FRAME.x - FRAME.w + 92}px; color: var(--plum); }
      .keys { position: absolute; right: ${1920 - FRAME.x - FRAME.w + 24}px; top: ${FRAME.y + 24}px; display: flex; align-items: center; gap: 12px; opacity: 0; }
      .key { display: inline-block; min-width: 40px; text-align: center; font-family: var(--pixel); font-size: 24px; line-height: 1;
        color: var(--ink); padding: 14px 16px; background: var(--paper); border: 4px solid var(--ink); box-shadow: 0 6px 0 var(--grey), 0 6px 0 4px var(--ink); }
      .plus { font-family: var(--pixel); font-size: 22px; color: var(--paper); }
      .key-note { margin-left: 8px; font-family: var(--label); font-weight: 700; font-size: 24px; color: var(--ink); background: var(--green); padding: 6px 10px 8px; border: 4px solid var(--ink); }
      .typed { position: absolute; left: ${FRAME.x + 24}px; bottom: ${1080 - FRAME.y - FRAME.h + 70}px; opacity: 0; max-width: ${FRAME.w - 60}px;
        font-family: var(--code); font-weight: 700; font-size: 30px; color: var(--paper); padding: 12px 20px; background: var(--ink);
        border: 4px solid var(--green); box-shadow: 8px 8px 0 var(--ink); }
      .typed-k { display: block; font-family: var(--label); font-weight: 700; font-size: 20px; color: var(--green); text-transform: uppercase; margin-bottom: 6px; }
      .cmp { position: absolute; left: ${FRAME.x}px; top: ${FRAME.y}px; width: ${FRAME.w}px; height: ${FRAME.h}px; opacity: 0;
        background: var(--bg); display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 30px; }
      .cmp-l { font-family: var(--label); font-weight: 700; font-size: 28px; text-transform: uppercase; margin-bottom: 10px; }
      .cmp-before { color: var(--silver); }
      .cmp-after { color: var(--green); }
      .cmp-img { position: relative; overflow: hidden; border: 4px solid var(--paper); box-shadow: 8px 8px 0 var(--ink); }
      .cmp-img img { position: absolute; max-width: none; image-rendering: pixelated; }
      .sum { position: absolute; left: ${FRAME.x + 80}px; right: ${1920 - FRAME.x - FRAME.w + 80}px; top: ${FRAME.y + FRAME.h / 2 - 110}px; opacity: 0;
        text-align: center; font-family: var(--body); font-weight: 700; font-size: 52px; line-height: 1.25; color: var(--paper); }
      .sum-m { display: block; font-family: var(--pixel); font-size: 56px; color: var(--green); text-shadow: 6px 6px 0 var(--ink); margin-bottom: 24px; }
      .tcard, .chapter, .panel { position: absolute; inset: 0; opacity: 0; background: var(--bg); }
      .tcard { display: flex; align-items: center; gap: 90px; padding: 0 150px; }
      .tcard-text { flex: 1; }
      .tcard-c { font-family: var(--label); font-weight: 700; font-size: 28px; color: var(--blue); }
      .tcard-s { margin-top: 26px; font-family: var(--body); font-weight: 700; font-size: 64px; line-height: 1.15; color: var(--paper); text-shadow: 5px 5px 0 var(--ink); }
      .tcard-w { margin-top: 44px; font-family: var(--body); font-weight: 700; font-size: 44px; line-height: 1.25; color: var(--yellow); }
      .eye { display: inline-block; margin-right: 20px; padding: 8px 12px 10px; font-family: var(--label); font-size: 26px; line-height: 1;
        color: var(--ink); background: var(--yellow); border: 4px solid var(--ink); vertical-align: 8px; }
      .map { position: relative; flex: 0 0 560px; height: 315px; background: var(--ink); border: 6px solid var(--paper); box-shadow: 10px 10px 0 var(--ink); }
      .map-a { position: absolute; box-sizing: border-box; border: 4px solid var(--grey); display: flex; align-items: center; justify-content: center; }
      .map-a span { font-family: var(--label); font-weight: 700; font-size: 18px; color: var(--grey); text-align: center; }
      .map-on { border-color: var(--yellow); background: var(--yellow); }
      .map-on span { color: var(--ink); }
      .chapter { display: flex; flex-direction: column; justify-content: center; padding-left: 260px; }
      .chapter-n { font-family: var(--pixel); font-size: 120px; line-height: 1; color: var(--yellow); text-shadow: 10px 10px 0 var(--plum); }
      .chapter-t { margin-top: 48px; font-family: var(--pixel); font-size: 54px; line-height: 1.3; color: var(--paper); text-shadow: 6px 6px 0 var(--ink); }
      .chapter-s { margin-top: 26px; font-family: var(--body); font-size: 42px; color: var(--silver); }
      .panel h1 { position: absolute; left: 0; right: 0; top: 110px; margin: 0; text-align: center; font-family: var(--pixel); font-weight: 400; font-size: 46px; line-height: 1.3; color: var(--paper); text-shadow: 6px 6px 0 var(--ink); }
      .big { position: absolute; left: 0; right: 0; top: 270px; text-align: center; font-family: var(--pixel); font-size: 88px; color: var(--paper); text-shadow: 10px 10px 0 var(--red); }
      .big-s { position: absolute; left: 0; right: 0; top: 450px; text-align: center; font-family: var(--body); font-weight: 700; font-size: 50px; color: var(--green); }
      .big-l { position: absolute; left: 0; right: 0; top: 580px; text-align: center; font-family: var(--body); font-size: 42px; line-height: 1.6; color: var(--paper); }
      .flow { position: absolute; left: 120px; right: 120px; top: 270px; display: flex; gap: 40px; align-items: stretch; }
      .node { flex: 1; display: grid; grid-template-columns: 96px 1fr; column-gap: 24px; align-content: start; padding: 24px; background: var(--ink); border: 6px solid var(--paper); box-shadow: 10px 10px 0 var(--plum); opacity: 0; }
      .node svg { grid-row: 1 / span 4; width: 96px; height: 96px; }
      .node-n { font-family: var(--pixel); font-size: 28px; line-height: 1.2; color: var(--yellow); }
      .node-k { margin-top: 10px; font-family: var(--label); font-weight: 700; font-size: 22px; color: var(--blue); }
      .node-t { margin-top: 12px; font-family: var(--body); font-size: 30px; line-height: 1.25; color: var(--paper); }
      .node-s { margin-top: 14px; font-family: var(--code); font-size: 22px; color: var(--silver); background: var(--term); padding: 8px 12px; border: 3px solid var(--grey); justify-self: start; }
      .node-s b { color: var(--green); font-weight: 400; }
      .roles2 { position: absolute; left: 120px; right: 120px; top: 600px; display: flex; gap: 40px; }
      .r-arrow { position: absolute; left: 0; right: 0; top: 530px; text-align: center; font-family: var(--label); font-weight: 700; font-size: 30px; color: var(--silver); opacity: 0; }
      .cheats { position: absolute; left: 300px; top: 250px; display: flex; flex-direction: column; gap: 22px; }
      .cheat { display: flex; align-items: center; gap: 40px; opacity: 0; }
      .cheat-k { flex: 0 0 520px; display: flex; align-items: center; gap: 12px; }
      .cheat .key { font-size: 20px; padding: 10px 12px; }
      .cheat-w { font-family: var(--body); font-size: 40px; color: var(--paper); }
      .url { position: absolute; left: 0; right: 0; top: 880px; text-align: center; font-family: var(--label); font-weight: 700; font-size: 36px; color: var(--blue); }
      .herdr { position: absolute; left: 120px; right: 120px; top: 270px; display: flex; gap: 70px; }
      .herdr-c { flex: 1; opacity: 0; }
      .herdr-h { font-family: var(--pixel); font-size: 30px; color: var(--yellow); margin-bottom: 28px; }
      .herdr-c .map { width: auto; height: 340px; flex: none; }
      .herdr-t { margin-top: 34px; font-family: var(--body); font-size: 31px; line-height: 1.35; color: var(--paper); }
      .herdr-t b { color: var(--green); font-family: var(--code); font-weight: 400; font-size: 27px; }
      .cap { position: absolute; left: 200px; right: 200px; top: ${FRAME.y + FRAME.h + 26}px; text-align: center; opacity: 0; }
      .cap span { font-family: var(--body); font-weight: 500; font-size: 38px; line-height: 1.38; color: var(--paper); background: var(--ink);
        padding: 2px 14px 4px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="${total}">
      <div id="win"><div class="win-b" style="right:62px;background:#ff004d"></div><div class="win-b" style="right:38px;background:#ffec27"></div><div class="win-b" style="right:14px;background:#00e436"></div></div>
      <div id="frame">
        <div id="cam" data-layout-allow-overflow>
          ${media.filter(tag => !tag.startsWith('<audio')).join('\n          ')}
          ${inCam.join('\n          ')}
        </div>
        <div id="veil"></div>
      </div>
      ${html.join('\n      ')}
      ${captions.map(caption => `<div class="cap" id="${caption.id}"><span>${esc(caption.text)}</span></div>`).join('\n      ')}
      ${media.filter(tag => tag.startsWith('<audio')).join('\n      ')}
    </div>
    <script>
      const PLAN = ${JSON.stringify(plan)};
      const CAPTIONS = ${JSON.stringify(captions.map(({id, start, until}) => ({id, start, until})))};
      const tl = gsap.timeline({paused: true});
      // Old-console motion: everything moves in a few hard steps, never smoothly, and nothing blurs.
      const STEP = n => 'steps(' + n + ')';
      tl.set('#cam', {transformOrigin: '0 0', x: 0, y: 0, scale: ${BASE}, imageRendering: 'auto'}, 0);
      const fadeIn = (selector, at, duration = 0.3) => tl.fromTo(selector, {opacity: 0}, {opacity: 1, duration, ease: STEP(3)}, at);
      const fadeOut = (selector, until, duration = 0.25) => tl.to(selector, {opacity: 0, duration, ease: STEP(3)}, until - duration);
      // A pixel wipe: the card comes down in hard bands.
      const wipeIn = (selector, at) => {
        tl.set(selector, {opacity: 1}, at);
        tl.fromTo(selector, {clipPath: 'inset(0 0 100% 0)'}, {clipPath: 'inset(0 0 0% 0)', duration: 0.4, ease: STEP(8)}, at);
      };
      for (const step of PLAN) {
        if (step.camera) {
          // Past 1:1 the capture is scaled with nearest neighbour, so the zoomed text stays crisp.
          const crisp = step.camera.scale > 1 ? 'pixelated' : 'auto';
          if (step.cut) tl.set('#cam', {...step.camera, imageRendering: crisp}, step.at);
          else {
            tl.set('#cam', {imageRendering: 'pixelated'}, step.at);
            tl.to('#cam', {...step.camera, duration: 0.6, ease: STEP(6)}, step.at);
            tl.set('#cam', {imageRendering: crisp}, step.at + 0.6);
          }
          continue;
        }
        const {selector, at, until, kind} = step;
        if (kind === 'card' || kind === 'chapter' || kind === 'panel') {
          // Full-screen cards cover the window: wiped in, their lines appearing one at a time, dissolved out.
          if (at === 0) tl.set(selector, {opacity: 1}, 0); else wipeIn(selector, at);
          if (kind !== 'panel') {
            const parts = kind === 'card' ? [' .tcard-c', ' .tcard-s', ' .tcard-w', ' .map'] : [' .chapter-n', ' .chapter-t', ' .chapter-s'];
            parts.filter(part => document.querySelector(selector + part)).forEach((part, i) => { tl.set(selector + part, {opacity: 0}, at); tl.set(selector + part, {opacity: 1}, at + 0.35 + i * 0.3); });
          }
          fadeOut(selector, until, 0.3);
        } else if (kind === 'reveal') {
          fadeIn(selector, at, 0.3);
        } else if (kind === 'keys') {
          tl.set(selector, {opacity: 1}, at);
          tl.set(selector + ' .key', {y: 6, boxShadow: '0 0 0 var(--grey), 0 0 0 4px var(--ink)'}, at + 0.25);
          tl.set(selector + ' .key', {y: 0, boxShadow: '0 6px 0 var(--grey), 0 6px 0 4px var(--ink)'}, at + 0.45);
          tl.set(selector, {opacity: 0}, until);
        } else if (kind === 'sum') {
          tl.to('#veil', {opacity: 0.9, duration: 0.3, ease: STEP(3)}, at);
          tl.set(selector, {opacity: 1}, at + 0.4);
          fadeOut(selector, until, 0.25);
          tl.to('#veil', {opacity: 0, duration: 0.25, ease: STEP(3)}, until);
        } else if (kind === 'spot' || kind === 'area' || kind === 'chip') {
          // Boxes and labels blink on, as on a console: off, on, off, on.
          tl.set(selector, {opacity: 1}, at);
          tl.set(selector, {opacity: 0}, at + 0.1);
          tl.set(selector, {opacity: 1}, at + 0.2);
          fadeOut(selector, until, 0.2);
        } else {
          fadeIn(selector, at, 0.25);
          fadeOut(selector, until);
        }
      }
      for (const caption of CAPTIONS) {
        tl.set('#' + caption.id, {opacity: 1, visibility: 'visible'}, caption.start);
        tl.set('#' + caption.id, {opacity: 0, visibility: 'hidden'}, caption.until);
      }
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
writeFileSync(`${here}${CUT === 'short' ? 'short' : 'index'}.html`, page);
const stamp = t => new Date(t * 1000).toISOString().slice(11, 23);
writeFileSync(`${here}captions${CUT === 'short' ? '-short' : ''}.vtt`, `WEBVTT\n\n${captions.map(caption => `${stamp(caption.start)} --> ${stamp(caption.until)}\n${caption.text}\n`).join('\n')}`);
console.log(`${CUT === 'short' ? 'short' : 'index'}.html: ${timeline.length} parts, ${total} s`);
// The chapters, for the README and the site: where each starts, and where each scene starts.
const clockText = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
if (CUT === 'tour') {
  const chapters = [{at: 0, title: 'What Pair is'}, ...timeline.filter(scene => scene.kind === 'chapter').map(scene => ({at: scene.start, title: CHAPTERS[scene.chapter][0]})), {at: timeline.find(scene => scene.id === 'keys').start, title: 'The keys to remember'}];
  const scenes = Object.fromEntries(timeline.filter(scene => scene.kind !== 'chapter').map(scene => [scene.id, r(scene.start)]));
  // The poster: the scene that says `poster: n`, at its nth spot (from 0), once it has faded in.
  const posterScene = timeline.find(scene => scene.poster !== undefined);
  const posterAt = posterScene ? plan.find(step => step.selector === `#spot-${posterScene.id}-${posterScene.poster}`).at + 1.5 : 1;
  writeFileSync(`${here}chapters.json`, `${JSON.stringify({length: total, poster: r(posterAt), chapters: chapters.map(c => ({...c, at: r(c.at), clock: clockText(c.at)})), scenes}, null, 1)}\n`);
  writeFileSync(`${here}chapters.vtt`, `WEBVTT\n\n${chapters.map((c, i) => `${stamp(c.at)} --> ${stamp(chapters[i + 1]?.at ?? total)}\n${c.title}\n`).join('\n')}`);
  for (const c of chapters) console.log(`  chapter ${clockText(c.at)} ${c.title}`);
}
for (const scene of timeline) console.log(`  ${(scene.id ?? '').padEnd(14)} ${scene.start.toFixed(1).padStart(6)} s  ${scene.length.toFixed(1)} s`);
