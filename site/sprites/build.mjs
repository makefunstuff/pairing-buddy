// The site's pixel-art sprites: the five parts of Pair, the three ways to get a model, the three install steps, the
// mascot and the favicon. Each is drawn below as a grid of palette letters ('.' is empty); the black outline is added
// here, around every filled pixel, so the grids hold only the fills. Writes site/public/sprites/*.svg and
// site/public/favicon.svg.
// Usage, in site/: npm run sprites
import {mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// The site's 16 colours (site/.vitepress/theme/tokens.css), by letter.
const PALETTE = {
  0: '#000000', 1: '#1D2B53', 2: '#7E2553', 3: '#008751', 4: '#AB5236', 5: '#5F574F', 6: '#C2C3C7', 7: '#FFF1E8',
  8: '#FF004D', 9: '#FFA300', a: '#FFEC27', b: '#00E436', c: '#29ADFF', d: '#83769C', e: '#FF77A8', f: '#FFCCAA',
};
const OUTLINE = '0';

const SPRITES = {
  // the parts of Pair
  watcher: [ // an eye that never blinks
    '.....777777.....',
    '...7779999777...',
    '..777990099777..',
    '.77779700997777.',
    '.77779900997777.',
    '..777999999777..',
    '...7779999777...',
    '.....777777.....',
  ],
  partner: [ // it speaks: a speech bubble
    '..eeeeeeeeeeee..',
    '.eeeeeeeeeeeeee.',
    '.ee00ee00ee00ee.',
    '.ee00ee00ee00ee.',
    '.eeeeeeeeeeeeee.',
    '..eeeeeeeeeeee..',
    '...eee..........',
    '...ee...........',
    '...e............',
  ],
  navigator: [ // a pin on the line it means
    '...cccccc...',
    '..cccccccc..',
    '.cccccccccc.',
    '.cccc77cccc.',
    '.ccc7777ccc.',
    '.ccc7777ccc.',
    '.cccc77cccc.',
    '..cccccccc..',
    '..cccccccc..',
    '...cccccc...',
    '....cccc....',
    '.....cc.....',
  ],
  scout: [ // it searches and runs things
    '...bbbbbb.......',
    '..bb7777bb......',
    '.bb777777bb.....',
    '.b77777777b.....',
    '.b77777777b.....',
    '.b77777767b.....',
    '.bb777766bb.....',
    '..bb7777bb......',
    '...bbbbbb44.....',
    '.........444....',
    '..........444...',
    '...........444..',
    '............44..',
  ],
  driver: [ // it takes the wheel
    '.....888888.....',
    '...8888888888...',
    '..888......888..',
    '.88..........88.',
    '.88..........88.',
    '88............88',
    '8888888668888888',
    '8888886666888888',
    '88.....66.....88',
    '.88....88....88.',
    '.88....88....88.',
    '..888..88..888..',
    '...8888888888...',
    '.....888888.....',
  ],
  // the three ways to get a model
  local: [ // a server on your machine
    '66666666666666',
    '61111111111116',
    '61bbbb11111116',
    '61111111111116',
    '61bb1bbbbb1116',
    '61111111111116',
    '61bbbbbba11116',
    '61111111111116',
    '66666666666666',
    '.....6666.....',
    '...66666666...',
  ],
  key: [ // an API key
    '..aaaa..........',
    '.aaaaaa.........',
    'aaa..aaaaaaaaaaa',
    'aaa..aaaaaaaaaaa',
    '.aaaaaa....aa.aa',
    '..aaaa.....aa...',
  ],
  login: [ // a subscription: you, signed in
    '.444444.',
    '44444444',
    'ff0ff0ff',
    'ffffffff',
    'fff00fff',
    '.ffffff.',
    '........',
    'dddddddd',
    'dddddddd',
    'dddddddd',
  ].map(r => `...${r}...`),
  // the install steps
  daemon: [ // npm install: a package
    '99999aaaa99999',
    '99999aaaa99999',
    '00000000000000',
    '44444aaaa44444',
    '44444aaaa44444',
    '44444444444444',
    '44777777444444',
    '44777777444444',
    '44444444444444',
  ],
  plugin: [ // the Neovim plugin: a puzzle piece
    '....eeee......',
    '....eeee......',
    'eeeeeeeeeeee..',
    'eeeeeeeeeeee..',
    'eeeeeeeeeeee..',
    '..eeeeeeeeeeee',
    '..eeeeeeeeeeee',
    '..eeeeeeeeeeee',
    'eeeeeeeeeeee..',
    'eeeeeeeeeeee..',
    '222222222222..',
  ],
  doctor: [ // pair doctor: all green
    '...........bbb',
    '..........bbb.',
    '.........bbb..',
    'bbb.....bbb...',
    '.bbb...bbb....',
    '..bbb.bbb.....',
    '...bbbbb......',
    '....bbb.......',
  ],
  // Pair itself, with something to say
  mascot: overlay([ // a robot in a CRT...
    '...........ee...........',
    '...........ee...........',
    '...........66...........',
    '....6666666666666666....',
    '....6111111111111116....',
    '....611bb111111bb116....',
    '....611bb111111bb116....',
    '....6111111111111116....',
    '....61111bbbbbb11116....',
    '....6111111111111116....',
    '....6666666666666666....',
    '..........6666..........',
    '......dddddddddddd......',
    '...dd.dddddddddddd.dd...',
    '...dd.ddd8d9dadddd.dd...',
    '...dd.dddddddddddd.dd...',
    '...66.dddddddddddd.66...',
    '......dddddddddddd......',
    '.......555....555.......',
    '.......555....555.......',
    '......5555....5555......',
  ], [ // ...with one short thing to say
    '.777777777777.',
    '77777777777777',
    '77777700777777',
    '77777700777777',
    '77777700777777',
    '77777777777777',
    '77777700777777',
    '.777777777777.',
    '.777..........',
    '77............',
  ], 22, 0),
  // the favicon and the logo: Pair's head
  head: [
    '......ee......',
    '......66......',
    '66666666666666',
    '61111111111116',
    '61bb111111bb16',
    '61bb111111bb16',
    '61111111111116',
    '6111bbbbbb1116',
    '61111111111116',
    '66666666666666',
  ],
};

/** `top` laid over `base` with its top left corner at x, y; the result is as wide and tall as both need. */
function overlay(base, top, x, y) {
  const w = Math.max(base[0].length, x + top[0].length), h = Math.max(base.length, y + top.length);
  return Array.from({length: h}, (_, j) => Array.from({length: w}, (_, i) => {
    const t = top[j - y]?.[i - x];
    return t && t !== '.' ? t : base[j]?.[i] ?? '.';
  }).join(''));
}

/** The grid as an SVG: outlined, and centred on a square canvas (the mascot keeps its own size), at 4 screen pixels per pixel. */
function sprite(name, rows) {
  const w = rows[0].length;
  rows.forEach((r, i) => { if (r.length !== w) throw new Error(`${name}: row ${i} is ${r.length} wide, not ${w}`); });
  const at = (x, y) => (rows[y]?.[x] ?? '.');
  // the outline: every empty pixel next to a filled one (four neighbours) turns black
  const W = w + 2, H = rows.length + 2;
  const px = [];
  for (let y = 0; y < H; y++) {
    px.push([]);
    for (let x = 0; x < W; x++) {
      const c = at(x - 1, y - 1);
      if (c !== '.') px[y].push(c);
      else px[y].push([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => at(x - 1 + dx, y - 1 + dy) !== '.') ? OUTLINE : '.');
    }
  }
  const size = Math.max(W, H);
  const ox = Math.floor((size - W) / 2), oy = Math.floor((size - H) / 2);
  const vw = name === 'mascot' ? W : size, vh = name === 'mascot' ? H : size;
  const dx = name === 'mascot' ? 0 : ox, dy = name === 'mascot' ? 0 : oy;
  // one <path> per colour, each pixel run on a row as one rectangle
  const runs = {};
  px.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const c = row[x];
      let n = 1;
      while (row[x + n] === c) n++;
      if (c !== '.') (runs[c] ??= []).push(`M${x + dx} ${y + dy}h${n}v1h-${n}z`);
      x += n;
    }
  });
  const paths = Object.entries(runs).map(([c, d]) => {
    if (!PALETTE[c]) throw new Error(`${name}: no colour ${c}`);
    return `<path fill="${PALETTE[c]}" d="${d.join('')}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw * 4}" height="${vh * 4}" shape-rendering="crispEdges">${paths}</svg>\n`;
}

const site = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(`${site}public/sprites`, {recursive: true});
for (const [name, rows] of Object.entries(SPRITES)) {
  const svg = sprite(name, rows);
  writeFileSync(name === 'head' ? `${site}public/favicon.svg` : `${site}public/sprites/${name}.svg`, svg);
}
console.log(`${Object.keys(SPRITES).length} sprites`);
