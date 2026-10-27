<script setup>
// The front page: what Pair is, the tour and three moments, how it works, its models, and the install.
// The tour's chapters come from docs/video/chapters.json, which docs/video/build.mjs writes.
import {onBeforeUnmount, onMounted, ref} from 'vue';
import {withBase} from 'vitepress';
import tour from '../../../docs/video/chapters.json';

const chapters = tour.chapters;
const video = ref(null);
const media = path => withBase(`/media/${path}`);

const moments = [
  {
    id: 'm1', poster: 'm1-still1.webp', title: 'It stops the wrong turn',
    text: 'A retry test fails and you start fixing the backoff. Pair reads your edit and the worker, and says in two lines under your edit that the real cause is <code>worker.go:35</code>, with <code>Alt-j</code> to go there.',
    label: 'Capture: Pair reads backoff.go and worker.go, writes two lines under your edit, and Alt-j takes you to the real cause',
  },
  {
    id: 'm2', poster: 'm2-still1.webp', title: 'It runs what you\'d skip',
    text: 'Your fix passes, so you would push. Pair ran the tests as you saved, names the one your change broke elsewhere, says why under the line you changed, and offers the one-line fix: <code>Alt-y</code> takes it.',
    label: 'Capture: Pair runs the tests on save, names the failing test, says why under your line, and puts a one-line fix in queue.go that Alt-y takes',
  },
  {
    id: 'm3', poster: 'm3-still2.webp', title: 'It takes the keyboard, and gives it back',
    text: 'You hand over the edge cases. Pair types six table cases into your buffer while you watch, runs the tests on the unsaved buffer and hands back. One <code>u</code> undoes all six.',
    label: 'Capture: the Driver types six table test cases, tests the unsaved buffer, hands back, and u takes all six away',
  },
];

const steps = [
  {title: 'The plugin watches with you', text: 'The Neovim plugin sends the daemon what you do: edits, saves, searches, diagnostics and test runs. In herdr, Pair also sees your terminals.'},
  {title: 'The Watcher decides if it is worth a word', text: 'A small, fast model scores each moment from 0 to 10 in about a second. Most moments score low, so Pair stays quiet, and it never interrupts your typing.'},
  {title: 'The Partner says it where you look', text: 'A larger model, or the same one, writes one or two short lines under the line they are about, with the key that acts on them.'},
  {title: 'You choose how much it may do', text: 'One role at a time, switched with a command, and enforced in code:'},
];

const roles = [
  {name: 'Navigator', note: 'default', text: 'Points at lines, answers questions, suggests a change you take with <code>Alt-y</code>.'},
  {name: 'Scout', note: ':Pair scout', text: 'Also searches and runs tests and builds in its own pane, where you see every command.'},
  {name: 'Driver', note: ':Pair drive', text: 'Types one change into your buffer while you watch, unsaved, one undo step. Any key takes it back.'},
];

const models = [
  {title: 'A local server', text: 'llama.cpp, Ollama, vLLM, LM Studio or any OpenAI-compatible server, on your own machine. No key needed.'},
  {title: 'An API key', text: 'Any provider pi-ai supports, or an Anthropic-compatible API. <code>pair auth login</code> stores the key.'},
  {title: 'A subscription login', text: 'Where the provider allows it in other tools. <code>pair auth login</code> shows its terms before you sign in.'},
];

const install = [
  {title: 'Install the daemon', lang: 'sh', code: 'npm install -g github:makefunstuff/pairing-buddy\npair setup', text: '<code>pair setup</code> writes the config, offers a login and starts the daemon as a user service.'},
  {title: 'Add the Neovim plugin', lang: 'lua', code: "{\n  'makefunstuff/pairing-buddy',\n  main = 'pair',\n  lazy = false,\n  opts = {auto_connect = true},\n}", text: 'With lazy.nvim. Set your model in <code>~/.config/pairing-buddy/config.json</code>.'},
  {title: 'Check it, and pair', lang: 'sh', code: 'pair doctor', text: 'One line per part, with the fix when something is wrong. Then run <code>pair</code> next to Neovim in herdr, or <code>:Pair chat</code> in Neovim.'},
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

// The moment clips: nothing downloads until one is near the screen; each plays while in view, unless you paused
// it or ask for less motion.
const loops = ref([]);
const paused = ref({});
let near, seen;
function load(v) {
  if (v.dataset.loaded) return;
  v.dataset.loaded = '1';
  for (const s of v.querySelectorAll('source[data-src]')) s.src = s.dataset.src;
  v.load();
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
  }, {threshold: 0.5});
  for (const v of loops.value) { near.observe(v); seen.observe(v); }
  if (reduce) paused.value = Object.fromEntries(loops.value.map((v, i) => [i, true]));
});
onBeforeUnmount(() => { near?.disconnect(); seen?.disconnect(); });
</script>

<template>
  <div class="landing">
    <section class="wrap hero">
      <p class="eyebrow">A Neovim plugin and a daemon · local or cloud models · MIT</p>
      <h1>A pair programmer that knows when to speak<span class="dot">.</span></h1>
      <p class="lede">pairing-buddy, or Pair, works next to you like a colleague in the second chair: it watches you code in Neovim, says one short line under your cursor when it spots something, runs the tests you would skip, and takes the keyboard only when you hand it over.</p>
      <p class="lede">It is not code completion and not a chat sidebar. And it never writes your files: its edits land unsaved, as one undo step.</p>
      <div class="cta">
        <a class="btn primary" :href="withBase('/getting-started.html')">Get started</a>
        <a class="btn" href="#tour">Watch the 6-minute tour</a>
        <a class="btn" href="https://github.com/makefunstuff/pairing-buddy">GitHub</a>
      </div>
    </section>

    <section class="wrap wide" id="tour" aria-label="The tour">
      <div class="stage">
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
    </section>

    <section class="wrap wide" aria-labelledby="moments-h">
      <h2 id="moments-h">Three moments where a second person saves you time</h2>
      <p class="sub">Recorded from the shipped plugin and daemon on a small Go service; only the model's words are scripted.</p>
      <article v-for="(m, i) in moments" :key="m.id" class="moment">
        <div class="moment-text">
          <span class="num">0{{ i + 1 }}</span>
          <h3>{{ m.title }}</h3>
          <p v-html="m.text"></p>
        </div>
        <div class="stage loop">
          <video :ref="el => (loops[i] = el)" muted loop playsinline preload="none" :poster="media(m.poster)" width="1280" height="768"
            :aria-label="m.label" @click="toggle(i)">
            <source :data-src="media(`${m.id}.webm`)" type="video/webm">
            <source :data-src="media(`${m.id}.mp4`)" type="video/mp4">
          </video>
          <button class="playpause" type="button" @click="toggle(i)" :aria-label="paused[i] ? 'Play the clip' : 'Pause the clip'">{{ paused[i] ? '▶' : '❚❚' }}</button>
        </div>
      </article>
    </section>

    <section class="wrap" aria-labelledby="how-h">
      <h2 id="how-h">How it works</h2>
      <ol class="steps">
        <li v-for="s in steps" :key="s.title">
          <h3>{{ s.title }}</h3>
          <p v-html="s.text"></p>
        </li>
      </ol>
      <div class="roles">
        <div v-for="r in roles" :key="r.name" class="card">
          <h3>{{ r.name }} <span>{{ r.note }}</span></h3>
          <p v-html="r.text"></p>
        </div>
      </div>
      <p class="more"><a :href="withBase('/roles.html')">Roles in detail</a> · <a :href="withBase('/how-it-works.html')">How it works</a></p>
    </section>

    <section class="wrap" aria-labelledby="models-h">
      <h2 id="models-h">Runs on your models</h2>
      <p class="sub">One model can do both jobs, or give each its own: keep the Watcher small and fast, local or pay-per-use.</p>
      <div class="cards">
        <div v-for="m in models" :key="m.title" class="card">
          <h3>{{ m.title }}</h3>
          <p v-html="m.text"></p>
        </div>
      </div>
      <p class="more"><a :href="withBase('/models.html')">Models and providers</a> · <a :href="withBase('/config.html')">Configuration reference</a></p>
    </section>

    <section class="wrap" id="install" aria-labelledby="install-h">
      <h2 id="install-h">Install</h2>
      <p class="sub">Needs Node.js 22.19+ and Neovim 0.11+. <a href="https://herdr.dev">herdr</a> is its best home; without it, everything runs inside Neovim.</p>
      <ol class="install">
        <li v-for="(s, i) in install" :key="s.title">
          <h3>{{ s.title }}</h3>
          <div class="code">
            <button class="copy" type="button" @click="copy(i)">{{ copied === i ? 'copied' : 'copy' }}</button>
            <pre><code>{{ s.code }}</code></pre>
          </div>
          <p v-html="s.text"></p>
        </li>
      </ol>
      <p class="more"><a class="btn primary" :href="withBase('/getting-started.html')">Read the getting started guide</a></p>
    </section>
  </div>
</template>

<style scoped>
.landing { padding: 0 16px 96px; }
.wrap { max-width: 760px; margin: 0 auto; }
.wrap.wide { max-width: 1120px; }
section { padding-top: 88px; }
section.hero { padding-top: 72px; }

.eyebrow { font: 400 13px/1.4 var(--vp-font-family-mono); letter-spacing: .04em; color: var(--vp-c-text-2); margin: 0 0 18px; }
h1 { font-size: clamp(38px, 6.4vw, 64px); line-height: 1.04; font-weight: 800; letter-spacing: -.035em; margin: 0 0 24px; text-wrap: balance; color: var(--vp-c-text-1); }
h1 .dot { color: var(--vp-c-brand-1); }
.lede { font-size: clamp(18px, 2.1vw, 20px); line-height: 1.6; color: var(--vp-c-text-1); margin: 0 0 14px; max-width: 36em; }
.lede + .lede { color: var(--vp-c-text-2); }
.cta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
.btn { display: inline-flex; align-items: center; font: 700 15px/1 var(--vp-font-family-base); padding: 14px 20px; border-radius: 10px; text-decoration: none; border: 1px solid var(--vp-c-border); color: var(--vp-c-text-1); transition: border-color .2s; }
.btn:hover { border-color: var(--vp-c-brand-1); }
.btn.primary { background: var(--vp-c-brand-3); border-color: var(--vp-c-brand-3); color: var(--vp-button-brand-text); }

h2 { font-size: clamp(28px, 4vw, 38px); line-height: 1.12; font-weight: 800; letter-spacing: -.025em; margin: 0 0 12px; text-wrap: balance; color: var(--vp-c-text-1); }
h3 { font-size: 20px; line-height: 1.3; font-weight: 700; letter-spacing: -.01em; margin: 0 0 6px; color: var(--vp-c-text-1); }
p { margin: 0; line-height: 1.65; color: var(--vp-c-text-2); }
.sub { font-size: 17px; max-width: 36em; margin-bottom: 8px; }
.more { margin-top: 28px; font-size: 16px; }
.more a:not(.btn) { color: var(--vp-c-brand-1); font-weight: 700; text-underline-offset: .2em; }
a { color: var(--vp-c-brand-1); }

.stage { position: relative; background: var(--pair-bezel); border-radius: 14px; padding: clamp(4px, 1vw, 10px); box-shadow: 0 30px 80px -50px rgba(0, 0, 0, .7); }
.stage video { display: block; width: 100%; height: auto; border-radius: 8px; background: #0B0F13; }
#tour video { aspect-ratio: 16 / 9; }
.loop video { aspect-ratio: 1280 / 768; cursor: pointer; }
.chapters { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.chip { font: 400 13.5px/1.3 var(--vp-font-family-mono); color: var(--vp-c-text-2); background: transparent; border: 1px solid var(--vp-c-border); border-radius: 999px; padding: 8px 13px; cursor: pointer; }
.chip b { color: var(--vp-c-brand-1); font-weight: 400; margin-right: 8px; }
.chip:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-text-1); }
.playpause { position: absolute; right: 18px; bottom: 18px; width: 36px; height: 36px; border-radius: 50%; border: 0; background: rgba(11, 15, 19, .72); color: #E6E1CF; font-size: 12px; cursor: pointer; }

.moment { margin-top: 56px; display: grid; gap: 20px; }
@media (min-width: 960px) {
  .moment { grid-template-columns: minmax(0, 300px) minmax(0, 1fr); gap: 40px; align-items: center; margin-top: 64px; }
}
.moment-text { max-width: 38em; }
.num { display: block; font: 400 13px/1 var(--vp-font-family-mono); color: var(--vp-c-brand-1); margin-bottom: 10px; }
.moment p { font-size: 17px; }

.steps, .install { list-style: none; padding: 0; margin: 32px 0 0; counter-reset: s; display: grid; grid-template-columns: minmax(0, 1fr); gap: 28px; }
.steps li, .install li { counter-increment: s; position: relative; padding-left: 52px; }
.steps li::before, .install li::before { content: counter(s); position: absolute; left: 0; top: -2px; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font: 700 15px/1 var(--vp-font-family-mono); color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
.steps p, .install p { font-size: 16.5px; }
.roles, .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 22px; }
.roles { margin-left: 52px; }
.card { border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg-soft); border-radius: 12px; padding: 18px 18px 20px; }
.card h3 { font-size: 18px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.card h3 span { font: 400 12.5px/1 var(--vp-font-family-mono); color: var(--vp-c-text-2); }
.card p { font-size: 15.5px; }

.code { position: relative; background: #0F1419; border-radius: 10px; margin: 12px 0 10px; color: #CBCCC6; }
.code pre { margin: 0; padding: 16px 64px 16px 18px; overflow-x: auto; font: 400 14px/1.65 var(--vp-font-family-mono); }
.code code { background: none; padding: 0; color: inherit; font-size: inherit; }
.copy { position: absolute; top: 8px; right: 8px; font: 400 12px/1 var(--vp-font-family-mono); color: #AEB6BF; background: #121820; border: 1px solid #2A3540; border-radius: 6px; padding: 7px 9px; cursor: pointer; }
.copy:hover { color: #E6E1CF; }
p :deep(code) { font-family: var(--vp-font-family-mono); font-size: .86em; color: var(--vp-code-color); background: var(--vp-code-bg); padding: .1em .35em; border-radius: 4px; overflow-wrap: anywhere; }

@media (max-width: 760px) {
  section { padding-top: 64px; }
  section.hero { padding-top: 40px; }
  .roles, .cards { grid-template-columns: minmax(0, 1fr); }
  .roles { margin-left: 0; }
  .steps li, .install li { padding-left: 46px; }
  .btn { flex: 1 1 auto; justify-content: center; }
  .playpause { right: 12px; bottom: 12px; }
}
</style>
