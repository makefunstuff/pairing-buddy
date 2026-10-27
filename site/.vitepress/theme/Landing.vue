<script setup>
// The front page: what Pair is, the tour and three moments, how it works, its models, and the install.
// The tour's chapters come from docs/video/chapters.json, which docs/video/build.mjs writes. The three loops come from
// docs/captures/encode.sh, and their callouts are timed on those clips.
import {onBeforeUnmount, onMounted, ref} from 'vue';
import {withBase} from 'vitepress';
import tour from '../../../docs/video/chapters.json';

const chapters = tour.chapters;
const video = ref(null);
const media = path => withBase(`/media/${path}`);

const versus = [
  {name: 'Completion', text: 'Guesses your next line, all the time, whether you need it or not.'},
  {name: 'Chat sidebar', text: 'Waits in a panel until you stop and ask it something.'},
  {name: 'Pair', text: 'Watches with you, speaks up when it matters, types only when you hand over.', us: true},
];

// Each loop opens with its lead-in fast-forwarded (up to `ff` seconds of the clip); a callout says what Pair just
// did, from `at` to the next one. `top` places it beside Pair's line in the frame, on wider screens.
const moments = [
  {
    id: 'm1', file: 'internal/retry/backoff.go', roles: ['watcher', 'navigator'], ff: 2.07, speed: 6,
    title: 'It stops the wrong turn',
    text: 'You start fixing the wrong file. Pair says, in two lines under your edit, that the real cause is <code>worker.go:35</code>.',
    label: 'Capture: Pair reads backoff.go and worker.go, writes two lines under your edit, and Alt-j takes you to the real cause',
    callouts: [
      {at: 2.6, top: 44, text: 'Wrong file. The real cause is worker.go:35'},
      {at: 7.25, top: 46, text: '<kbd>Alt-j</kbd> jumps straight there'},
      {at: 13.5, top: 72, text: 'Fixed in the right place: green'},
    ],
  },
  {
    id: 'm2', file: 'internal/queue/queue.go', roles: ['navigator'], ff: 1.88, speed: 5,
    title: 'It runs what you\'d skip',
    text: 'Pair ran the tests as you saved, found the one your fix broke elsewhere, and offers a one-line fix you take with <code>Alt-y</code>.',
    label: 'Capture: Pair runs the tests on save, names the failing test, says why under your line, and puts a one-line fix in queue.go that Alt-y takes',
    callouts: [
      {at: 2.45, top: 26, text: 'Your fix broke another test. Pair saw it on save'},
      {at: 7.9, top: 20, text: 'A one-line fix. <kbd>Alt-y</kbd> takes it'},
      {at: 12.3, top: 24, text: 'Saved: both tests pass again'},
    ],
  },
  {
    id: 'm3', file: 'internal/retry/backoff_test.go', roles: ['driver'], ff: 1.4, speed: 4,
    title: 'It takes the keyboard, and gives it back',
    text: 'You hand over the edge cases. Pair types them while you watch, tests the unsaved buffer and hands back. One <code>u</code> undoes it all.',
    label: 'Capture: the Driver types six table test cases, tests the unsaved buffer, hands back, and u takes all six away',
    callouts: [
      {at: 1.9, top: 30, text: 'You hand over. Pair types while you watch'},
      {at: 7.0, top: 62, text: 'Tested unsaved, then handed back'},
      {at: 12.0, top: 44, text: 'One <kbd>u</kbd> undoes all six'},
    ],
  },
];
const roleName = r => r[0].toUpperCase() + r.slice(1);

const steps = [
  {title: 'The plugin watches with you', text: 'Edits, saves, searches, diagnostics, test runs, and your terminals (herdr or tmux panes, Neovim\'s <code>:terminal</code>) go to the daemon.'},
  {title: 'The Watcher decides', text: 'A small, fast model scores each moment from 0 to 10 in about a second. Most score low, so Pair stays quiet, and never while you type.'},
  {title: 'The Partner speaks', text: 'A larger model, or the same one, writes one or two short lines under the line they are about, with the key that acts on them.'},
];

const models = [
  {role: 'watcher', name: 'Watcher', text: 'The small, fast model. It decides whether a moment is worth a word.'},
  {role: 'partner', name: 'Partner', text: 'The model that thinks. It writes what Pair says and uses the role\'s tools.'},
];
const roles = [
  {role: 'navigator', name: 'Navigator', note: 'default', text: 'Points at lines, answers questions, suggests a change you take with <code>Alt-y</code>.'},
  {role: 'scout', name: 'Scout', note: ':Pair scout', text: 'Also searches, and runs tests and builds in its own pane, where you see every command.'},
  {role: 'driver', name: 'Driver', note: ':Pair drive', text: 'Types one change into your buffer while you watch: unsaved, one undo step. Any key takes it back.'},
];

const providers = [
  {icon: 'local', title: 'A local server', text: 'llama.cpp, Ollama, vLLM, LM Studio or any OpenAI-compatible server on your machine. No key needed.'},
  {icon: 'key', title: 'An API key', text: 'Any provider pi-ai supports, or an Anthropic-compatible API. <code>pair auth login</code> stores the key.'},
  {icon: 'login', title: 'A subscription login', text: 'Where the provider allows it in other tools. <code>pair auth login</code> shows its terms before you sign in.'},
];

const install = [
  {title: 'Install the daemon', code: 'npm install -g github:makefunstuff/pairing-buddy\npair setup', text: '<code>pair setup</code> writes the config, offers a login and starts the daemon as a user service.'},
  {title: 'Add the Neovim plugin', code: "{\n  'makefunstuff/pairing-buddy',\n  main = 'pair',\n  lazy = false,\n  opts = {auto_connect = true},\n}", text: 'With lazy.nvim. Your model goes in <code>~/.config/pairing-buddy/config.json</code>.'},
  {title: 'Check it, and pair', code: 'pair doctor', text: 'One line per part, with the fix when something is wrong. Then run <code>pair</code> next to Neovim in herdr, or <code>:Pair chat</code> in Neovim.'},
];

const copied = ref(-1);
async function copy(i) {
  try { await navigator.clipboard.writeText(install[i].code); copied.value = i; } catch { copied.value = -1; }
  setTimeout(() => (copied.value = -1), 1600);
}

function seek(at) {
  const v = video.value;
  const go = () => { v.currentTime = at; v.play().catch(() => {}); };
  if (v.preload === 'none') v.preload = 'auto';
  if (v.readyState >= 1) go(); else { v.addEventListener('loadedmetadata', go, {once: true}); v.load(); }
  v.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center'});
}

// The loops: nothing downloads until one is near the screen; each plays muted while in view, unless you paused it or
// ask for less motion. Before it plays, its poster shows the payoff, with the first callout.
const loops = ref([]);
const paused = ref({});
const shown = ref(moments.map(() => 0)); // the callout each loop shows
const fast = ref(moments.map(() => false)); // in its fast-forwarded lead-in
let near, seen;
function load(v) {
  if (v.dataset.loaded) return;
  v.dataset.loaded = '1';
  for (const s of v.querySelectorAll('source[data-src]')) s.src = s.dataset.src;
  v.load();
}
function tick(i) {
  const t = loops.value[i].currentTime, m = moments[i];
  let k = 0;
  m.callouts.forEach((c, j) => { if (t >= c.at) k = j; });
  shown.value[i] = t < m.callouts[0].at ? -1 : k;
  fast.value[i] = t < m.ff;
}
function toggle(i) {
  const v = loops.value[i];
  load(v);
  if (v.paused) { paused.value = {...paused.value, [i]: false}; v.play().catch(() => {}); }
  else { paused.value = {...paused.value, [i]: true}; v.pause(); }
}
onMounted(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  near = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && load(e.target)), {rootMargin: '400px 0px'});
  seen = new IntersectionObserver(es => {
    for (const e of es) {
      const i = loops.value.indexOf(e.target);
      if (e.isIntersecting && !reduce && paused.value[i] !== true) e.target.play().catch(() => {});
      else if (!e.isIntersecting) e.target.pause();
    }
  }, {threshold: 0.45});
  for (const v of loops.value) { near.observe(v); seen.observe(v); }
  if (reduce) paused.value = Object.fromEntries(loops.value.map((v, i) => [i, true]));
});
onBeforeUnmount(() => { near?.disconnect(); seen?.disconnect(); });
</script>

<template>
  <div class="landing">
    <section class="hero" aria-labelledby="hero-h">
      <div class="backdrop" aria-hidden="true"></div>
      <div class="wrap intro">
        <p class="eyebrow"><span class="pulse"></span>Neovim plugin + daemon · local or cloud models · MIT</p>
        <h1 id="hero-h">A pair programmer that <span class="grad">knows when to speak.</span></h1>
        <p class="lede">Pair sits in the second chair while you work in Neovim. It watches, says one short line when something matters, and types only when you hand it the keyboard. It never writes your files.</p>
        <ul class="versus" aria-label="How Pair differs">
          <li v-for="v in versus" :key="v.name" :class="{us: v.us}"><b>{{ v.name }}</b><span>{{ v.text }}</span></li>
        </ul>
        <div class="cta">
          <a class="btn primary" :href="withBase('/getting-started.html')">Get started <span aria-hidden="true">→</span></a>
          <a class="btn" href="#tour">Watch the 6-minute tour</a>
          <a class="btn ghost" href="https://github.com/makefunstuff/pairing-buddy">GitHub</a>
        </div>
      </div>

      <div class="wrap wide" id="tour">
        <div class="window glow">
          <div class="bar" aria-hidden="true"><i></i><i></i><i></i><span>The tour · 6 min · with captions</span></div>
          <video ref="video" controls playsinline preload="none" :poster="media('hero-poster.jpg')" width="1280" height="720"
            aria-label="Video: a six-minute tour of everything pairing-buddy does, with captions">
            <source :src="media('hero.webm')" type="video/webm">
            <source :src="media('hero.mp4')" type="video/mp4">
            <track kind="captions" :src="media('hero.vtt')" srclang="en" label="English">
            <track kind="chapters" :src="media('hero-chapters.vtt')" srclang="en" label="Chapters">
          </video>
        </div>
        <div class="chapters" aria-label="Chapters of the tour">
          <button v-for="c in chapters" :key="c.at" class="chip" type="button" @click="seek(c.at)"><b>{{ c.clock }}</b>{{ c.title }}</button>
        </div>
      </div>
    </section>

    <section class="moments" aria-labelledby="moments-h">
      <div class="wrap wide">
        <p class="kicker">See it work</p>
        <h2 id="moments-h">Three moments a second person saves you time</h2>
        <p class="sub">Recorded from the shipped plugin and daemon on a small Go service. Only the model's words are scripted.</p>
        <article v-for="(m, i) in moments" :key="m.id" class="moment" :class="{flip: i % 2}">
          <div class="moment-text">
            <span class="num">0{{ i + 1 }}</span>
            <h3>{{ m.title }}</h3>
            <p v-html="m.text"></p>
            <p class="badges"><span v-for="r in m.roles" :key="r" class="role" :class="r">{{ roleName(r) }}</span></p>
          </div>
          <figure class="demo">
            <div class="window">
              <div class="bar" aria-hidden="true"><i></i><i></i><i></i><span>nvim · {{ m.file }}</span></div>
              <div class="screen">
                <video :ref="el => (loops[i] = el)" muted loop playsinline preload="none" :poster="media(`${m.id}-poster.webp`)" width="1280" height="768"
                  :aria-label="m.label" @click="toggle(i)" @timeupdate="tick(i)">
                  <source :data-src="media(`${m.id}.webm`)" type="video/webm">
                  <source :data-src="media(`${m.id}.mp4`)" type="video/mp4">
                </video>
                <span class="ff" :class="{on: fast[i]}" aria-hidden="true">▶▶ {{ m.speed }}×</span>
                <template v-for="(c, j) in m.callouts" :key="j">
                  <span class="callout over" :class="{on: (shown[i] === -1 ? 0 : shown[i]) === j && !fast[i]}" :style="{top: `${c.top}%`}" aria-hidden="true" v-html="c.text"></span>
                </template>
                <button class="playpause" type="button" @click="toggle(i)" :aria-label="paused[i] ? 'Play the clip' : 'Pause the clip'">{{ paused[i] ? '▶' : '❚❚' }}</button>
              </div>
            </div>
            <figcaption class="callout under" aria-live="off" v-html="m.callouts[Math.max(0, shown[i])].text"></figcaption>
          </figure>
        </article>
      </div>
    </section>

    <section class="how" aria-labelledby="how-h">
      <div class="wrap wide">
        <p class="kicker">How it works</p>
        <h2 id="how-h">A plugin that watches, a daemon that thinks</h2>
        <ol class="steps">
          <li v-for="(s, i) in steps" :key="s.title">
            <span class="step-n">{{ i + 1 }}</span>
            <h3>{{ s.title }}</h3>
            <p v-html="s.text"></p>
          </li>
        </ol>

        <div class="cast">
          <div class="cast-group">
            <h3 class="cast-h">Two models behind it</h3>
            <div class="cast-cards two">
              <div v-for="r in models" :key="r.name" class="card" :class="r.role">
                <span class="role" :class="r.role">{{ r.name }}</span>
                <p v-html="r.text"></p>
              </div>
            </div>
          </div>
          <div class="cast-group">
            <h3 class="cast-h">Three roles you switch between <small>one at a time, enforced in code</small></h3>
            <div class="cast-cards three">
              <div v-for="r in roles" :key="r.name" class="card" :class="r.role">
                <span class="role" :class="r.role">{{ r.name }}</span><code class="note">{{ r.note }}</code>
                <p v-html="r.text"></p>
              </div>
            </div>
          </div>
        </div>
        <p class="more"><a :href="withBase('/roles.html')">Roles in detail →</a><a :href="withBase('/how-it-works.html')">How it works →</a></p>
      </div>
    </section>

    <section class="models" aria-labelledby="models-h">
      <div class="wrap wide">
        <p class="kicker">Models</p>
        <h2 id="models-h">Runs on the models you already have</h2>
        <p class="sub">One model can do both jobs, or give each its own: keep the Watcher small and fast, local or pay-per-use.</p>
        <div class="providers">
          <div v-for="m in providers" :key="m.title" class="card provider">
            <span class="icon" :class="m.icon" aria-hidden="true">
              <svg v-if="m.icon === 'local'" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
              <svg v-else-if="m.icon === 'key'" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>
              <svg v-else viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>
            </span>
            <h3>{{ m.title }}</h3>
            <p v-html="m.text"></p>
          </div>
        </div>
        <p class="more"><a :href="withBase('/models.html')">Models and providers →</a><a :href="withBase('/config.html')">Configuration reference →</a></p>
      </div>
    </section>

    <section class="install-s" id="install" aria-labelledby="install-h">
      <div class="wrap">
        <p class="kicker">Install</p>
        <h2 id="install-h">Pairing in three steps</h2>
        <p class="sub">Needs Node.js 22.19+ and Neovim 0.11+. <a href="https://herdr.dev">herdr</a> is its best home; without it, everything runs in Neovim and tmux.</p>
        <ol class="install">
          <li v-for="(s, i) in install" :key="s.title">
            <span class="step-n">{{ i + 1 }}</span>
            <h3>{{ s.title }}</h3>
            <div class="code">
              <button class="copy" type="button" @click="copy(i)">{{ copied === i ? 'copied' : 'copy' }}</button>
              <pre><code>{{ s.code }}</code></pre>
            </div>
            <p v-html="s.text"></p>
          </li>
        </ol>
      </div>
    </section>

    <section class="closing" aria-labelledby="closing-h">
      <div class="wrap">
        <div class="band">
          <h2 id="closing-h">Give your editor a second chair.</h2>
          <p>Free and open source. Your models, your machine, your files.</p>
          <div class="cta">
            <a class="btn primary" :href="withBase('/getting-started.html')">Read the getting started guide <span aria-hidden="true">→</span></a>
            <a class="btn" href="https://github.com/makefunstuff/pairing-buddy">Star on GitHub</a>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.landing { overflow-x: clip; padding-bottom: 72px; }
.wrap { max-width: 800px; margin: 0 auto; padding: 0 24px; position: relative; }
.wrap.wide { max-width: 1180px; }
section { padding-top: 112px; position: relative; }

/* the hero: glows and a dot grid behind a big headline */
.hero { padding-top: 84px; }
.backdrop { position: absolute; inset: -64px 0 0; z-index: 0; pointer-events: none;
  background:
    radial-gradient(42% 30% at 22% 6%, var(--pair-glow-1), transparent 72%),
    radial-gradient(38% 30% at 82% 12%, var(--pair-glow-2), transparent 72%),
    radial-gradient(50% 26% at 50% 52%, var(--pair-glow-1), transparent 72%),
    radial-gradient(30% 24% at 70% 40%, var(--pair-glow-3), transparent 72%); }
.backdrop::after { content: ""; position: absolute; inset: 0;
  background-image: radial-gradient(var(--pair-dots) 1.2px, transparent 1.3px); background-size: 22px 22px;
  mask-image: linear-gradient(to bottom, #000 0%, rgba(0, 0, 0, .7) 40%, transparent 85%); }
.hero .wrap { z-index: 1; }
.intro { max-width: 1040px; text-align: center; display: flex; flex-direction: column; align-items: center; }
.intro .lede { margin-inline: auto; }
.intro .cta { justify-content: center; }
.intro .versus { width: 100%; max-width: 900px; text-align: left; }
.eyebrow { display: inline-flex; align-items: center; gap: 10px; font: 500 13px/1.3 var(--vp-font-family-mono); color: var(--vp-c-text-2); margin: 0 0 26px; padding: 7px 14px; border-radius: 999px; background: var(--pair-card); border: 1px solid var(--vp-c-border); box-shadow: var(--pair-card-shadow); }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--pair-scout); box-shadow: 0 0 0 0 var(--pair-scout); animation: pulse 2.4s infinite; flex: none; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--pair-scout) 60%, transparent); } 70%, 100% { box-shadow: 0 0 0 9px transparent; } }
h1 { font-size: clamp(40px, 7.2vw, 84px); line-height: 1.0; font-weight: 800; letter-spacing: -.045em; margin: 0 0 26px; text-wrap: balance; color: var(--vp-c-text-1); }
.grad { background: var(--pair-grad); -webkit-background-clip: text; background-clip: text; color: transparent; padding-bottom: .06em; }
.lede { font-size: clamp(18px, 2.2vw, 21px); line-height: 1.6; color: var(--vp-c-text-1); margin: 0; max-width: 36em; }

.versus { list-style: none; padding: 0; margin: 32px 0 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.versus li { padding: 14px 16px; border-radius: 12px; border: 1px dashed var(--vp-c-border); color: var(--vp-c-text-2); font-size: 15px; line-height: 1.5; }
.versus b { display: block; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--vp-c-text-3); margin-bottom: 4px; }
.versus li:not(.us) b { text-decoration: line-through; text-decoration-thickness: 1.5px; }
.versus li.us { border: 1.5px solid transparent; color: var(--vp-c-text-1); background: linear-gradient(var(--pair-card), var(--pair-card)) padding-box, var(--pair-grad-bar) border-box; box-shadow: var(--pair-card-shadow); }
.versus li.us b { color: var(--vp-c-brand-1); }

.cta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 32px; }
.btn { display: inline-flex; align-items: center; gap: 8px; font: 700 15.5px/1 var(--vp-font-family-base); padding: 15px 22px; border-radius: 12px; text-decoration: none; border: 1px solid var(--vp-c-border); color: var(--vp-c-text-1); background: var(--pair-card); transition: border-color .2s, transform .2s, box-shadow .2s; }
.btn:hover { border-color: var(--vp-c-brand-1); transform: translateY(-1px); }
.btn.ghost { background: transparent; }
.btn.primary { color: #fff; border: 0; background: linear-gradient(100deg, #5B3DEB, #8B3FE0 60%, #4E6CF0); box-shadow: 0 10px 30px -10px rgba(110, 70, 240, .7); }
.btn.primary:hover { box-shadow: 0 14px 36px -10px rgba(110, 70, 240, .85); }

/* framed windows: the tour and the loops */
#tour { margin-top: 64px; z-index: 1; }
.window { position: relative; border-radius: 14px; overflow: hidden; background: var(--pair-window); border: 1px solid var(--pair-window-edge); box-shadow: 0 2px 0 rgba(255, 255, 255, .04) inset, 0 40px 80px -40px rgba(20, 10, 60, .65), 0 18px 36px -24px rgba(0, 0, 0, .5); }
.window.glow::before { content: ""; position: absolute; inset: -1px; border-radius: 15px; padding: 1px; background: var(--pair-grad-bar); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; pointer-events: none; z-index: 2; opacity: .8; }
#tour .window { box-shadow: 0 0 0 1px rgba(124, 92, 255, .1), 0 30px 120px -30px var(--pair-glow-1), 0 40px 80px -40px rgba(20, 10, 60, .6); }
.bar { display: flex; align-items: center; gap: 7px; height: 36px; padding: 0 14px; background: var(--pair-window-bar); border-bottom: 1px solid rgba(255, 255, 255, .05); }
.bar i { width: 11px; height: 11px; border-radius: 50%; background: #F7768E; }
.bar i:nth-child(2) { background: #E0AF68; }
.bar i:nth-child(3) { background: #9ECE6A; }
.bar span { margin-left: 10px; font: 400 12.5px/1 var(--vp-font-family-mono); color: #A9B1D6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.window video { display: block; width: 100%; height: auto; background: #1A1B26; }
#tour video { aspect-ratio: 16 / 9; }
.chapters { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; justify-content: center; }
.chip { font: 400 13.5px/1.3 var(--vp-font-family-mono); color: var(--vp-c-text-2); background: var(--pair-card); border: 1px solid var(--vp-c-border); border-radius: 999px; padding: 8px 13px; cursor: pointer; transition: border-color .2s, color .2s; }
.chip b { color: var(--vp-c-brand-1); font-weight: 700; margin-right: 8px; }
.chip:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-text-1); }

/* section heads */
.kicker { display: inline-block; font: 700 13px/1 var(--vp-font-family-mono); letter-spacing: .12em; text-transform: uppercase; margin: 0 0 14px; background: var(--pair-grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
h2 { font-size: clamp(30px, 4.6vw, 48px); line-height: 1.08; font-weight: 800; letter-spacing: -.035em; margin: 0 0 14px; text-wrap: balance; color: var(--vp-c-text-1); max-width: 22em; }
h3 { font-size: 21px; line-height: 1.3; font-weight: 800; letter-spacing: -.015em; margin: 0 0 8px; color: var(--vp-c-text-1); }
p { margin: 0; line-height: 1.65; color: var(--vp-c-text-2); }
.sub { font-size: 18px; max-width: 38em; }
.more { margin-top: 30px; font-size: 16px; display: flex; flex-wrap: wrap; gap: 8px 28px; }
.more a { color: var(--vp-c-brand-1); font-weight: 700; text-decoration: none; }
.more a:hover { text-decoration: underline; text-underline-offset: .2em; }
a { color: var(--vp-c-brand-1); }
p :deep(code), .note { font-family: var(--vp-font-family-mono); font-size: .86em; color: var(--vp-code-color); background: var(--vp-code-bg); padding: .12em .4em; border-radius: 5px; overflow-wrap: anywhere; }

/* the three moments */
.moment { margin-top: 72px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px; }
@media (min-width: 980px) {
  .moment { grid-template-columns: minmax(0, 320px) minmax(0, 1fr); gap: 52px; align-items: center; margin-top: 96px; }
  .moment.flip { grid-template-columns: minmax(0, 1fr) minmax(0, 320px); }
  .moment.flip .moment-text { order: 2; }
}
.num { display: inline-grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; font: 800 16px/1 var(--vp-font-family-mono); color: #fff; background: linear-gradient(135deg, #6D5BF5, #B04FE0); box-shadow: 0 8px 20px -8px rgba(110, 70, 240, .7); margin-bottom: 16px; }
.moment h3 { font-size: clamp(24px, 2.6vw, 30px); line-height: 1.15; letter-spacing: -.025em; }
.moment p { font-size: 17px; }
.badges { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.demo { margin: 0; }
.screen { position: relative; }
.screen video { aspect-ratio: 1280 / 768; cursor: pointer; }
.ff { position: absolute; left: 14px; top: 12px; font: 700 12px/1 var(--vp-font-family-mono); color: #1A1B26; background: #E0AF68; padding: 6px 9px; border-radius: 6px; opacity: 0; transition: opacity .2s; }
.ff.on { opacity: 1; }
.callout { font: 800 15px/1.3 var(--vp-font-family-base); color: #fff; letter-spacing: -.005em; }
.callout :deep(kbd) { font: 700 .88em/1 var(--vp-font-family-mono); padding: 3px 6px; border-radius: 5px; background: rgba(255, 255, 255, .18); border: 1px solid rgba(255, 255, 255, .3); }
.callout.over { position: absolute; right: 3%; max-width: 36%; padding: 11px 15px 11px 16px; border-radius: 12px; background: linear-gradient(120deg, #6D5BF5, #B04FE0); box-shadow: 0 0 0 1px rgba(255, 255, 255, .14) inset, 0 12px 30px -8px rgba(110, 60, 240, .8), 0 0 40px -6px rgba(176, 79, 224, .55); opacity: 0; transform: translateX(10px) scale(.97); transition: opacity .3s, transform .3s; pointer-events: none; }
.callout.over::before { content: ""; position: absolute; left: -7px; top: 50%; width: 14px; height: 14px; margin-top: -7px; background: #6D5BF5; transform: rotate(45deg); border-radius: 2px; }
.callout.over.on { opacity: 1; transform: none; }
.callout.under { display: none; }
.playpause { position: absolute; right: 14px; bottom: 14px; width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, .15); background: rgba(19, 20, 30, .8); color: #C0CAF5; font-size: 12px; cursor: pointer; }

/* how it works */
.steps { list-style: none; padding: 0; margin: 40px 0 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; position: relative; }
.steps::before { content: ""; position: absolute; left: 22px; right: 22px; top: 22px; height: 2px; background: var(--pair-grad-bar); opacity: .5; }
.steps li { position: relative; }
.step-n { position: relative; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; font: 800 16px/1 var(--vp-font-family-mono); color: var(--vp-c-brand-1); background: var(--vp-c-bg); border: 2px solid var(--vp-c-brand-1); margin-bottom: 16px; }
.steps p, .install p { font-size: 16.5px; }
.card { position: relative; background: var(--pair-card); border: 1px solid var(--vp-c-divider); border-radius: 16px; padding: 22px 22px 24px; box-shadow: var(--pair-card-shadow); }
.cast { margin-top: 56px; display: grid; gap: 30px; }
.cast-h { font-size: 15px; letter-spacing: .06em; text-transform: uppercase; color: var(--vp-c-text-2); font-weight: 700; margin-bottom: 14px; }
.cast-h small { text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--vp-c-text-3); margin-left: 8px; font-size: 14px; }
.cast-cards { display: grid; gap: 14px; }
.cast-cards.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.cast-cards.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.cast .card { border-top: 3px solid var(--c); overflow: hidden; }
.cast .card::after { content: ""; position: absolute; inset: 0 0 auto; height: 90px; background: linear-gradient(to bottom, color-mix(in srgb, var(--c) 10%, transparent), transparent); pointer-events: none; }
.card.watcher { --c: var(--pair-watcher); } .card.partner { --c: var(--pair-partner); } .card.navigator { --c: var(--pair-navigator); }
.card.scout { --c: var(--pair-scout); } .card.driver { --c: var(--pair-driver); }
.cast .role { font-size: 14px; padding: 7px 12px 7px 10px; }
.cast .note { margin-left: 10px; font-size: 12.5px; }
.cast p { margin-top: 14px; font-size: 16px; }

/* models */
.providers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 34px; }
.provider h3 { margin-top: 16px; }
.provider p { font-size: 16px; }
.icon { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 14px; color: #fff; }
.icon svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.icon.local { background: linear-gradient(135deg, #0FA37F, #3FC8F0); box-shadow: 0 8px 20px -8px rgba(15, 163, 127, .7); }
.icon.key { background: linear-gradient(135deg, #E0912F, #F7768E); box-shadow: 0 8px 20px -8px rgba(224, 145, 47, .7); }
.icon.login { background: linear-gradient(135deg, #6D5BF5, #B04FE0); box-shadow: 0 8px 20px -8px rgba(110, 70, 240, .7); }

/* install */
.install { list-style: none; padding: 0; margin: 36px 0 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 30px; }
.install li { position: relative; padding-left: 64px; min-width: 0; }
.install .step-n { position: absolute; left: 0; top: -6px; margin: 0; }
.install li:not(:last-child)::after { content: ""; position: absolute; left: 21px; top: 44px; bottom: -30px; width: 2px; background: linear-gradient(var(--vp-c-brand-1), transparent); opacity: .35; }
.code { position: relative; background: #1A1B26; border: 1px solid var(--pair-window-edge); border-radius: 12px; margin: 12px 0 10px; color: #C0CAF5; box-shadow: var(--pair-card-shadow); }
.code pre { margin: 0; padding: 16px 64px 16px 18px; overflow-x: auto; font: 400 14.5px/1.65 var(--vp-font-family-mono); }
.code code { background: none; padding: 0; color: inherit; font-size: inherit; }
.copy { position: absolute; top: 9px; right: 9px; font: 400 12px/1 var(--vp-font-family-mono); color: #A9B1D6; background: #24283B; border: 1px solid #3B4261; border-radius: 6px; padding: 7px 9px; cursor: pointer; }
.copy:hover { color: #fff; border-color: #7AA2F7; }

/* the closing band */
.band { position: relative; overflow: hidden; text-align: center; padding: 56px 28px; border-radius: 24px; color: #fff;
  background: radial-gradient(60% 90% at 15% 0%, rgba(176, 79, 224, .55), transparent 70%), radial-gradient(50% 90% at 100% 100%, rgba(63, 200, 240, .4), transparent 70%), linear-gradient(135deg, #1B1640, #241A55 50%, #102540); box-shadow: 0 40px 80px -40px rgba(60, 30, 160, .6); }
.band::after { content: ""; position: absolute; inset: 0; background-image: radial-gradient(rgba(255, 255, 255, .08) 1.2px, transparent 1.3px); background-size: 22px 22px; pointer-events: none; }
.band h2 { color: #fff; margin: 0 auto 12px; }
.band p { color: #D4D8F5; font-size: 18px; }
.band .cta { justify-content: center; position: relative; z-index: 1; }
.band .btn:not(.primary) { background: rgba(255, 255, 255, .08); color: #fff; border-color: rgba(255, 255, 255, .25); }

@media (max-width: 979px) {
  .callout.over { display: none; }
  .callout.under { display: block; margin-top: 12px; padding: 12px 14px; border-radius: 12px; background: linear-gradient(120deg, #6D5BF5, #B04FE0); box-shadow: 0 10px 24px -10px rgba(110, 60, 240, .7); }
}
@media (max-width: 760px) {
  section { padding-top: 80px; }
  .hero { padding-top: 40px; }
  .wrap { padding: 0 16px; }
  .versus, .steps, .providers, .cast-cards.two, .cast-cards.three { grid-template-columns: minmax(0, 1fr); }
  .steps::before { display: none; }
  .steps li { padding-left: 60px; }
  .steps .step-n { position: absolute; left: 0; top: -6px; }
  .btn { flex: 1 1 auto; justify-content: center; }
  .install li { padding-left: 56px; }
  .moment { margin-top: 56px; }
  .playpause { right: 10px; bottom: 10px; width: 32px; height: 32px; }
  .bar { height: 30px; }
  .bar span { font-size: 11.5px; }
  .eyebrow { font-size: 12px; }
  .chapters { flex-wrap: nowrap; justify-content: flex-start; overflow-x: auto; margin-inline: -16px; padding: 0 16px 6px; scrollbar-width: none; }
  .chip { flex: none; }
  .band { padding: 44px 20px; }
}
@media (prefers-reduced-motion: reduce) {
  .pulse { animation: none; }
  .callout.over, .btn { transition: none; }
}
</style>
