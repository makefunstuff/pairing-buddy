// The site: the front page (docs/index.md, the Landing component) and the docs, built from the Markdown in docs/.
// Usage, in site/: npm ci, then npm run dev (a local preview) or npm run build (to .vitepress/dist).
import {dirname, posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitepress';

const REPO = 'https://github.com/makefunstuff/pairing-buddy';
// Folders of docs/ that hold tapes, scripts and renders rather than pages; links into them go to GitHub.
const NOT_PAGES = ['video/**', 'captures/**'];

/**
 * A link in a doc to a file that is not a page (a tape, a script, ../README.md) points at the file on GitHub, so the
 * Markdown reads the same on GitHub and on the site.
 */
function repoLinks(md) {
  const open = md.renderer.rules.link_open ?? ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
  md.renderer.rules.link_open = (tokens, i, options, env, self) => {
    const href = tokens[i].attrGet('href');
    if (href && !/^([a-z]+:|#|\/)/i.test(href)) {
      const [path, hash = ''] = href.split('#');
      const file = posix.normalize(posix.join('docs', dirname(env.relativePath), path));
      const page = file.endsWith('.md') && file.startsWith('docs/') && !/^docs\/(video|captures)\//.test(file);
      if (!page) tokens[i].attrSet('href', `${REPO}/${path.endsWith('/') || !posix.extname(file) ? 'tree' : 'blob'}/main/${file}${hash ? `#${hash}` : ''}`);
    }
    return open(tokens, i, options, env, self);
  };
}

// Heading anchors as GitHub makes them (no "day-s-end" for "day's end"), so a link to one works in both places.
const githubSlug = text => text.trim().toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');

export default defineConfig({
  title: 'pairing-buddy',
  description: 'A pair programmer for Neovim: it watches, speaks when it matters, runs what you would skip, and types only when you hand it the keyboard.',
  lang: 'en',
  base: '/pairing-buddy/',
  srcDir: '../docs',
  srcExclude: NOT_PAGES,
  cleanUrls: false,
  lastUpdated: false,
  head: [
    ['link', {rel: 'icon', href: '/pairing-buddy/favicon.svg', type: 'image/svg+xml'}],
    ['link', {rel: 'preload', href: '/pairing-buddy/fonts/inter-500.woff2', as: 'font', type: 'font/woff2', crossorigin: ''}],
    ['meta', {property: 'og:title', content: 'pairing-buddy: a pair programmer for Neovim'}],
    ['meta', {property: 'og:description', content: 'Not completion, not a chat sidebar: a pair that watches, speaks when it matters and types only when you hand over.'}],
    ['meta', {property: 'og:image', content: 'https://makefunstuff.github.io/pairing-buddy/media/og.jpg'}],
    ['meta', {property: 'og:type', content: 'website'}],
    ['meta', {name: 'twitter:card', content: 'summary_large_image'}],
  ],
  markdown: {
    config: repoLinks,
    image: {lazyLoading: true},
    anchor: {slugify: githubSlug},
    theme: {light: 'ayu-dark', dark: 'ayu-dark'}, // code is dark in both, like the terminal it comes from
  },
  vite: {
    // The site's own files (the videos, fonts, favicon) live next to the config, not among the docs.
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    server: {fs: {allow: [fileURLToPath(new URL('../..', import.meta.url))]}},
    // The pages are compiled from docs/, which has no node_modules: their imports resolve from here.
    resolve: {alias: {vue: fileURLToPath(new URL('../node_modules/vue', import.meta.url))}},
  },
  themeConfig: {
    logo: {src: '/favicon.svg', alt: ''},
    nav: [
      {text: 'Get started', link: '/getting-started'},
      {text: 'Docs', link: '/how-it-works', activeMatch: '^/(?!$|getting-started)'},
      {text: 'v0.9', items: [
        {text: 'Known limitations', link: '/limitations'},
        {text: 'Issues', link: `${REPO}/issues`},
      ]},
    ],
    sidebar: [
      {text: 'Start here', items: [
        {text: 'Getting started', link: '/getting-started'},
        {text: 'Install and daily use', link: '/install'},
        {text: 'How it works', link: '/how-it-works'},
      ]},
      {text: 'Models', items: [
        {text: 'Models and providers', link: '/models'},
        {text: 'The Watcher', link: '/watcher'},
      ]},
      {text: 'Roles', items: [
        {text: 'Roles at a glance', link: '/roles'},
        {text: 'Scout', link: '/scout'},
        {text: 'Driver and suggestions', link: '/driver'},
      ]},
      {text: 'Workflows', items: [
        {text: 'Workflows at a glance', link: '/workflows'},
        {text: 'The pair in Neovim', link: '/neovim'},
        {text: 'The exploration loop', link: '/exploration'},
        {text: 'Builds and crashes', link: '/builds'},
        {text: 'Tests on save', link: '/tests-on-save'},
        {text: 'Notes in the margin', link: '/notes'},
        {text: 'The blank page', link: '/blank-page'},
        {text: 'Push-to-talk', link: '/voice'},
        {text: 'Your other agents', link: '/agents'},
        {text: 'Memory and feedback', link: '/memory'},
        {text: 'Tone', link: '/tone'},
      ]},
      {text: 'Reference', items: [
        {text: 'Configuration', link: '/config'},
        {text: 'Neovim plugin', link: '/neovim-plugin'},
        {text: 'Commands', link: '/cli'},
      ]},
      {text: 'Help', items: [
        {text: 'Troubleshooting', link: '/troubleshooting'},
        {text: 'Known limitations', link: '/limitations'},
        {text: 'Data and privacy', link: '/data'},
        {text: 'What Pair gets from herdr', link: '/herdr'},
        {text: 'Tests', link: '/testing'},
      ]},
    ],
    outline: {level: [2, 3], label: 'On this page'},
    search: {provider: 'local'},
    socialLinks: [{icon: 'github', link: REPO}],
    editLink: {pattern: `${REPO}/edit/main/docs/:path`, text: 'Edit this page on GitHub'},
    docFooter: {prev: 'Previous', next: 'Next'},
    footer: {message: 'MIT licensed. The captures show the shipped plugin and daemon, with scripted model words.'},
  },
});
