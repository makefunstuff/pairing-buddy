// Checks the built site's link previews: every page carries the full set of tags (title, description, canonical
// link, Open Graph, X card, theme colours, icons) with absolute URLs, each docs page its own description, and every
// file the tags name is in the build, the preview image at the size it claims.
// Usage, in site/: npm run build, then npm run check (or node check-meta.mjs DIST)
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DESCRIPTION, MAX_DESCRIPTION, SITE_URL} from './.vitepress/meta.mjs';

const OG = ['og:type', 'og:site_name', 'og:url', 'og:title', 'og:description', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt'];
const TWITTER = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt'];
const MAX_TITLE = 70; // X and Slack cut a longer title

/** The tags of an HTML page's head, each as {tag, attrs}. */
export function headTags(html) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
  return [...head.matchAll(/<(meta|link|title)\b([^>]*)>(?:([^<]*)<\/title>)?/g)].map(([, tag, attrs, text]) => ({
    tag,
    text,
    attrs: Object.fromEntries([...attrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(([, k, v = '']) => [k, unescape(v)])),
  }));
}

const unescape = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The width and height of a PNG, from its header. */
function pngSize(file) {
  const b = readFileSync(file);
  return b.toString('ascii', 12, 16) === 'IHDR' ? {width: b.readUInt32BE(16), height: b.readUInt32BE(20)} : null;
}

/** The built file a URL of the site names, or null for a URL elsewhere. */
function local(dist, url) {
  const base = new URL(SITE_URL).pathname;
  const path = url.startsWith(SITE_URL) ? url.slice(SITE_URL.length) : url.startsWith(base) ? url.slice(base.length) : null;
  return path === null ? null : join(dist, path || 'index.html');
}

/** Every problem with one page's tags, as lines; `page` is its path in the build (models.html). */
export function checkPage(dist, page, html) {
  const tags = headTags(html), problems = [];
  const meta = key => tags.filter(t => t.tag === 'meta' && (t.attrs.property === key || t.attrs.name === key)).map(t => t.attrs.content);
  const one = key => {
    const found = meta(key);
    if (found.length !== 1) problems.push(`${found.length ? 'more than one' : 'no'} ${key}`);
    else if (!found[0].trim()) problems.push(`${key} is empty`);
    return found[0];
  };
  const absolute = (key, url) => { if (url && !url.startsWith('https://')) problems.push(`${key} is not an absolute URL: ${url}`); };
  const there = (key, url) => {
    const file = url && local(dist, url);
    if (file && !existsSync(file)) problems.push(`${key} names ${url}, which is not in the build`);
    return file;
  };

  const title = tags.find(t => t.tag === 'title')?.text;
  if (!title?.trim()) problems.push('no <title>');
  const description = one('description');
  for (const key of [...OG, ...TWITTER]) one(key);
  const notFound = page === '404.html';

  // where the page lives
  const canonical = tags.filter(t => t.tag === 'link' && t.attrs.rel === 'canonical').map(t => t.attrs.href);
  const url = meta('og:url')[0];
  absolute('og:url', url);
  if (notFound) {
    if (canonical.length) problems.push('the 404 page has a canonical link');
    if (meta('robots')[0] !== 'noindex') problems.push('the 404 page is not noindex');
  } else {
    if (canonical.length !== 1) problems.push(`${canonical.length ? 'more than one' : 'no'} canonical link`);
    absolute('canonical', canonical[0]);
    if (canonical[0] && url !== canonical[0]) problems.push(`og:url ${url} is not the canonical ${canonical[0]}`);
    const expected = SITE_URL + page.replace(/(^|\/)index\.html$/, '$1'); // a folder's index.md is the folder's URL, as meta.mjs has it
    if (canonical[0] && canonical[0] !== expected) problems.push(`canonical ${canonical[0]} is not ${expected}`);
  }

  // what the preview says
  for (const key of ['og:title', 'twitter:title']) {
    const t = meta(key)[0];
    if (t && t.length > MAX_TITLE) problems.push(`${key} is ${t.length} characters, more than ${MAX_TITLE}`);
  }
  for (const key of ['description', 'og:description', 'twitter:description']) {
    const d = meta(key)[0];
    if (d && d !== description) problems.push(`${key} differs from the description`);
    if (d && d.length > MAX_DESCRIPTION) problems.push(`${key} is ${d.length} characters, more than ${MAX_DESCRIPTION}`);
  }
  if (meta('og:title')[0] !== meta('twitter:title')[0]) problems.push('og:title and twitter:title differ');
  if (!notFound && page !== 'index.html' && description === DESCRIPTION) problems.push('has the front page\'s description, not its own');
  if (meta('twitter:card')[0] !== 'summary_large_image') problems.push('twitter:card is not summary_large_image');

  // the image
  const image = meta('og:image')[0];
  absolute('og:image', image);
  absolute('twitter:image', meta('twitter:image')[0]);
  if (image !== meta('twitter:image')[0]) problems.push('og:image and twitter:image differ');
  const file = there('og:image', image);
  if (file && existsSync(file) && file.endsWith('.png')) {
    const size = pngSize(file), w = Number(meta('og:image:width')[0]), h = Number(meta('og:image:height')[0]);
    if (!size || size.width !== w || size.height !== h) problems.push(`og:image is ${size?.width}x${size?.height}, the tags say ${w}x${h}`);
  }

  // the browser's colours and the icons
  const themes = tags.filter(t => t.tag === 'meta' && t.attrs.name === 'theme-color').map(t => t.attrs.media);
  for (const scheme of ['light', 'dark']) if (!themes.includes(`(prefers-color-scheme: ${scheme})`)) problems.push(`no theme-color for ${scheme}`);
  const links = rel => tags.filter(t => t.tag === 'link' && t.attrs.rel === rel);
  if (!links('icon').some(t => t.attrs.type === 'image/svg+xml')) problems.push('no SVG icon');
  if (!links('icon').some(t => t.attrs.type === 'image/png')) problems.push('no PNG icon');
  for (const rel of ['apple-touch-icon', 'manifest']) if (!links(rel).length) problems.push(`no ${rel}`);
  for (const t of [...links('icon'), ...links('apple-touch-icon'), ...links('manifest')]) there(t.attrs.rel, t.attrs.href);

  return problems.map(p => `${page}: ${p}`);
}

/** Every problem in a built site (the dist folder), as lines; none means it passes. */
export function checkSite(dist) {
  const pages = readdirSync(dist, {recursive: true}).filter(f => f.endsWith('.html') && !f.startsWith('assets'));
  if (!pages.length) return [`no pages in ${dist}: build the site first`];
  const problems = pages.flatMap(page => checkPage(dist, page, readFileSync(join(dist, page), 'utf8')));
  // the manifest's icons
  const manifest = join(dist, 'site.webmanifest');
  if (existsSync(manifest)) {
    for (const icon of JSON.parse(readFileSync(manifest, 'utf8')).icons ?? []) {
      const file = join(dist, icon.src);
      const size = existsSync(file) && pngSize(file);
      if (!size) problems.push(`site.webmanifest: ${icon.src} is not in the build`);
      else if (`${size.width}x${size.height}` !== icon.sizes) problems.push(`site.webmanifest: ${icon.src} is ${size.width}x${size.height}, not ${icon.sizes}`);
    }
  }
  // each docs page its own description
  const seen = new Map();
  for (const page of pages) {
    const d = headTags(readFileSync(join(dist, page), 'utf8')).find(t => t.attrs.name === 'description')?.attrs.content;
    if (d && seen.has(d) && ![page, seen.get(d)].includes('404.html')) problems.push(`${page}: same description as ${seen.get(d)}`);
    seen.set(d, page);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? fileURLToPath(new URL('.vitepress/dist', import.meta.url));
  const problems = checkSite(dist);
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log(`${readdirSync(dist, {recursive: true}).filter(f => f.endsWith('.html') && !f.startsWith('assets')).length} pages, every preview tag in place`);
}
