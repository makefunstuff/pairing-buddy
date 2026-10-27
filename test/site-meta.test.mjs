// The site's link previews: each page's description from its Markdown, its tags, and the check that the built pages
// carry them all (site/check-meta.mjs, which the Pages workflow runs on the real build).
import assert from 'node:assert/strict';
import {copyFileSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {checkPage, checkSite} from '../site/check-meta.mjs';
import {DESCRIPTION, describe, IMAGE, MAX_DESCRIPTION, pageHead, pageUrl, SITE_URL} from '../site/.vitepress/meta.mjs';
import {scratch} from './temp.mjs';

const docs = new URL('../docs/', import.meta.url);
const pub = new URL('../site/public/', import.meta.url);

test('a description is the first paragraph of prose, as plain text', () => {
  assert.equal(describe('# Title\n\nPair reads `foo.go` and [the docs](x.md), **once**.\nThen it stops.\n\nMore.\n'),
    'Pair reads foo.go and the docs, once. Then it stops.');
  // not a code block, list, table, heading, HTML or a list item's indented line
  assert.equal(describe('# T\n\n```\ncode\n```\n\n- a list\n  (more of it)\n\n| a | b |\n\n## H\n\n<!-- a note -->\n<Landing />\n\nThe prose.\n'), 'The prose.');
  // a paragraph that leads into a list keeps only its sentences before that
  assert.equal(describe('# T\n\nYou drive. Two things let it touch your code:\n\n- one\n'), 'You drive.');
  assert.equal(describe('---\nlayout: page\n---\n\n<Landing />\n'), '');
  // A straight double quote would end the meta tag's attribute: it becomes a curly one.
  assert.equal(describe('# T\n\nIt asks "yes or no?" and 3" more.\n'), 'It asks “yes or no?” and 3” more.');
});

test('a long description is cut at a sentence end, or at a word with …', () => {
  const long = `${'A short opening sentence that says the most. '.repeat(2)}${'word '.repeat(40)}`;
  assert.equal(describe(`# T\n\n${long}\n`), 'A short opening sentence that says the most. A short opening sentence that says the most.');
  const run = describe(`# T\n\n${'word, '.repeat(60)}\n`);
  assert.ok(run.endsWith('word…') && run.length <= MAX_DESCRIPTION + 1, run);
});

test('every docs page has a description of its own that fits the previews', () => {
  const seen = new Map();
  for (const file of readdirSync(docs).filter(f => f.endsWith('.md') && f !== 'index.md')) {
    const md = readFileSync(new URL(file, docs), 'utf8');
    const description = md.match(/^---\n[\s\S]*?^description: "(.*)"$/m)?.[1] ?? describe(md);
    assert.ok(description.length >= 40, `${file}: "${description}" is too thin for a preview`);
    assert.ok(description.length <= MAX_DESCRIPTION, `${file}: ${description.length} characters`);
    assert.ok(!seen.has(description), `${file} and ${seen.get(description)} share a description`);
    seen.set(description, file);
  }
  assert.ok(DESCRIPTION.length <= MAX_DESCRIPTION);
});

test('a page\'s URL is absolute, as the build writes it', () => {
  assert.equal(pageUrl('index.md'), SITE_URL);
  assert.equal(pageUrl('models.md'), `${SITE_URL}models.html`);
  assert.equal(pageUrl('guide/index.md'), `${SITE_URL}guide/`);
});

/** A built page as VitePress writes it: the config's head (icons, colours) and the page's own tags. */
function page(pageData, {drop = [], change = {}} = {}) {
  const tags = [
    ['link', {rel: 'icon', href: '/pairing-buddy/favicon.svg', type: 'image/svg+xml'}],
    ['link', {rel: 'icon', href: '/pairing-buddy/favicon-32.png', type: 'image/png', sizes: '32x32'}],
    ['link', {rel: 'apple-touch-icon', href: '/pairing-buddy/apple-touch-icon.png'}],
    ['link', {rel: 'manifest', href: '/pairing-buddy/site.webmanifest'}],
    ['meta', {name: 'theme-color', content: '#FFF1E8', media: '(prefers-color-scheme: light)'}],
    ['meta', {name: 'theme-color', content: '#1D2B53', media: '(prefers-color-scheme: dark)'}],
    ...pageHead(pageData),
  ].filter(([, a]) => !drop.includes(a.property ?? a.name ?? a.rel))
    .map(([tag, a]) => [tag, {...a, ...(change[a.property ?? a.name ?? a.rel] ?? {})}]);
  const description = pageData.relativePath === '404.md' ? '' : `<meta name="description" content="${pageData.description || DESCRIPTION}">`;
  const html = tags.map(([tag, a]) => `<${tag}${Object.entries(a).map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`).join('')}>`).join('\n');
  return `<!DOCTYPE html><html><head><title>${pageData.title} | pairing-buddy</title>${description}\n${html}</head><body></body></html>`;
}

function dist() {
  const dir = scratch('pair-site-');
  for (const f of ['og.png', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'site.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    copyFileSync(new URL(f, pub), join(dir, f));
  }
  return dir;
}

const models = {relativePath: 'models.md', title: 'Models and providers', description: 'Pair asks two models: a fast Watcher and a Partner.'};

test('the check passes a site whose every page has the full set', () => {
  const dir = dist();
  writeFileSync(join(dir, 'index.html'), page({relativePath: 'index.md', title: 'pairing-buddy', description: ''}));
  writeFileSync(join(dir, 'models.html'), page(models));
  writeFileSync(join(dir, '404.html'), page({relativePath: '404.md', title: '404', description: ''}));
  assert.deepEqual(checkSite(dir), []);
});

test('the check names each missing, relative or wrong tag', () => {
  const dir = dist();
  const problems = (opts, data = models) => checkPage(dir, 'models.html', page(data, opts));
  assert.deepEqual(problems({drop: ['og:image:alt', 'twitter:title']}), ['models.html: no og:image:alt', 'models.html: no twitter:title', 'models.html: og:title and twitter:title differ']);
  assert.deepEqual(problems({change: {'og:image': {content: '/pairing-buddy/og.png'}, 'twitter:image': {content: '/pairing-buddy/og.png'}}}),
    ['models.html: og:image is not an absolute URL: /pairing-buddy/og.png', 'models.html: twitter:image is not an absolute URL: /pairing-buddy/og.png']);
  assert.deepEqual(problems({change: {'og:image:height': {content: '600'}}}), ['models.html: og:image is 1200x630, the tags say 1200x600']);
  assert.deepEqual(problems({drop: ['canonical', 'theme-color']}), ['models.html: no canonical link', 'models.html: no theme-color for light', 'models.html: no theme-color for dark']);
  assert.deepEqual(problems({}, {...models, description: ''}), ['models.html: has the front page\'s description, not its own']);
  assert.deepEqual(problems({change: {'og:image': {content: `${SITE_URL}og.jpg`}, 'twitter:image': {content: `${SITE_URL}og.jpg`}}}),
    [`models.html: og:image names ${SITE_URL}og.jpg, which is not in the build`]);
  assert.match(problems({}, {...models, description: 'x'.repeat(MAX_DESCRIPTION + 1)})[0], /description is 156 characters/);
});

test('the preview image is the size its tags say', () => {
  const png = readFileSync(new URL('og.png', pub));
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [IMAGE.width, IMAGE.height]);
  assert.equal(IMAGE.url, `${SITE_URL}og.png`);
});
