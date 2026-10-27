// Mock link previews of built pages, from their real tags: how X, Slack and Discord show a shared link, and the square
// and thumbnail crops other apps use (Telegram, WhatsApp, iMessage's small form). The mocks follow each app's layout
// closely enough to judge the image and copy, not pixel for pixel. Writes OUT/previews.png (and previews.html).
// Usage, in site/: npm run build, then node og/previews.mjs OUT [page.html ...] (default: index.html models.html)
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {headTags} from '../check-meta.mjs';
import {SITE_URL} from '../.vitepress/meta.mjs';

const site = fileURLToPath(new URL('..', import.meta.url));
const dist = `${site}.vitepress/dist/`;
const [out = '.', ...pages] = process.argv.slice(2);
if (!pages.length) pages.push('index.html', 'models.html');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function tagsOf(page) {
  const tags = headTags(readFileSync(join(dist, page), 'utf8'));
  const m = key => tags.find(t => t.tag === 'meta' && (t.attrs.property === key || t.attrs.name === key))?.attrs.content;
  // the image from the build, since the site may not be deployed yet
  const image = `file://${dist}${m('og:image').slice(SITE_URL.length)}`;
  return {page, image, site: m('og:site_name'), title: m('og:title'), description: m('og:description'), alt: m('og:image:alt'),
    xTitle: m('twitter:title'), domain: new URL(m('og:url')).host};
}

const card = p => `
<section><h2>${esc(p.page)}</h2>
  <div class="row">
    <figure class="x"><figcaption>X</figcaption>
      <div class="x-card"><div class="x-img"><img src="${p.image}" alt="${esc(p.alt)}"><span class="x-title">${esc(p.xTitle)}</span></div></div>
      <div class="x-from">From ${esc(p.domain)}</div>
    </figure>
    <figure class="slack"><figcaption>Slack</figcaption>
      <div class="slack-unfurl"><div class="slack-site"><img src="file://${dist}favicon-32.png" alt="">${esc(p.site)}</div>
        <a class="slack-title">${esc(p.title)}</a><p>${esc(p.description)}</p><img class="slack-img" src="${p.image}" alt=""></div>
    </figure>
    <figure class="discord"><figcaption>Discord</figcaption>
      <div class="discord-embed"><div class="discord-site">${esc(p.site)}</div><a class="discord-title">${esc(p.title)}</a>
        <p>${esc(p.description)}</p><img src="${p.image}" alt=""></div>
    </figure>
    <figure class="small"><figcaption>Square crop, 120px</figcaption><div class="sq"><img src="${p.image}" alt=""></div>
      <figcaption>Thumbnail, 300px</figcaption><img class="thumb" src="${p.image}" alt=""></figure>
  </div>
</section>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 24px; background: #e9e9ee; font: 15px/1.4 system-ui, sans-serif; width: 1720px; }
  h2 { font: 600 14px monospace; margin: 0 0 8px; color: #555; }
  section { margin-bottom: 28px; }
  .row { display: flex; gap: 24px; align-items: flex-start; }
  figure { margin: 0; } figcaption { font: 600 12px system-ui; color: #666; text-transform: uppercase; margin: 0 0 6px; letter-spacing: .05em; }
  /* X, dark: the image with the title over it, the domain below */
  .x { background: #000; padding: 14px; border-radius: 12px; width: 506px; } .x figcaption { color: #888; }
  .x-card { border: 1px solid #2f3336; border-radius: 16px; overflow: hidden; }
  .x-img { position: relative; aspect-ratio: 1.91; } .x-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .x-title { position: absolute; left: 12px; bottom: 12px; max-width: calc(100% - 24px); background: rgba(0,0,0,.77); color: #fff; font-size: 13px;
    padding: 0 6px; border-radius: 4px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .x-from { color: #71767b; font-size: 13px; margin-top: 4px; }
  /* Slack, light */
  .slack { background: #fff; padding: 14px; border-radius: 8px; width: 440px; }
  .slack-unfurl { border-left: 4px solid #ddd; padding-left: 12px; font-size: 15px; color: #1d1c1d; }
  .slack-site { display: flex; gap: 6px; align-items: center; font-weight: 700; font-size: 14px; } .slack-site img { width: 16px; height: 16px; image-rendering: pixelated; }
  .slack-title { display: block; color: #1264a3; font-weight: 700; margin-top: 2px; } .slack p { margin: 2px 0 8px; }
  .slack-img { width: 360px; border-radius: 8px; display: block; }
  /* Discord, dark */
  .discord { background: #313338; padding: 14px; border-radius: 8px; width: 460px; } .discord figcaption { color: #b5bac1; }
  .discord-embed { background: #2b2d31; border-left: 4px solid #1e1f22; border-radius: 4px; padding: 10px 14px 14px; color: #dbdee1; font-size: 14px; }
  .discord-site { font-size: 12px; color: #b5bac1; } .discord-title { display: block; color: #00a8fc; font-weight: 600; font-size: 16px; margin: 6px 0; }
  .discord p { margin: 0 0 12px; } .discord img { width: 400px; border-radius: 4px; display: block; }
  /* the crops */
  .small { background: #fff; padding: 14px; border-radius: 8px; }
  .sq { width: 120px; height: 120px; overflow: hidden; border-radius: 8px; margin-bottom: 14px; }
  .sq img { height: 120px; margin-left: -54px; } .thumb { width: 300px; display: block; border-radius: 6px; }
</style></head><body>${pages.map(tagsOf).map(card).join('')}</body></html>`;

mkdirSync(out, {recursive: true});
const file = resolve(out, 'previews.html');
writeFileSync(file, html);
execFileSync(process.env.CHROME || 'chromium', ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--allow-file-access-from-files', `--window-size=1770,${80 + pages.length * 560}`, '--virtual-time-budget=2000',
  `--screenshot=${resolve(out, 'previews.png')}`, `file://${file}`], {stdio: ['ignore', 'ignore', 'pipe']});
console.log(resolve(out, 'previews.png'));
