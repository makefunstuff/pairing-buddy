// What a link to the site shows when it is shared (X, Slack, Discord, Telegram, LinkedIn, iMessage) and in search
// results: each page's title, description, canonical URL and the preview image. config.mjs puts these tags in every
// page's head; ../check-meta.mjs checks the built pages carry them all.

export const SITE_URL = 'https://makefunstuff.github.io/pairing-buddy/';
export const SITE_NAME = 'pairing-buddy';
// The front page's title and description; the description is also the site's, and the fallback of a page without one.
export const HOME_TITLE = 'pairing-buddy: a pair programmer for Neovim';
export const DESCRIPTION = 'Pair watches you code in Neovim, says one short line when something matters, and types only when you hand it the keyboard. Local or cloud models.';
// The preview image (site/og/card.html, drawn by site/og/build.mjs)
export const IMAGE = {
  url: `${SITE_URL}og.png`, width: 1200, height: 630, type: 'image/png',
  alt: 'pairing-buddy: a pair programmer for Neovim that knows when to speak. A pixel-art robot beside a Neovim window, pointing out the real cause of a bug.',
};
// The longest description the previews show whole: Google cuts at about 155 characters, Slack and X near 200.
export const MAX_DESCRIPTION = 155;

/**
 * A page's description from its Markdown: the first paragraph of prose after the title (not a heading, list, table,
 * code block, HTML or indented line), as plain text, cut at a sentence end (or a word, with …) to fit MAX_DESCRIPTION. A paragraph
 * that ends with a colon introduces a list, so only its sentences before that one count.
 */
export function describe(markdown) {
  const lines = markdown.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let fence = false, para = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    // an indented line goes on a list item; prose here starts at the margin
    const prose = /^[^\s#|<>]/.test(line) && !/^([-*+] |\d+\. |!\[)/.test(line);
    if (prose) para.push(line.trim());
    else if (para.length) break;
  }
  let text = plain(para.join(' '));
  if (text.endsWith(':')) text = text.replace(/[^.!?]*:$/, '').trim();
  return text ? fit(text, MAX_DESCRIPTION) : '';
}

/** Markdown inline syntax to plain text: links and images to their text, no code ticks, emphasis or tags. */
function plain(md) {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_](\S.*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The text cut to at most `max` characters: at the last sentence end that keeps at least half of it, else at a word, with …. */
function fit(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const end = Math.max(...[...head.matchAll(/[.!?](?=\s)/g)].map(m => m.index));
  if (end >= max / 2) return head.slice(0, end + 1);
  return `${head.slice(0, max).replace(/\s+\S*$/, '').replace(/[,;:]$/, '')}…`;
}

/** A page's absolute URL, as the build writes it (cleanUrls is off): index.md is the site root, x.md is x.html. */
export function pageUrl(relativePath) {
  return SITE_URL + relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html');
}

/** The title a preview shows: the front page's own, or the page's title and the site's name. */
export function previewTitle(pageData) {
  return pageData.relativePath === 'index.md' ? HOME_TITLE : `${pageData.title} | ${SITE_NAME}`;
}

/**
 * The head tags of one page: canonical link, Open Graph and X card. The 404 page, which GitHub Pages serves for any
 * missing path, is kept out of search and previews as the front page.
 */
export function pageHead(pageData) {
  if (pageData.relativePath === '404.md') {
    return [
      ['meta', {name: 'robots', content: 'noindex'}],
      ['meta', {name: 'description', content: DESCRIPTION}], // in place of VitePress's "Not Found"
      ...pageHead({...pageData, relativePath: 'index.md', description: DESCRIPTION}).slice(1),
    ];
  }
  const title = previewTitle(pageData), description = pageData.description || DESCRIPTION, url = pageUrl(pageData.relativePath);
  const og = (property, content) => ['meta', {property, content}];
  const tw = (name, content) => ['meta', {name, content}];
  return [
    ['link', {rel: 'canonical', href: url}],
    og('og:type', pageData.relativePath === 'index.md' ? 'website' : 'article'),
    og('og:site_name', SITE_NAME),
    og('og:locale', 'en_US'),
    og('og:url', url),
    og('og:title', title),
    og('og:description', description),
    og('og:image', IMAGE.url),
    og('og:image:secure_url', IMAGE.url),
    og('og:image:type', IMAGE.type),
    og('og:image:width', String(IMAGE.width)),
    og('og:image:height', String(IMAGE.height)),
    og('og:image:alt', IMAGE.alt),
    tw('twitter:card', 'summary_large_image'),
    tw('twitter:title', title),
    tw('twitter:description', description),
    tw('twitter:image', IMAGE.url),
    tw('twitter:image:alt', IMAGE.alt),
  ];
}
