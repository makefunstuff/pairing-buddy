// Writes the tour's times into the site (site/index.html) from chapters.json (build.mjs writes it): the chapter
// buttons under the hero video, and the "in the tour" button of each feature card (its data-scene names the scene).
// Usage: node site.mjs   (after node build.mjs)
import {readFileSync, writeFileSync} from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const page = `${here}../../site/index.html`;
const {chapters, scenes} = JSON.parse(readFileSync(`${here}chapters.json`, 'utf8'));
const clock = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const buttons = chapters.map(c => `    <button class="beat" type="button" data-t="${c.at}"><b>${c.clock}</b>${c.title}</button>`).join('\n');
let html = readFileSync(page, 'utf8').replace(/(<!-- chapters: [^\n]*-->\n)[\s\S]*?( *<!-- \/chapters -->)/, `$1${buttons}\n$2`);
html = html.replace(/<button class="seek" type="button" data-scene="([\w-]+)" data-t="[\d.]+">▶ in the tour, [\d:]+<\/button>/g, (all, id) => {
  if (scenes[id] === undefined) throw new Error(`site: no scene ${id} in the tour`);
  return `<button class="seek" type="button" data-scene="${id}" data-t="${scenes[id]}">▶ in the tour, ${clock(scenes[id])}</button>`;
});
writeFileSync(page, html);
console.log(`site/index.html: ${chapters.length} chapters, ${Object.keys(scenes).length} scenes`);
