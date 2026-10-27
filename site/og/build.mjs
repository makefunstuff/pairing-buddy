// The link-preview image: screenshots card.html at 1200x630 into site/public/og.png with a headless Chrome or
// Chromium (CHROME names one; otherwise the first of chromium, google-chrome, chrome on the PATH). Run it after
// changing card.html, the sprites or the fonts, and commit the PNG: the site build does not draw it.
// Usage, in site/: npm run og
import {execFileSync} from 'node:child_process';
import {statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const site = fileURLToPath(new URL('..', import.meta.url));
const out = `${site}public/og.png`;

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    try { return execFileSync('which', [name], {encoding: 'utf8'}).trim(); } catch {}
  }
  throw new Error('no Chrome or Chromium found: set CHROME to one');
}

execFileSync(chrome(), [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--allow-file-access-from-files',
  '--window-size=1200,630', '--virtual-time-budget=3000', `--screenshot=${out}`, `file://${site}og/card.html`,
], {stdio: ['ignore', 'ignore', 'pipe']});
console.log(`og.png, ${Math.round(statSync(out).size / 1024)} KiB`);
