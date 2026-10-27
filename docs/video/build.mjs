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
// Where a capture (1920x1080) sits on the canvas: at 5/6 of its size, with a band under it for the captions.
const FRAME = {x: 160, y: 14, w: 1600, h: 900};
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
    inCam.push(`<div class="spot spot-${place}${end2}${spot.dim === false ? ' spot-nodim' : ''}" id="${id}" style="left:${x - 4}px;top:${y - 3}px;width:${w + 8}px;height:${h + 6}px;--label:${size}px">${spot.label ? `<span class="spot-l">${esc(spot.label)}</span>` : ''}</div>`);
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
      @font-face { font-family: "Inter"; font-weight: 500; src: url("fonts/inter-500.woff2") format("woff2"); }
      @font-face { font-family: "Inter"; font-weight: 700; src: url("fonts/inter-700.woff2") format("woff2"); }
      @font-face { font-family: "Inter"; font-weight: 800; src: url("fonts/inter-800.woff2") format("woff2"); }
      @font-face { font-family: "JetBrains Mono"; font-weight: 400; src: url("fonts/jetbrains-mono-400.woff2") format("woff2"); }
      @font-face { font-family: "JetBrains Mono"; font-weight: 700; src: url("fonts/jetbrains-mono-700.woff2") format("woff2"); }
      :root { /* ayu dark, the colorscheme of the captures; the plugin's teal marks what to watch */
        --bg: #0a0d12; --term: #0f1419; --panel: #131a22; --line: #253340; --text: #e6e1cf; --dim: #8a9199; --faint: #5c6773;
        --accent: #95e6cb; --warm: #ffb454; --red: #ff6565; --green: #b8cc52; --key: #1b232d;
      }
      html, body { margin: 0; background: var(--bg); color: var(--text); font-family: "Inter", sans-serif; font-variant-ligatures: none; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--bg); }
      #frame { position: absolute; left: ${FRAME.x}px; top: ${FRAME.y}px; width: ${FRAME.w}px; height: ${FRAME.h}px; border-radius: 10px;
        overflow: hidden; background: var(--term); box-shadow: 0 0 0 1px var(--line), 0 24px 70px rgba(0,0,0,0.55); }
      #cam { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
      .shot { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: cover; }
      #veil { position: absolute; inset: 0; background: var(--term); opacity: 0; }
      .area { position: absolute; opacity: 0; box-shadow: inset 0 0 0 3px rgba(149,230,203,0.85); border-radius: 4px; }
      .area-l { position: absolute; left: 10px; top: 10px; font-family: "Inter", sans-serif; font-weight: 800; font-size: 30px;
        color: var(--term); background: var(--accent); padding: 6px 16px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
      .spot { position: absolute; opacity: 0; border-radius: 6px;
        box-shadow: 0 0 0 3px var(--warm), 0 0 0 4000px rgba(5,8,11,0.62); }
      .spot-nodim { box-shadow: 0 0 0 3px var(--warm); }
      .spot-l { position: absolute; left: -3px; white-space: nowrap; font-family: "Inter", sans-serif; font-weight: 700;
        font-size: var(--label); color: #1a1205; background: var(--warm); padding: 0.22em 0.6em; border-radius: 0.3em; }
      .spot-l::after { content: ""; position: absolute; left: 1.1em; border: 0.45em solid transparent; }
      .spot-below .spot-l { top: calc(100% + 0.75em); }
      .spot-below .spot-l::after { bottom: 100%; border-bottom-color: var(--warm); }
      .spot-above .spot-l { bottom: calc(100% + 0.75em); }
      .spot-above .spot-l::after { top: 100%; border-top-color: var(--warm); }
      .spot-end .spot-l { left: auto; right: -3px; }
      .spot-end .spot-l::after { left: auto; right: 1.1em; }
      .tag { position: absolute; left: ${FRAME.x}px; top: ${FRAME.y + FRAME.h + 14}px; opacity: 0;
        font-family: "JetBrains Mono", monospace; font-size: 22px; color: var(--accent); }
      .keys { position: absolute; right: ${1920 - FRAME.x - FRAME.w + 24}px; top: ${FRAME.y + 24}px; display: flex; align-items: center; gap: 10px; opacity: 0; }
      .key { display: inline-block; min-width: 48px; text-align: center; font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 32px;
        color: #f3f0e6; padding: 10px 18px; border-radius: 12px; background: var(--key);
        box-shadow: inset 0 -5px 0 rgba(0,0,0,0.45), 0 0 0 2px var(--accent), 0 14px 30px rgba(0,0,0,0.5); }
      .plus { font-family: "JetBrains Mono", monospace; font-size: 28px; color: var(--dim); }
      .key-note { margin-left: 8px; font-size: 26px; font-weight: 700; color: var(--accent); background: rgba(10,13,18,0.9); padding: 6px 12px; border-radius: 8px; }
      .typed { position: absolute; left: ${FRAME.x + 24}px; bottom: ${1080 - FRAME.y - FRAME.h + 70}px; opacity: 0; max-width: ${FRAME.w - 48}px;
        font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 30px; color: #f3f0e6; padding: 12px 22px; border-radius: 12px;
        background: rgba(10,13,18,0.95); box-shadow: 0 0 0 2px var(--accent), 0 12px 30px rgba(0,0,0,0.5); }
      .typed-k { display: block; font-family: "Inter", sans-serif; font-weight: 700; font-size: 20px; color: var(--accent); text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 4px; }
      .fast { position: absolute; right: ${1920 - FRAME.x - FRAME.w}px; top: ${FRAME.y + FRAME.h + 14}px; opacity: 0;
        font-family: "JetBrains Mono", monospace; font-size: 22px; color: var(--warm); }
      .cmp { position: absolute; left: ${FRAME.x}px; top: ${FRAME.y}px; width: ${FRAME.w}px; height: ${FRAME.h}px; border-radius: 10px; opacity: 0;
        background: rgba(10,13,18,0.97); display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 36px; }
      .cmp-l { font-family: "Inter", sans-serif; font-weight: 800; font-size: 28px; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; }
      .cmp-before { color: var(--dim); }
      .cmp-after { color: var(--accent); }
      .cmp-img { position: relative; overflow: hidden; border-radius: 10px; box-shadow: 0 0 0 2px var(--line); }
      .cmp-img img { position: absolute; max-width: none; }
      .sum { position: absolute; left: ${FRAME.x + 80}px; right: ${1920 - FRAME.x - FRAME.w + 80}px; top: ${FRAME.y + FRAME.h / 2 - 90}px; opacity: 0;
        text-align: center; font-weight: 800; font-size: 50px; line-height: 1.25; letter-spacing: -0.5px; color: #f3f0e6; }
      .sum-m { display: block; font-size: 64px; color: var(--accent); margin-bottom: 10px; }
      .tcard, .chapter, .panel { position: absolute; inset: 0; opacity: 0; background: var(--bg); }
      .tcard { display: flex; align-items: center; gap: 90px; padding: 0 150px; }
      .tcard-text { flex: 1; }
      .tcard-c { font-family: "JetBrains Mono", monospace; font-size: 28px; color: var(--accent); }
      .tcard-s { margin-top: 22px; font-weight: 800; font-size: 66px; line-height: 1.12; letter-spacing: -1.5px; color: #f3f0e6; }
      .tcard-w { margin-top: 40px; font-weight: 700; font-size: 42px; line-height: 1.25; color: var(--warm); }
      .eye { display: inline-block; margin-right: 18px; padding: 4px 14px; border-radius: 8px; font-size: 26px; text-transform: uppercase;
        letter-spacing: 2px; color: #1a1205; background: var(--warm); vertical-align: 6px; }
      .map { position: relative; flex: 0 0 560px; height: 315px; border-radius: 12px; background: var(--term); box-shadow: 0 0 0 2px var(--line); }
      .map-a { position: absolute; box-sizing: border-box; border: 2px solid var(--line); border-radius: 6px; display: flex; align-items: center; justify-content: center; }
      .map-a span { font-weight: 700; font-size: 20px; color: var(--faint); text-align: center; }
      .map-on { border: 3px solid var(--warm); background: rgba(255,180,84,0.14); }
      .map-on span { color: var(--warm); }
      .chapter { display: flex; flex-direction: column; justify-content: center; padding-left: 300px; }
      .chapter-n { font-family: "JetBrains Mono", monospace; font-weight: 700; font-size: 110px; color: var(--accent); line-height: 1; }
      .chapter-t { margin-top: 22px; font-weight: 800; font-size: 88px; letter-spacing: -2px; color: #f3f0e6; }
      .chapter-s { margin-top: 16px; font-weight: 500; font-size: 40px; color: var(--dim); }
      .panel h1 { position: absolute; left: 0; right: 0; top: 120px; margin: 0; text-align: center; font-weight: 800; font-size: 72px; letter-spacing: -1.5px; color: #f3f0e6; }
      .panel .lead { position: absolute; left: 0; right: 0; top: 230px; text-align: center; font-weight: 500; font-size: 38px; color: var(--dim); }
      .big { position: absolute; left: 0; right: 0; top: 290px; text-align: center; font-weight: 800; font-size: 140px; letter-spacing: -4px; color: #f3f0e6; }
      .big-s { position: absolute; left: 0; right: 0; top: 490px; text-align: center; font-weight: 700; font-size: 50px; color: var(--accent); }
      .big-l { position: absolute; left: 0; right: 0; top: 620px; text-align: center; font-weight: 500; font-size: 40px; line-height: 1.6; color: var(--text); }
      .flow { position: absolute; left: 120px; right: 120px; top: 330px; display: flex; gap: 30px; align-items: stretch; }
      .node { flex: 1; padding: 28px 26px; border-radius: 18px; background: var(--panel); box-shadow: 0 0 0 2px var(--line); opacity: 0; }
      .node-n { font-weight: 800; font-size: 42px; color: #f3f0e6; }
      .node-k { margin-top: 8px; font-family: "JetBrains Mono", monospace; font-size: 24px; color: var(--accent); }
      .node-t { margin-top: 14px; font-weight: 500; font-size: 29px; line-height: 1.3; color: var(--text); }
      .node-s { margin-top: 18px; font-family: "JetBrains Mono", monospace; font-size: 24px; color: var(--dim); background: var(--term); padding: 10px 14px; border-radius: 8px; }
      .node-s b { color: var(--accent); font-weight: 400; }
      .roles2 { position: absolute; left: 120px; right: 120px; top: 640px; display: flex; gap: 30px; }
      .r-arrow { position: absolute; left: 0; right: 0; top: 585px; text-align: center; font-size: 30px; font-weight: 700; color: var(--dim); opacity: 0; }
      .cheats { position: absolute; left: 300px; top: 270px; display: flex; flex-direction: column; gap: 24px; }
      .cheat { display: flex; align-items: center; gap: 40px; opacity: 0; }
      .cheat-k { flex: 0 0 470px; display: flex; align-items: center; gap: 10px; }
      .cheat .key { font-size: 30px; padding: 8px 18px; }
      .cheat-w { font-weight: 500; font-size: 40px; color: var(--text); }
      .url { position: absolute; left: 0; right: 0; top: 900px; text-align: center; font-family: "JetBrains Mono", monospace; font-size: 34px; color: var(--accent); }
      .herdr { position: absolute; left: 120px; right: 120px; top: 300px; display: flex; gap: 60px; }
      .herdr-c { flex: 1; opacity: 0; }
      .herdr-h { font-weight: 800; font-size: 46px; color: #f3f0e6; margin-bottom: 22px; }
      .herdr-c .map { width: 100%; height: 360px; flex: none; }
      .herdr-t { margin-top: 24px; font-weight: 500; font-size: 30px; line-height: 1.4; color: var(--text); }
      .cap { position: absolute; left: 260px; right: 260px; top: ${FRAME.y + FRAME.h + 46}px; text-align: center; opacity: 0; }
      .cap span { font-weight: 700; font-size: 34px; line-height: 1.3; color: #f3f0e6; }
      .panel .cap-safe { display: none; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="${total}">
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
      tl.set('#cam', {transformOrigin: '0 0', x: 0, y: 0, scale: ${BASE}}, 0);
      const fadeIn = (selector, at, from, duration = 0.5) => tl.fromTo(selector, {opacity: 0, ...from}, {opacity: 1, x: 0, y: 0, scale: 1, duration, ease: 'power3.out'}, at);
      const fadeOut = (selector, until, duration = 0.35) => tl.to(selector, {opacity: 0, duration, ease: 'power2.in'}, until - duration);
      for (const step of PLAN) {
        if (step.camera) {
          if (step.cut) tl.set('#cam', step.camera, step.at);
          else tl.to('#cam', {...step.camera, duration: step.slow, ease: 'power2.inOut'}, step.at);
          continue;
        }
        const {selector, at, until, kind} = step;
        if (kind === 'card' || kind === 'chapter' || kind === 'panel') {
          // Full-screen cards cover the frame: in at their start, out at their end.
          if (at === 0) tl.set(selector, {opacity: 1}, 0); else tl.fromTo(selector, {opacity: 0}, {opacity: 1, duration: 0.5, ease: 'power2.out'}, at);
          if (kind !== 'panel') tl.fromTo(selector + (kind === 'card' ? ' .tcard-text > *, ' + selector + ' .map' : ' > *'), {opacity: 0, y: 24}, {opacity: 1, y: 0, duration: 0.7, stagger: 0.25, ease: 'power3.out'}, at + 0.1);
          fadeOut(selector, until, 0.5);
        } else if (kind === 'reveal') {
          fadeIn(selector, at, {y: 20}, 0.6);
        } else if (kind === 'area') {
          fadeIn(selector, at, {scale: 1.01}, 0.5);
          fadeOut(selector, until, 0.4);
        } else if (kind === 'spot') {
          fadeIn(selector, at, {}, 0.6);
          fadeOut(selector, until, 0.45);
        } else if (kind === 'keys') {
          fadeIn(selector, at, {y: 16}, 0.3);
          tl.to(selector + ' .key', {y: 5, duration: 0.08, ease: 'power1.in'}, at + 0.3);
          tl.to(selector + ' .key', {y: 0, duration: 0.2, ease: 'power2.out'}, at + 0.38);
          fadeOut(selector, until);
        } else if (kind === 'compare') {
          fadeIn(selector, at, {}, 0.6);
          fadeOut(selector, until, 0.5);
        } else if (kind === 'sum') {
          tl.to('#veil', {opacity: 0.86, duration: 0.6, ease: 'power2.out'}, at);
          fadeIn(selector, at + 0.2, {y: 20}, 0.6);
          fadeOut(selector, until, 0.4);
          tl.to('#veil', {opacity: 0, duration: 0.3, ease: 'power2.in'}, until);
        } else {
          fadeIn(selector, at, {y: 10}, 0.4);
          fadeOut(selector, until);
        }
      }
      for (const caption of CAPTIONS) {
        tl.fromTo('#' + caption.id, {opacity: 0}, {opacity: 1, duration: 0.15, ease: 'power1.out'}, caption.start);
        tl.to('#' + caption.id, {opacity: 0, duration: 0.12, ease: 'power1.in'}, caption.until - 0.12);
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
