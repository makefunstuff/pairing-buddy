<script setup>
// The front page: what Pair is, the tutorial and three moments, how it works, its models, and the install.
// The tutorial's chapters and length come from docs/video/chapters.json, which docs/video/build.mjs writes. The three loops come from
// docs/captures/encode.sh, and their callouts are timed on those clips.
import {onBeforeUnmount, onMounted, ref} from 'vue';
import {withBase} from 'vitepress';
import tour from '../../../docs/video/chapters.json';

const chapters = tour.chapters;
const minutes = Math.round(tour.length / 60);
const video = ref(null);
const media = path => withBase(`/media/${path}`);
const sprite = name => withBase(`/sprites/${name}.svg`); // site/sprites/build.mjs draws them

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
  {icon: 'daemon', title: 'Install the daemon', code: 'npm install -g github:makefunstuff/pairing-buddy\npair setup', text: '<code>pair setup</code> writes the config, offers a login and starts the daemon as a user service.'},
  {icon: 'plugin', title: 'Add the Neovim plugin', code: "{\n  'makefunstuff/pairing-buddy',\n  main = 'pair',\n  lazy = false,\n  opts = {auto_connect = true},\n}", text: 'With lazy.nvim. Your model goes in <code>~/.config/pairing-buddy/config.json</code>.'},
  {icon: 'doctor', title: 'Check it, and pair', code: 'pair doctor', text: 'One line per part, with the fix when something is wrong. Then run <code>pair</code> next to Neovim in herdr, or <code>:Pair chat</code> in Neovim.'},
];

// A few of docs/tutorials/, each a task in a few minutes; the section links to all of them.
const tutorials = [
  {page: 'first-ten-minutes', title: 'The first ten minutes', text: 'Install, pair doctor, and your first session on a project.'},
  {page: 'chat-pane', title: 'The chat pane and its keys', text: 'Ask, run a command, and act on what Pair said.'},
  {page: 'roles-and-hand-over', title: 'Roles and handing over', text: 'Let Scout run commands, hand over the keyboard, take it back.'},
  {page: 'gen-here-and-file', title: 'Asking for code', text: '/gen here at your cursor, /gen file for new files to review.'},
  {page: 'board', title: 'Hand a task to the board', text: '/gen board, then :Pair review to keep the pieces you want.'},
  {page: 'worktrees', title: 'Several worktrees', text: 'Two pieces of work in one repository, a session each.'},
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
      <div class="wrap intro">
        <img class="mascot" :src="sprite('mascot')" alt="" width="152" height="92">
        <p class="eyebrow"><span class="pulse"></span>Neovim plugin + daemon · local or cloud models · MIT</p>
        <h1 id="hero-h">A pair programmer that <span class="hl">knows when to speak.</span></h1>
        <p class="lede">Pair sits in the second chair while you work in Neovim. It watches, says one short line when something matters, and types only when you hand it the keyboard. It never writes your files.</p>
        <ul class="versus" aria-label="How Pair differs">
          <li v-for="v in versus" :key="v.name" :class="{us: v.us}"><b>{{ v.name }}</b><span>{{ v.text }}</span></li>
        </ul>
        <div class="cta">
          <a class="btn primary" :href="withBase('/getting-started.html')">Get started <span aria-hidden="true">→</span></a>
          <a class="btn" href="#tour">Watch the {{ minutes }}-minute tutorial</a>
          <a class="btn ghost" href="https://github.com/makefunstuff/pairing-buddy">GitHub</a>
        </div>
      </div>

      <div class="wrap wide" id="tour">
        <div class="window">
          <div class="bar" aria-hidden="true"><i></i><i></i><i></i><span>The tutorial · {{ minutes }} min · with captions</span></div>
          <video ref="video" controls playsinline preload="none" :poster="media('hero-poster.jpg')" width="1280" height="720"
            :aria-label="`Video: a ${minutes}-minute tutorial of how pairing-buddy works, with a voiceover and captions`">
            <source :src="media('hero.webm')" type="video/webm">
            <source :src="media('hero.mp4')" type="video/mp4">
            <track kind="captions" :src="media('hero.vtt')" srclang="en" label="English">
            <track kind="chapters" :src="media('hero-chapters.vtt')" srclang="en" label="Chapters">
          </video>
        </div>
        <div class="chapters" aria-label="Chapters of the tutorial">
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
                <img class="tile" :src="sprite(r.role)" alt="" width="72" height="72">
                <span class="role" :class="r.role">{{ r.name }}</span>
                <p v-html="r.text"></p>
              </div>
            </div>
          </div>
          <div class="cast-group">
            <h3 class="cast-h">Three roles you switch between <small>one at a time, enforced in code</small></h3>
            <div class="cast-cards three">
              <div v-for="r in roles" :key="r.name" class="card" :class="r.role">
                <img class="tile" :src="sprite(r.role)" alt="" width="72" height="72">
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
            <img class="tile" :src="sprite(m.icon)" alt="" width="72" height="72">
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
            <img class="tile" :src="sprite(s.icon)" alt="" width="72" height="72">
            <h3><span class="step-k">{{ i + 1 }}</span>{{ s.title }}</h3>
            <div class="code">
              <button class="copy" type="button" @click="copy(i)">{{ copied === i ? 'copied' : 'copy' }}</button>
              <pre><code>{{ s.code }}</code></pre>
            </div>
            <p v-html="s.text"></p>
          </li>
        </ol>
      </div>
    </section>

    <section class="tutorials" aria-labelledby="tutorials-h">
      <div class="wrap wide">
        <p class="kicker">Tutorials</p>
        <h2 id="tutorials-h">Learn it one task at a time</h2>
        <p class="sub">Short how-tos, a few minutes each, step by step with the exact keys and commands.</p>
        <ul class="providers tuts">
          <li v-for="t in tutorials" :key="t.page" class="card">
            <h3><a :href="withBase(`/tutorials/${t.page}.html`)">{{ t.title }}</a></h3>
            <p>{{ t.text }}</p>
          </li>
        </ul>
        <p class="more"><a :href="withBase('/tutorials/')">All the tutorials →</a></p>
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
/* The pixel-art front page: colours and fonts from tokens.css. Solid fills, hard 3px frames, shadows that are solid
   blocks offset down and right, and buttons that press into them. */
.landing { overflow-x: clip; padding-bottom: 72px; }
.wrap { max-width: 800px; margin: 0 auto; padding: 0 24px; position: relative; }
.wrap.wide { max-width: 1180px; }
section { padding-top: 112px; position: relative; }
.tile, .mascot { image-rendering: pixelated; display: block; }

/* the hero: Pair, then the headline */
.hero { padding-top: 64px; }
.intro { max-width: 1040px; text-align: center; display: flex; flex-direction: column; align-items: center; }
.intro .lede { margin-inline: auto; }
.intro .cta { justify-content: center; }
.intro .versus { width: 100%; max-width: 900px; text-align: left; }
.mascot { width: 152px; height: 92px; margin-bottom: 24px; animation: bob 1.2s steps(1) infinite; }
@keyframes bob { 50% { transform: translateY(-4px); } }
.eyebrow { display: inline-flex; align-items: center; gap: 10px; font: 500 13px/1.3 var(--vp-font-family-mono); color: var(--vp-c-text-1); margin: 0 0 26px; padding: 7px 14px; background: var(--pair-card); border: 2px solid var(--pair-ink); box-shadow: var(--pair-shadow); }
.pulse { width: 8px; height: 8px; background: var(--px-green); outline: 2px solid var(--pair-ink); flex: none; animation: blink 1.2s steps(1) infinite; }
@keyframes blink { 50% { background: var(--px-forest); } }
h1 { font: 600 clamp(36px, 6vw, 68px)/1.05 var(--px-font-pixel); letter-spacing: .01em; margin: 0 0 26px; text-wrap: balance; color: var(--vp-c-text-1); }
.hl { color: var(--vp-c-brand-1); }
.lede { font-size: clamp(18px, 2.2vw, 21px); line-height: 1.6; color: var(--vp-c-text-1); margin: 0; max-width: 36em; }

.versus { list-style: none; padding: 0; margin: 36px 0 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.versus li { padding: 14px 16px; border: 2px dashed var(--vp-c-border); color: var(--vp-c-text-2); font-size: 15px; line-height: 1.5; }
.versus b { display: block; font: 500 15px/1.2 var(--px-font-pixel); letter-spacing: .04em; text-transform: uppercase; color: var(--vp-c-text-3); margin-bottom: 6px; }
/* the two it is not: a red pixel cross before the name (a strike-through cuts the pixel font's C in half) */
.versus b { display: flex; align-items: center; gap: 8px; }
.versus li:not(.us) b::before { content: ""; flex: none; width: 15px; height: 15px; image-rendering: pixelated;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 5 5' shape-rendering='crispEdges'%3E%3Cpath fill='%23FF004D' d='M0 0h1v1H0zM4 0h1v1H4zM1 1h1v1H1zM3 1h1v1H3zM2 2h1v1H2zM1 3h1v1H1zM3 3h1v1H3zM0 4h1v1H0zM4 4h1v1H4z'/%3E%3C/svg%3E") center / 15px 15px no-repeat; }
.versus li.us { border: var(--px-border) solid var(--pair-ink); color: var(--px-black); background: var(--px-yellow); box-shadow: var(--pair-shadow); }
.versus li.us b { color: var(--px-black); }

/* buttons: a solid block on its shadow; pressed, it sits down into it */
.cta { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 34px; }
.btn { display: inline-flex; align-items: center; gap: 8px; font: 500 18px/1 var(--px-font-pixel); letter-spacing: .02em; padding: 14px 20px; text-decoration: none; color: var(--vp-c-text-1); background: var(--pair-card); border: var(--px-border) solid var(--pair-ink); box-shadow: var(--pair-shadow); }
.btn:hover { background: var(--vp-c-bg-soft); }
.btn:active, .chip:active, .copy:active, .playpause:active { transform: translate(4px, 4px); box-shadow: none; }
.btn:focus-visible, .chip:focus-visible { outline: var(--px-border) solid var(--vp-c-brand-1); outline-offset: 3px; }
.btn.ghost { background: transparent; box-shadow: none; border-style: dashed; }
.btn.primary { color: var(--px-black); background: var(--px-yellow); }
.btn.primary:hover { background: var(--px-orange); }

/* framed windows: the tutorial and the loops */
#tour { margin-top: 64px; z-index: 1; }
.window { position: relative; background: var(--pair-window); border: var(--px-border) solid var(--pair-ink); box-shadow: var(--pair-shadow-lg); }
.bar { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; background: var(--pair-window-bar); border-bottom: var(--px-border) solid var(--pair-ink); }
.bar i { width: 12px; height: 12px; background: var(--px-red); outline: 2px solid var(--px-black); }
.bar i:nth-child(2) { background: var(--px-orange); }
.bar i:nth-child(3) { background: var(--px-green); }
.bar span { margin-left: 12px; font: 400 15px/1 var(--px-font-pixel); letter-spacing: .03em; color: var(--px-cream); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.window video { display: block; width: 100%; height: auto; background: var(--px-black); }
#tour video { aspect-ratio: 16 / 9; }
.chapters { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; justify-content: center; }
.chip { font: 400 13.5px/1.3 var(--vp-font-family-mono); color: var(--vp-c-text-1); background: var(--pair-card); border: 2px solid var(--pair-ink); box-shadow: 2px 2px 0 var(--pair-ink); padding: 7px 11px; cursor: pointer; }
.chip b { font: 500 15px/1 var(--px-font-pixel); color: var(--vp-c-brand-1); margin-right: 8px; }
.chip:hover { background: var(--px-yellow); color: var(--px-black); }
.chip:hover b { color: var(--px-plum); }

/* section heads */
.kicker { display: inline-block; font: 500 15px/1 var(--px-font-pixel); letter-spacing: .1em; text-transform: uppercase; margin: 0 0 18px; padding: 6px 10px; color: var(--px-cream); background: var(--px-plum); box-shadow: var(--pair-shadow); }
h2 { font: 600 clamp(30px, 4.4vw, 46px)/1.1 var(--px-font-pixel); letter-spacing: .005em; margin: 0 0 14px; text-wrap: balance; color: var(--vp-c-text-1); max-width: 22em; }
h3 { font: 500 22px/1.25 var(--px-font-pixel); letter-spacing: .01em; margin: 0 0 8px; color: var(--vp-c-text-1); }
p { margin: 0; line-height: 1.65; color: var(--vp-c-text-2); }
.sub { font-size: 18px; max-width: 38em; }
.more { margin-top: 32px; display: flex; flex-wrap: wrap; gap: 8px 28px; }
.more a { font: 500 18px/1.3 var(--px-font-pixel); color: var(--vp-c-brand-1); text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: .25em; }
.more a:hover { background: var(--px-yellow); color: var(--px-black); }
a { color: var(--vp-c-brand-1); }
p :deep(code), .note { font-family: var(--vp-font-family-mono); font-size: .86em; color: var(--vp-code-color); background: var(--vp-code-bg); padding: .12em .4em; overflow-wrap: anywhere; }

/* the three moments */
.moment { margin-top: 72px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px; }
@media (min-width: 980px) {
  .moment { grid-template-columns: minmax(0, 320px) minmax(0, 1fr); gap: 52px; align-items: center; margin-top: 96px; }
  .moment.flip { grid-template-columns: minmax(0, 1fr) minmax(0, 320px); }
  .moment.flip .moment-text { order: 2; }
}
.num { display: inline-grid; place-items: center; width: 48px; height: 48px; font: 500 22px/1 var(--px-font-pixel); color: var(--px-black); background: var(--px-pink); border: var(--px-border) solid var(--pair-ink); box-shadow: var(--pair-shadow); margin-bottom: 18px; }
.moment h3 { font-size: clamp(26px, 2.8vw, 32px); line-height: 1.15; }
.moment p { font-size: 17px; }
.badges { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.demo { margin: 0; }
.screen { position: relative; }
.screen video { aspect-ratio: 1280 / 768; cursor: pointer; }
.ff { position: absolute; left: 12px; top: 12px; font: 500 15px/1 var(--px-font-pixel); color: var(--px-black); background: var(--px-orange); border: 2px solid var(--px-black); padding: 5px 8px; visibility: hidden; }
.ff.on { visibility: visible; }
/* callouts: a yellow box in a black frame, pointing at Pair's line with a pixel arrow */
/* the words are Inter: they name files and lines (worker.go:35), where the pixel font's 5 reads as an S */
.callout { font: 700 15.5px/1.35 var(--vp-font-family-base); color: var(--px-black); }
.callout :deep(kbd) { font: 700 .82em/1 var(--vp-font-family-mono); padding: 2px 5px; background: var(--px-cream); border: 2px solid var(--px-black); }
.callout.over { position: absolute; right: 3%; max-width: 36%; padding: 10px 14px; background: var(--px-yellow); border: var(--px-border) solid var(--px-black); box-shadow: var(--pair-shadow); visibility: hidden; pointer-events: none; }
.callout.over::before { content: ""; position: absolute; left: -15px; top: 50%; width: 12px; height: 18px; margin-top: -9px; background: var(--px-black);
  clip-path: polygon(0 33.3%, 33.3% 33.3%, 33.3% 16.7%, 66.7% 16.7%, 66.7% 0, 100% 0, 100% 100%, 66.7% 100%, 66.7% 83.3%, 33.3% 83.3%, 33.3% 66.7%, 0 66.7%); }
.callout.over.on { visibility: visible; animation: pop .24s steps(2); }
@keyframes pop { from { transform: translateX(8px); } }
.callout.under { display: none; }
.playpause { position: absolute; right: 12px; bottom: 12px; width: 36px; height: 36px; border: 2px solid var(--px-black); background: var(--px-navy); color: var(--px-cream); box-shadow: 2px 2px 0 var(--px-black); font-size: 12px; cursor: pointer; }

/* how it works */
.steps { list-style: none; padding: 0; margin: 40px 0 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; position: relative; }
.steps::before { content: ""; position: absolute; left: 24px; right: 24px; top: 22px; border-top: 4px dashed var(--vp-c-border); }
.steps li { position: relative; }
.step-n { position: relative; display: grid; place-items: center; width: 48px; height: 48px; font: 500 22px/1 var(--px-font-pixel); color: var(--px-black); background: var(--px-blue); border: var(--px-border) solid var(--pair-ink); box-shadow: var(--pair-shadow); margin-bottom: 18px; }
.steps p, .install p { font-size: 16.5px; }
.card { position: relative; background: var(--pair-card); border: var(--px-border) solid var(--pair-ink); padding: 20px 20px 22px; box-shadow: var(--pair-shadow); }
.card .tile { width: 72px; height: 72px; margin-bottom: 14px; }
.cast { margin-top: 56px; display: grid; gap: 30px; }
.cast-h { font-size: 18px; letter-spacing: .06em; text-transform: uppercase; color: var(--vp-c-text-2); margin-bottom: 16px; }
.cast-h small { font: 500 14px/1.3 var(--vp-font-family-base); text-transform: none; letter-spacing: 0; color: var(--vp-c-text-3); margin-left: 8px; }
.cast-cards { display: grid; gap: 18px; }
.cast-cards.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.cast-cards.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.cast .card { padding-top: 30px; box-shadow: inset 0 10px 0 var(--c), var(--pair-shadow); }
.card.watcher { --c: var(--pair-watcher); } .card.partner { --c: var(--pair-partner); } .card.navigator { --c: var(--pair-navigator); }
.card.scout { --c: var(--pair-scout); } .card.driver { --c: var(--pair-driver); }
.cast .role { font-size: 16px; padding: 4px 10px 4px 5px; }
.cast .note { margin-left: 12px; font-size: 12.5px; }
.cast p { margin-top: 14px; font-size: 16px; }

/* models */
.providers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin-top: 34px; }
.provider p { font-size: 16px; }
.tuts { list-style: none; padding: 0; }
.tuts .card { margin: 0; }
.tuts h3 { margin: 0 0 8px; }
.tuts h3 a { color: var(--vp-c-brand-1); text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: .25em; }
.tuts h3 a:hover { background: var(--px-yellow); color: var(--px-black); }
.tuts p { font-size: 16px; margin: 0; }

/* install */
.install { list-style: none; padding: 0; margin: 36px 0 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 34px; }
.install li { position: relative; padding-left: 92px; min-width: 0; }
.install .tile { position: absolute; left: 0; top: -4px; width: 72px; height: 72px; background: var(--pair-card); border: var(--px-border) solid var(--pair-ink); box-shadow: var(--pair-shadow); }
.install li:not(:last-child)::after { content: ""; position: absolute; left: 36px; top: 82px; bottom: -30px; border-left: 4px dashed var(--vp-c-border); }
.step-k { display: inline-grid; place-items: center; min-width: 28px; height: 28px; margin-right: 10px; font-size: 17px; color: var(--px-black); background: var(--px-blue); border: 2px solid var(--pair-ink); vertical-align: 2px; }
.code { position: relative; background: var(--px-black); border: var(--px-border) solid var(--pair-ink); margin: 12px 0 10px; color: var(--px-cream); box-shadow: var(--pair-shadow); }
.code pre { margin: 0; padding: 16px 72px 16px 18px; overflow-x: auto; font: 400 14.5px/1.65 var(--vp-font-family-mono); }
.code code { background: none; padding: 0; color: inherit; font-size: inherit; }
.copy { position: absolute; top: 9px; right: 9px; font: 500 14px/1 var(--px-font-pixel); color: var(--px-black); background: var(--px-silver); border: 2px solid var(--px-cream); padding: 6px 9px; cursor: pointer; }
.copy:hover { background: var(--px-yellow); }

/* the closing band: a solid block in a hard frame */
.band { position: relative; text-align: center; padding: 56px 28px; color: var(--px-cream); background: var(--pair-band); border: var(--px-border) solid var(--pair-ink); box-shadow: var(--pair-shadow-lg); }
.band h2 { color: var(--px-cream); margin: 0 auto 12px; }
.band p { color: var(--px-cream); font-size: 18px; }
.band .btn:not(.primary) { background: var(--px-cream); color: var(--px-black); }

@media (max-width: 979px) {
  .callout.over { display: none; }
  .callout.under { display: block; margin-top: 18px; padding: 12px 14px; background: var(--px-yellow); border: var(--px-border) solid var(--pair-ink); box-shadow: var(--pair-shadow); }
}
@media (max-width: 760px) {
  section { padding-top: 80px; }
  .hero { padding-top: 36px; }
  .wrap { padding: 0 16px; }
  .versus, .steps, .providers, .cast-cards.two, .cast-cards.three { grid-template-columns: minmax(0, 1fr); }
  .steps::before { display: none; }
  .steps li { padding-left: 66px; }
  .steps .step-n { position: absolute; left: 0; top: -6px; }
  .btn { flex: 1 1 auto; justify-content: center; }
  .install li { padding-left: 0; }
  .install .tile { position: static; width: 54px; height: 54px; margin-bottom: 14px; }
  .install li:not(:last-child)::after { display: none; }
  .moment { margin-top: 56px; }
  .playpause { right: 8px; bottom: 8px; width: 32px; height: 32px; }
  .bar { height: 30px; }
  .bar span { font-size: 13px; }
  .eyebrow { font-size: 12px; }
  .chapters { flex-wrap: nowrap; justify-content: flex-start; overflow-x: auto; margin-inline: -16px; padding: 0 16px 8px; scrollbar-width: none; }
  .chip { flex: none; }
  .band { padding: 44px 20px; }
}
@media (prefers-reduced-motion: reduce) {
  .mascot, .pulse, .callout.over.on { animation: none; }
}
</style>
