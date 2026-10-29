// What the full-screen chat pane draws, from its state: the header in the top rule (where you pair, on what, in
// which role and at which level), the conversation, the status in the rule under it (what Pair does now), what you
// type, and a line of the keys that work now: four rows of chrome. Each message has a 7-column gutter with who speaks:
// you, pair (answers, and the questions Pair asks you), watch (what Pair said unasked), gen (what a /gen request made,
// as a card with its keys, and what it asks), ·· (notes of the pane and the daemon), ! (errors); what Pair's tools did
// is a └ line under the question. The time is a divider, ── 21:19 ──, at
// the start and after a pause; in a wide pane the words end by column 80, and an answer's time, duration and tokens
// sit in the margin to its right. Pair's words are Markdown: code blocks, `code`, **bold**, lists and headings show
// as such, a suggestion as a diff. Code wraps between its tokens, never inside a name or a flag.
// Colour has one job each: yellow is the Watcher (its label, a remark's kind) and the ? of a question waiting for
// you; magenta is /gen (its label, its request in the status); dim is chrome only (rules, times, key descriptions, tool traces), never words addressed to you.
// Everything here is pure: lines of segments in, lines of segments out (see chat-style.mjs), so it is tested as text.
import {clipLine, fitText, lineWidth, paintLine, textWidth} from './chat-style.mjs';

const seg = (text, style = 'text') => ({text, style});
const blank = () => [];

const LABELS = {you: 'you', pair: 'pair', watch: 'watch', gen: 'gen', system: '··', error: '!', confirm: 'pair', note: '··'};
const LABEL_STYLES = {you: 'you', pair: 'pair', watch: 'watch', gen: 'gen', system: 'dim', error: 'errorBold', confirm: 'pair', note: 'dim'};
/** Who speaks `entry` in the gutter: a /gen request's question is the gen speaker's. */
const speaker = entry => (entry.kind === 'confirm' && entry.gen ? 'gen' : entry.kind);
const NARROW = 52; // below this, the header drops the goal and the footer its long words
const GUTTER = 7; // the selection bar, the name in five, a space
const MEASURE = 80; // in a wider pane the words end by this column; code and diffs may run on
const PAUSE_MS = 5 * 60_000; // a pause this long brings the time back, as a divider
const FOLD_OVER = 18; // a longer message folds to its start…
const FOLD_TO = 12; // …this long
const SPINNER = ['▖', '▘', '▝', '▗'];

/** What a tool did, in the past (the └ line) and as it runs (the status row). Point and suggest show as messages. */
const DONE = {read: 'read', search: 'searched', run: 'ran', recall: 'recalled', open: 'opened', edit: 'edited', type: 'typed'};
const DOING = {
  read: 'reading', search: 'searching', run: 'running', recall: 'recalling', open: 'opening', edit: 'editing', type: 'typing',
  point: 'pointing at', suggest: 'writing a suggestion for',
};
export const shownTool = tool => tool in DONE;
/** A tool's line under the question: read queue.go 1-40. */
export const toolDone = (tool, what) => `${DONE[tool] ?? tool} ${what}`;

const pad = n => String(n).padStart(2, '0');
/** HH:MM of `at`. */
export const clock = at => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
/** HH:MM of `at`, after its day (Thu 29 Oct · 00:12) when that is not `day`'s. */
export function when(at, day = at) {
  if (sameDay(at, day)) return clock(at);
  const date = new Date(at);
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} · ${clock(at)}`;
}
/** 3s, 1m 20s, 2h 5m. */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Words and their wrapping.

/** The inline tokens of one line of Markdown: words, `code` spans and **bold**, each with the spaces before it. */
export function inlineTokens(line, base = 'text', {markdown = true} = {}) {
  const out = [];
  const words = (text, style, space) => text.trim().split(/\s+/).forEach((part, i) => out.push({space: i === 0 ? space : ' ', text: part, style}));
  if (!markdown) {
    for (const [, space, word] of line.matchAll(/(\s*)(\S+)/g)) out.push({space, text: word, style: base});
    return out;
  }
  // `code`, **bold**, *italic* or _italic_ (not inside a word: snake_case stays), a [link](url) as its words and the
  // address, dim; anything else word by word.
  const pattern = /(?<space>\s*)(?:(?<ticks>`+)(?<code>[^`]+?)\k<ticks>|\*\*(?<bold>[^*]+?)\*\*|(?<![\w*])[*_](?![\s*_])(?<italic>[^*_]+?)(?<!\s)[*_](?![\w*])|\[(?<label>[^\]]+)\]\((?<url>[^)\s]+)\)|(?<word>\S+))/g;
  for (const {groups: {space, code, bold, italic, label, url, word}} of line.matchAll(pattern)) {
    if (code !== undefined) words(code, 'code', space); // a span wraps at its spaces, with the word before it
    else if (bold !== undefined) words(bold, 'bold', space);
    else if (italic !== undefined) words(italic, 'italic', space);
    else if (label !== undefined) {
      words(label, 'under', space);
      out.push({space: ' ', text: `(${url})`, style: 'dim'});
    } else out.push({space, text: word, style: base});
  }
  return out;
}

/**
 * Tokens as lines of segments at most `width` wide: the first line after `first`, the others after `rest` (both
 * lines of segments, such as a bullet and its hanging indent). Tokens with no space between them (`code`, and the
 * colon after it) wrap as one word; a word longer than a line is cut between its tokens (see breakText).
 */
export function wrapTokens(tokens, width, first = [], rest = first) {
  const words = [];
  for (const token of tokens) {
    if (words.length && !token.space) words.at(-1).parts.push(token);
    else words.push({space: token.space.replace(/\n/g, ' '), parts: [token]});
  }
  const lines = [];
  let line = [...first];
  let start = lineWidth(first);
  let used = start;
  const next = () => {
    lines.push(line);
    line = [...rest];
    start = used = lineWidth(rest);
  };
  for (const word of words) {
    const w = word.parts.reduce((sum, part) => sum + textWidth(part.text), 0);
    if (used > start && used + textWidth(word.space) + w > width) next();
    if (used > start && word.space) {
      line.push(seg(word.space, word.parts[0].style === 'code' ? 'text' : word.parts[0].style));
      used += textWidth(word.space);
    }
    for (const part of word.parts) {
      let text = part.text;
      while (textWidth(text) > width - used) {
        const piece = breakText(text, Math.max(1, width - used));
        line.push(seg(piece, part.style));
        text = text.slice(piece.length);
        next();
      }
      if (text) {
        line.push(seg(text, part.style));
        used += textWidth(text);
      }
    }
  }
  lines.push(line);
  return lines;
}

// Code: a name (kebab-case too), a number or version (3.14, v1.2.3-rc.1) or a run of signs is one token; a line
// breaks between them, after an opening sign, a slash or a value's = and before a dot, never after a dot, a dash or <,
// before a closing sign or a comma, or between a flag and its = (--config=).
const TOKEN = /[\w$]+(?:(?:-[\w$]|\.\d)[\w$]*)*|[^\w\s]+/g;
const breaksBefore = token => !/^[)\]},;:]/.test(token);
const breaksAfter = (tokens, i) => !/[.&*!@$#\\~<-]$/.test(tokens[i]) && !(tokens[i] === '=' && /-$/.test(tokens[i - 2] ?? ''));

/**
 * The longest start of `text` (no spaces in it) that fits in `width` and ends between two tokens. A single token
 * longer than that breaks after a dash in it (my-long-|name); only a word without one is cut.
 */
export function breakText(text, width) {
  if (textWidth(text) <= width) return text;
  const tokens = text.match(TOKEN) ?? [text];
  let best = '';
  let at = '';
  for (let i = 0; i < tokens.length - 1; i++) {
    at += tokens[i];
    if (textWidth(at) > width) break;
    if (breaksAfter(tokens, i) && breaksBefore(tokens[i + 1])) best = at;
  }
  if (best) return best;
  const fits = fitText(text, width);
  const dash = fits.lastIndexOf('-', fits.length - 2) + 1;
  return (dash > 1 ? fits.slice(0, dash) : fits) || [...text][0];
}

/**
 * One line of code in lines of `width`: the first after `prefix`, the others after `more` and the line's own indent
 * and two spaces more. It wraps at its spaces, and a token too long for a line is cut between its tokens. An indent
 * deeper than half the line is shown at half the line, so the words keep the other half.
 */
export function codeLines(text, width, style, prefix = [], more = prefix) {
  const expanded = text.replace(/\t/g, '    ');
  const half = Math.floor(width / 2);
  const indent = ' '.repeat(Math.min(/^ */.exec(expanded)[0].length, Math.max(0, half - lineWidth(prefix))));
  const hanging = Math.min(indent.length + 2, Math.max(0, half - lineWidth(more)));
  const hang = hanging ? [...more, seg(' '.repeat(hanging), style)] : more;
  const lines = [];
  let line = [...prefix, ...(indent ? [seg(indent, style)] : [])];
  let start = lineWidth(line);
  let used = start;
  const next = () => {
    lines.push(line);
    line = [...hang];
    start = used = lineWidth(hang);
  };
  for (const [, space, word] of expanded.trimStart().matchAll(/(\s*)(\S+)/g)) {
    if (used > start && used + textWidth(space) + textWidth(word) > width) next();
    if (used > start && space) {
      line.push(seg(space, style));
      used += textWidth(space);
    }
    let rest = word;
    while (textWidth(rest) > width - used) {
      if (used > start) next();
      const piece = breakText(rest, Math.max(1, width - used));
      line.push(seg(piece, style));
      rest = rest.slice(piece.length);
      if (rest) next();
    }
    if (rest) {
      line.push(seg(rest, style));
      used += textWidth(rest);
    }
  }
  if (line.length === prefix.length) line.push(seg(' ', style));
  lines.push(line);
  return lines;
}

/**
 * A file's last part: internal/queue/lease.go:18 as lease.go:18, in a pane too narrow for the whole. Only names of
 * files (with an extension) and not ./paths, so a command stays one you could run (go test ./internal/queue).
 */
export const baseNames = text => text.replace(/(?<![\w./-])(?:[\w-]+\/)+([\w-]*\w[\w-]*(?:\.\w+)+)(?![\w/])/g, '$1');

/** `lines` without the indentation they all share (tabs as four spaces). */
export function dedent(lines) {
  const expanded = lines.map(line => line.replace(/\t/g, '    '));
  const indents = expanded.filter(line => line.trim()).map(line => /^ */.exec(line)[0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return expanded.map(line => line.slice(common));
}

/** The style of a line in a diff. */
function diffStyle(line) {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  return 'text';
}

const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/**
 * The width of each ordered item's number (by its row in `rows`): the widest of its list at its depth, so that 9.
 * and 10. end in the same column. A list goes on over blank rows and the rows of its deeper items.
 */
function numberWidths(rows) {
  const widths = new Map();
  let list = []; // the rows of the list we are in, as [row, depth, number]
  const close = () => {
    for (const depth of new Set(list.map(([, d]) => d))) {
      const mine = list.filter(([, d]) => d === depth);
      const widest = Math.max(...mine.map(([, , n]) => n.length));
      for (const [row] of mine) widths.set(row, widest);
    }
    list = [];
  };
  rows.forEach((raw, row) => {
    const item = ITEM.exec(raw);
    if (item && /\d/.test(item[2])) list.push([row, Math.floor(item[1].length / 2), item[2]]);
    else if (!item && raw.trim()) close();
  });
  close();
  return widths;
}

/**
 * `text` as Markdown, in lines of segments: fenced code (a bar on its left, wrapped between its tokens; a diff in its
 * colours) at most `width` wide, and at most `measure` wide headings, lists with a hanging indent, quotes, and
 * paragraphs with `code` in the accent and **bold**. A line indented four spaces is code too, as Pair's notes write it.
 */
export function markdownLines(text, width, {base = 'text', measure = width} = {}) {
  const code = width;
  width = Math.min(width, measure);
  const lines = [];
  let fence = null; // the language of the code block we are in, or null
  let blankBefore = false;
  const rows = text.replace(/\r/g, '').split('\n');
  const numbers = numberWidths(rows);
  rows.forEach((raw, row) => {
    const fenceMatch = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(raw);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[2].toLowerCase() : null;
      blankBefore = false;
      return;
    }
    if (fence !== null) {
      const style = fence === 'diff' ? diffStyle(raw) : 'text';
      lines.push(...codeLines(raw, code, style, [seg('│ ', 'rule')]));
      blankBefore = false;
      return;
    }
    if (!raw.trim()) {
      if (lines.length && !blankBefore) lines.push(blank());
      blankBefore = true;
      return;
    }
    blankBefore = false;
    if (/^( {4}|\t)/.test(raw)) {
      lines.push(...codeLines(raw.replace(/^( {4}|\t)/, ''), code, 'text', [seg('  ', 'text')]));
      return;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      lines.push(...wrapTokens(inlineTokens(heading[1], 'bold').map(token => ({...token, style: token.style === 'code' ? 'code' : 'bold'})), width));
      return;
    }
    const item = ITEM.exec(raw);
    if (item) {
      const depth = Math.min(3, Math.floor(item[1].length / 2));
      const mark = /\d/.test(item[2]) ? `${item[2].padStart(numbers.get(row))} ` : '• ';
      const indent = '  '.repeat(depth);
      lines.push(...wrapTokens(inlineTokens(item[3], base), width, [seg(indent + mark, 'dim')], [seg(' '.repeat(textWidth(indent + mark)), 'text')]));
      return;
    }
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) {
      lines.push(...wrapTokens(inlineTokens(quote[1], 'italic'), width, [seg('▎ ', 'rule')]));
      return;
    }
    lines.push(...wrapTokens(inlineTokens(raw.trim(), base), width));
  });
  while (lines.length && !lines.at(-1).length) lines.pop();
  return lines;
}

/** Plain words (what you typed, the pane's notes): wrapped at words, their line breaks kept. */
export function plainLines(text, width, style = 'text') {
  return text.split('\n').flatMap(line => (line.trim() ? wrapTokens(inlineTokens(line, style, {markdown: false}), width) : [blank()]));
}

/** A suggestion as a diff: the lines it replaces, then the ones it puts there. */
export function diffLines({old = [], new: added = []}, width) {
  const lines = dedent([...old, ...added]);
  const side = (line, i) => {
    const removed = i < old.length;
    return codeLines(line, width, removed ? 'del' : 'add', [seg('│ ', 'rule'), seg(removed ? '- ' : '+ ', removed ? 'del' : 'add')], [seg('│   ', 'rule')]);
  };
  return lines.flatMap(side);
}

// Messages.

/**
 * The └ line of what the tools did, `width` wide: when it is too long, paths by their last part, then the last tools
 * as a count (read lease.go 1-40 · +1).
 */
function toolLine(tools, width) {
  const line = parts => [seg('└ ', 'dim'), seg(parts.join(' · '), 'dim')];
  const done = tools.map(({tool, what}) => toolDone(tool, what));
  if (lineWidth(line(done)) <= width) return line(done);
  const short = tools.map(({tool, what}) => toolDone(tool, baseNames(what)));
  for (let shown = short.length; shown > 0; shown--) {
    const parts = shown < short.length ? [...short.slice(0, shown), `+${short.length - shown}`] : short;
    if (lineWidth(line(parts)) <= width) return line(parts);
  }
  return clipLine(line(short.length > 1 ? [short[0], `+${short.length - 1}`] : short), width);
}

/** The lines of what `entry` says without its gutter: code `width` wide, words `measure` wide. */
export function bodyLines(entry, width, {continued = false, measure = width} = {}) {
  const {kind, text = '', meta = {}} = entry;
  const words = Math.min(width, measure);
  if (kind === 'tool') {
    if (entry.expanded) return entry.tools.flatMap(({tool, what}) => codeLines(toolDone(tool, what), width, 'dim', [seg('└ ', 'dim')], [seg('  ', 'dim')]));
    return [toolLine(entry.tools, width)];
  }
  if (kind === 'confirm') {
    // Pair's question in body text; the command it asks about under it in a code bar, to read and copy whole: the
    // session's own copy of it (a command may hold backticks itself), else the question's first `code`. The keys
    // that answer are in the footer, once. A /gen question has no command: its hint says what its answers do.
    const command = entry.hint ? null : entry.command ?? /`([^`]+)`/.exec(text)?.[1];
    const question = command ? text.replace(`\`${command}\``, () => 'this') : text;
    const lines = wrapTokens(inlineTokens(question, 'text'), words);
    if (command) lines.push(...codeLines(command, width, 'text', [seg('│ ', 'rule')]));
    if (entry.hint && entry.answer === undefined) lines.push(...wrapTokens(inlineTokens(entry.hint, 'dim', {markdown: false}), words));
    if (entry.answer !== undefined) lines.push([seg(entry.hint ? 'you answered' : entry.answer ? 'you allowed it' : 'you declined', entry.answer || entry.hint ? 'ok' : 'text')]);
    return lines;
  }
  if (kind === 'note') return text.split('\n').flatMap(line => codeLines(line, width, 'text'));
  if (kind === 'you') {
    const about = meta.about && entry.aboutText ? [[seg('↳ about: ', 'dim'), ...clipLine([seg(entry.aboutText, 'dim')], words - 9)]] : [];
    return [...about, ...plainLines(text, words)];
  }
  if (kind === 'system') return plainLines(text, words, 'text');
  if (kind === 'error') return markdownLines(text, width, {base: 'error', measure}); // a command in it is `code`, whole
  if (kind === 'gen') {
    // A gen card: its words as Pair's, the code at the cursor as a diff under them, and how to take it when the
    // card has no keys for it (a request of an older daemon); the keys are the action line under it.
    const lines = markdownLines(text, width, {measure});
    if (meta.suggestion) lines.push(...diffLines(meta.suggestion, width));
    if (entry.applied) lines.push([seg('✓ taken', 'ok')]);
    // How to take it, in words: for a request the pane has no card of (one before this version), and for a try,
    // where it says where its folder is and how long it stays.
    if (meta.hint && (!entry.card || entry.card.shape === 'try')) lines.push(...wrapTokens(inlineTokens(meta.hint, 'text'), words));
    return lines;
  }
  // Pair's words: a remark says what about first; a suggestion shows as a diff under its first line.
  const lines = [];
  if (meta.trigger && !continued) {
    const head = file => [
      seg(meta.trigger.replace(/_/g, ' '), 'watchMeta'),
      ...(meta.place ? [seg(` · ${file}:${meta.place.line}`, 'watchMeta')] : []),
      ...(entry.verdict ? [seg(entry.verdict === 'useful' ? '  ✓ useful' : '  ✗ noise', entry.verdict === 'useful' ? 'ok' : 'dim')] : []),
    ];
    const whole = head(meta.place?.file);
    lines.push(clipLine(lineWidth(whole) <= words ? whole : head(baseNames(meta.place?.file ?? '')), words));
  }
  if (meta.suggestion) {
    const [first] = text.split('\n');
    const note = /suggestion: (.*)$/.exec(first)?.[1] ?? first;
    if (meta.place && !meta.trigger) lines.push(clipLine([seg('✎ suggested change · ', 'accent'), seg(`${meta.place.file}:${meta.place.line}`, 'accent')], words));
    lines.push(...markdownLines(note, width, {measure}));
    lines.push(...diffLines(meta.suggestion, width));
    if (entry.applied) lines.push([seg('✓ taken', 'ok')]);
  } else {
    lines.push(...markdownLines(text, width, {measure}));
  }
  if (entry.partial) {
    const last = lines.at(-1) ?? [];
    if (lines.length) lines[lines.length - 1] = [...last, seg(' ▍', 'accent')];
    else lines.push([seg('▍', 'accent')]);
  }
  return lines;
}

/**
 * Underlines what matches `query` in `line` (any case), counting the matches in `count.n`: the one numbered
 * `current` (from 0) is the match you are on, green and bold too.
 */
function highlight(line, query, count, current = -1) {
  // The line's text as one: a match may run over several segments (two words, a word and a `code` span).
  const text = line.map(s => s.text).join('');
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const found = []; // [start, end, style] of each match, in the line's text
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) {
    found.push([i, i + needle.length, count.n === current ? 'found' : 'match']);
    count.n += 1;
  }
  if (!found.length || lower.length !== text.length) return line; // (a case change that changes the length: left as is)
  const out = [];
  let at = 0;
  for (const s of line) {
    const end = at + s.text.length;
    let from = at;
    for (const [start, stop, style] of found) {
      if (stop <= from || start >= end) continue;
      if (start > from) out.push(seg(text.slice(from, start), s.style));
      out.push(seg(text.slice(Math.max(start, from), Math.min(stop, end)), style));
      from = Math.min(stop, end);
    }
    if (from < end) out.push(seg(text.slice(from, end), s.style));
    at = end;
  }
  return out;
}

/** Whether `entry`'s text has `query` in it, its line breaks and runs of spaces as one space (a match over a wrap). */
const spans = (entry, query) => searchText(entry).toLowerCase().replace(/\s+/g, ' ').includes(query.toLowerCase().replace(/\s+/g, ' ').trim());

/** The keys that work on a remark once it is picked, as its last line shows them: rate it, take its suggestion, go to its line. */
export function remarkKeys(entries, index) {
  const id = entries[index]?.meta?.remark;
  const group = entries.filter(entry => id && entry.meta?.remark === id);
  return {
    apply: group.find(entry => entry.meta.suggestion && !entry.applied) ?? null,
    jump: group.findLast(entry => entry.meta.place) ?? null,
  };
}

/**
 * The action line under a remark, `width` wide: + useful  - noise  a apply  j jump  · Alt-↑ first, spaced like
 * buttons. The keys work once the remark is picked (a letter on an empty line is the start of a question), so until
 * then the aside says how; `picked`, it goes. Where it does not fit, the gaps narrow, then the keys lose their words.
 */
function actionLine(entries, index, width, picked) {
  const {apply, jump} = remarkKeys(entries, index);
  const keys = [['+', 'useful'], ['-', 'noise'], ...(apply ? [['a', 'apply']] : []), ...(jump ? [['j', 'jump']] : [])];
  const aside = picked ? [] : [seg('  · ', 'dim'), seg('Alt-↑', 'bold'), seg(' first', 'dim')];
  const line = (gap, words) => [
    ...keys.flatMap(([key, what], i) => [...(i ? [seg(gap)] : []), seg(key, 'bold'), ...(words ? [seg(` ${what}`, 'dim')] : [])]),
    ...aside,
  ];
  return [line('  ', true), line(' ', true), line(' ', false)].find(l => lineWidth(l) <= width) ?? clipLine(line(' ', false), width);
}

/** The keys of a gen card, in the order its action line shows them: [key, what, its words on the card]. */
export function cardKeys(card) {
  const keys = card?.keys ?? {};
  return [['k', 'k'], ['enter', 'Enter'], ['d', 'd'], ['u', 'u']].filter(([key]) => keys[key]).map(([key, shown]) => [key, shown, keys[key]]);
}

/** What a relayed line's keys reach of its `item`: its report or pull request, its branch's diff, its worktree. */
export function relayKeys(item) {
  return {key: item.key, title: item.kind === 'task' ? item.id : item.title, live: true, open: item.kind === 'task', diff: Boolean(item.branch), term: Boolean(item.where)};
}

/** The keys of a relayed line (see relayKeys), in the order its action line shows them: [key, shown, what]. */
export function relayActions(entry) {
  const agent = entry?.meta?.agent;
  if (!agent) return [];
  return [['o', agent.open, 'open'], ['d', agent.diff, 'diff'], ['t', agent.term, 'terminal']].filter(([, on]) => on).map(([key, , what]) => [key, key, what]);
}

/**
 * The action line under a gen card, `width` wide: k keep one   Enter open the list   d drop all   u undo   · Alt-↑
 * picks. As for a remark, the keys work once the card is picked; where it does not fit, the gaps narrow, then the
 * keys lose their words. A relayed line's keys show the same way: o open   d diff   t terminal.
 */
function cardLine(entry, width, picked, keys = cardKeys(entry.card)) {
  const aside = picked ? [] : [seg('   · ', 'dim'), seg('Alt-↑', 'bold'), seg(' picks', 'dim')];
  const line = (gap, words, how = aside) => [
    ...keys.flatMap(([, shown, what], i) => [...(i ? [seg(gap)] : []), seg(shown, 'bold'), ...(words ? [seg(` ${what}`, 'dim')] : [])]),
    ...how,
  ];
  // Last, the aside goes whole rather than cut.
  return [line('   ', true), line('  ', true), line(' ', true), line(' ', false), line(' ', false, [])].find(l => lineWidth(l) <= width) ?? clipLine(line(' ', false, []), width);
}

/** All the text of `entry`, as search and copy see it. */
export function searchText(entry) {
  if (entry.kind === 'tool') return entry.tools.map(({tool, what}) => toolDone(tool, what)).join('\n');
  const diff = entry.meta?.suggestion ? `\n${entry.meta.suggestion.new.join('\n')}` : '';
  return `${entry.text ?? ''}${diff}`;
}

/** Whether `entry` starts a new turn in the gutter: another speaker than `previous`, or another remark. */
function startsTurn(entry, previous) {
  if (entry.kind === 'tool') return false;
  if (!previous) return true;
  if (speaker(previous) !== speaker(entry)) return true;
  const gen = one => one.meta?.gen ?? one.gen; // a card's request, or a question's
  return Boolean(entry.meta?.remark && entry.meta.remark !== previous.meta?.remark) || Boolean(gen(entry) && gen(entry) !== gen(previous));
}

/** The time between messages, centred and dim: ── 21:19 ──. */
export function dividerLine(label, width) {
  const words = [seg('── ', 'rule'), seg(label, 'dim'), seg(' ──', 'rule')];
  return clipLine([seg(' '.repeat(Math.max(0, Math.floor((width - lineWidth(words)) / 2)))), ...words], width);
}

/** What a turn took, for the margin of its answer: 21:19 · 6.4s · 3.4k tok, the longest that fits in `room`. */
function turnMeta(entry, room) {
  const {ms, tokens} = entry.turn;
  const parts = [clock(entry.at), ...(ms ? [`${(ms / 1000).toFixed(1)}s`] : []), ...(tokens ? [`${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok`] : [])];
  for (let n = parts.length; n > 0; n--) {
    const text = parts.slice(0, n).join(' · ');
    if (textWidth(text) <= room) return text;
  }
  return null;
}

/**
 * The lines of the whole conversation `width` wide, and where each message is among them ({start, end, folded,
 * matches, found}, end exclusive; `matches` counts what search finds in it, folded or not, and `found` is the line of
 * the match you are on). `selected` is the index of the
 * selected message, `query` what search looks for and `found` the match you are on, by its number in the selected
 * message (a fold opens to show it); `latestRemark` the index of the remark whose action line the pane shows, and
 * `latestCard` that of the gen card, `latestRelay` that of the agent relay's line; `now` today, for the day of a divider.
 */
export function transcriptLines(entries, width, {selected = -1, query = '', found = -1, latestRemark = -1, latestCard = -1, latestRelay = -1, now = Date.now()} = {}) {
  const lines = [];
  const ranges = [];
  const bodyWidth = Math.max(8, width - GUTTER);
  const measure = Math.max(8, Math.min(width, MEASURE) - GUTTER);
  let previous = null;
  let lastAt = null; // the time of the last message, for the pauses
  entries.forEach((entry, index) => {
    // The time comes back at the start, after a pause and on another day.
    const timed = entry.kind !== 'tool' && entry.at;
    const divided = timed && (lastAt === null || entry.at - lastAt >= PAUSE_MS || !sameDay(entry.at, lastAt));
    if (divided) {
      if (lines.length) lines.push(blank());
      lines.push(dividerLine(when(entry.at, lastAt ?? now), width));
    }
    const turn = divided || startsTurn(entry, previous);
    const quiet = kind => ['system', 'note'].includes(kind);
    const spaced = !divided && entry.kind !== 'tool' && previous && (turn || !(quiet(entry.kind) && quiet(previous.kind)));
    if (spaced && lines.length) lines.push(blank());
    const start = lines.length;
    const bar = seg(index === selected ? '▌' : ' ', 'bar');
    const label = LABELS[speaker(entry)] ?? '';
    const head = turn && label ? [seg(label, LABEL_STYLES[speaker(entry)]), seg(' '.repeat(GUTTER - 1 - textWidth(label)))] : null;
    const continued = Boolean(entry.meta?.remark && entry.meta.remark === previous?.meta?.remark);
    let body = bodyLines(entry, bodyWidth, {continued, measure});
    // What search finds: all of it underlined, the match you are on in green too; a fold does not hide it.
    const count = {n: 0};
    let foundRow = -1;
    if (query) {
      body = body.map((line, row) => {
        const before = count.n;
        const lit = highlight(line, query, count, index === selected ? found : -1);
        if (index === selected && found >= before && found < count.n) foundRow = row;
        return lit;
      });
    }
    // A match the lines do not show whole (it runs over a wrap, or over a line break) still finds its message, once.
    if (query && !count.n && query.trim() && spans(entry, query)) count.n = 1;
    // A gen card does not fold: Enter on it opens it in Neovim, and it is short already (CARD_FILES in gen.mjs).
    const folded = !entry.expanded && !['tool', 'gen'].includes(entry.kind) && body.length > FOLD_OVER && foundRow < FOLD_TO;
    if (folded) {
      const hidden = body.length - FOLD_TO;
      const how = index === selected ? 'Enter' : 'Alt-↑ and Enter';
      const folds = [`… ${hidden} more lines · ${how} shows all`, `… ${hidden} more lines · ${how.replace(' and ', ' ')}`, `… ${hidden} more · ${how.replace(' and ', ' ')}`];
      body = [...body.slice(0, FOLD_TO), [seg(folds.find(fold => textWidth(fold) <= bodyWidth) ?? folds.at(-1), 'dim')]];
    }
    if (index === latestRemark && !entry.verdict) body.push(actionLine(entries, index, bodyWidth, index === selected));
    if (index === latestCard && cardKeys(entry.card).length) body.push(blank(), cardLine(entry, bodyWidth, index === selected));
    if (index === latestRelay && relayActions(entry).length) body.push(cardLine(entry, bodyWidth, index === selected, relayActions(entry)));
    // A wide pane has room right of the words: what the turn took goes there, on its answer's first line.
    if (entry.turn && body.length && width > MEASURE) {
      const used = GUTTER + lineWidth(body[0]);
      const meta = turnMeta(entry, width - Math.max(used, MEASURE) - 2);
      if (meta) body[0] = [...body[0], seg(' '.repeat(width - used - textWidth(meta))), seg(meta, 'dim')];
    }
    body.forEach((line, i) => lines.push([bar, ...(i === 0 && head ? head : [seg(' '.repeat(GUTTER - 1))]), ...line]));
    if (!body.length && head) lines.push([bar, ...head]);
    ranges.push({start, end: lines.length, folded, matches: count.n, ...(foundRow !== -1 ? {found: start + foundRow} : {})});
    previous = entry;
    if (timed) lastAt = entry.at;
  });
  return {lines: lines.map(line => clipLine(line, width)), ranges};
}

// The pane's other parts.

/**
 * A rule with words in it, `width` wide: ── left ──────── right ──. When they do not fit, `left` is cut down to
 * `keep` columns (all of it, unless said), then `right` gives way from its end, then `left` is cut further.
 */
export function ruleLine(left, right, width, {keep = lineWidth(left)} = {}) {
  const r = [...right];
  while (r.length && !ruleFits(left, r, width, keep)) r.pop();
  if (r.length && r[0].text.startsWith(' · ')) r[0] = {...r[0], text: r[0].text.slice(3)};
  const tail = lineWidth(r) ? lineWidth(r) + 4 : 0;
  const room = width - 3 - 1 - 2 - tail;
  const fitted = lineWidth(left) > room ? clipLine(left, Math.max(1, room)) : left;
  const dashes = Math.max(2, width - 3 - 1 - lineWidth(fitted) - tail);
  const end = r.length ? [seg(' ', 'rule'), ...r, seg(' ──', 'rule')] : [];
  return clipLine([seg('── ', 'rule'), ...fitted, seg(` ${'─'.repeat(dashes)}`, 'rule'), ...end], width);
}

/** Whether `left` (cut to `keep` columns at most) and `right` fit in a rule `width` wide: '── ' left ' ─…─' ' ' right ' ──', two dashes at least. */
export function ruleFits(left, right, width, keep = lineWidth(left)) {
  const r = right.length && right[0].text.startsWith(' · ') ? lineWidth(right) - 3 : lineWidth(right);
  return Math.min(keep, lineWidth(left)) <= width - 3 - 1 - 2 - (right.length ? r + 4 : 0);
}

/** The first of `variants` of a rule's words (long to short: [left, right, keep]) that fits whole; else the last, cut. */
function fittedRule(variants, width) {
  const [left, right, keep] = variants.find(([l, r, k]) => ruleFits(l, r, width, k)) ?? variants.at(-1);
  return ruleLine(left, right, width, {keep});
}

const SHORT_ROLES = {navigator: 'nav'};
const ROLE_STYLES = ['navigator', 'scout', 'driver']; // each in its colour (see chat-style.mjs)

/** The board's counts for the header: `board 3 working · 1 needs you`, the ones that need you in the accent; [] for none. */
export function boardSegments(board) {
  if (!board || (!board.working && !board.needs)) return [];
  const parts = [...(board.working ? [seg(`${board.working} working`, 'dim')] : []), ...(board.needs ? [seg(`${board.needs} need${board.needs === 1 ? 's' : ''} you`, 'accent')] : [])];
  return [seg('board ', 'dim'), ...parts.flatMap((part, i) => (i ? [seg(' · ', 'dim'), part] : [part]))];
}

/**
 * The header, in the top rule: where you pair and on what, then the board's counts for the repo, the role, in its
 * colour, and the level (the Driver that keeps the wheel says so instead), on the right. The goal is cut first, to a
 * few words, then left out (always in a narrow pane), then the board's counts go, then the role is shortened (nav),
 * and the muted kinds, the level and the role give way.
 */
export function headerLine({project, goal, role, level, muted = [], keep = false, board = null}, width) {
  const where = [seg('pair', 'accentBold'), ...(project ? [seg(' · ', 'dim'), seg(project, 'bold')] : [])];
  const second = role === 'driver' && keep ? 'keeps the wheel' : level ?? '';
  const right = (name, parts = 3) => (role ? [seg(name, ROLE_STYLES.includes(role) ? role : 'dim'), seg(` · ${second}`, 'text'), ...(muted.length ? [seg(` · ${muted.length} muted`, 'dim')] : [])].slice(0, parts) : []);
  const counts = boardSegments(board);
  const withBoard = parts => (counts.length ? [...counts, ...(parts.length ? [seg(' · ', 'dim'), ...parts] : [])] : parts);
  const short = SHORT_ROLES[role] ?? role;
  const variants = [
    ...(goal && width >= NARROW && counts.length ? [[[...where, seg(' · ', 'dim'), seg(goal, 'text')], withBoard(right(role)), lineWidth(where) + 12]] : []),
    ...(goal && width >= NARROW ? [[[...where, seg(' · ', 'dim'), seg(goal, 'text')], right(role), lineWidth(where) + 12]] : []),
    ...(width >= NARROW && counts.length ? [[where, withBoard(right(role))]] : []),
    ...(width >= NARROW ? [[where, right(role)]] : []),
    [where, right(short)], [where, right(short, 2)], [where, right(short, 1)], [where, []],
  ];
  return fittedRule(variants, width);
}

/** `left` and `right` on one line `width` wide; `left` is cut first. */
export function spread(left, right, width) {
  const room = width - lineWidth(right) - 1;
  const fitted = lineWidth(left) > room ? clipLine(left, Math.max(1, room)) : left;
  const gap = Math.max(1, width - lineWidth(fitted) - lineWidth(right));
  return clipLine([...fitted, seg(' '.repeat(gap)), ...right], width);
}

export const rule = width => [seg('─'.repeat(Math.max(0, width)), 'rule')];

/** How long ago `at` was, said briefly: just now, 2m ago. */
function ago(at, now) {
  const ms = now - at;
  return ms < 60_000 ? 'just now' : `${duration(ms).split(' ')[0]} ago`;
}

const ELAPSED_AFTER_MS = 3000; // a short turn does not tick

/** What waits under the answer that streams: 1 remark below, 2 notes below, 1 remark and 1 note below. */
export function heldText(held) {
  const {remarks = 0, notes = 0} = held ?? {};
  const count = (n, word) => (n ? [`${n} ${word}${n === 1 ? '' : 's'}`] : []);
  const parts = [...count(remarks, 'remark'), ...count(notes, 'note')];
  return parts.length ? `${parts.join(' and ')} below` : '';
}

const GEN_AT_WORK = ['asking', 'asks', 'queued', 'generating'];

/**
 * What the status says of the /gen requests (`cards`, the chat's gen cards, see Gen.card in gen.mjs): the one at
 * work, those that wait for it, and the newest one ready, with what is left of it to take.
 */
export function genStatus(cards = []) {
  const working = cards.filter(card => GEN_AT_WORK.includes(card.state));
  const running = working.find(card => card.state === 'generating') ?? working.find(card => card.state !== 'queued') ?? null;
  const ready = [...cards].reverse().find(card => card.state === 'ready') ?? null;
  const left = !ready ? null
    : ready.shape === 'here' ? 'ready in Neovim'
      : ready.shape === 'scaffold' ? `${ready.taken} of ${ready.of} kept`
        : ready.shape === 'file' ? (ready.left ? `${ready.left} to review` : 'ready in Neovim') : null;
  return {running, queued: working.filter(card => card.state === 'queued').map(card => card.gen), ready: left ? {gen: ready.gen, text: left} : null};
}

/**
 * The status, in the rule over the input: what Pair does now on the left, in body text (with a spinner while it
 * works, and how long it has worked once that is 3s), and what waits under the answer that streams; on the right the
 * model, how long its last answer took and what it cost, or that you scrolled up. The glyph has its part's colour:
 * the Watcher's ◉ yellow, the Driver's ◆ red, Pair's spinner the accent, a /gen request's magenta. A request at work
 * shows there too: alone when Pair does nothing else, after what it does otherwise; once done, what is left of it to
 * take. It names no keys: those are in the footer.
 */
export function statusLine(view, width) {
  const {activity = {state: 'idle'}, presence, connection = 'up', now = Date.now(), frame = 0, turn, model, down = [], scrolled = 0, role, writing, away, held} = view;
  const gen = view.gen ?? {running: null, queued: [], ready: null};
  const genName = n => seg(`gen #${n}`, 'gen');
  // The requests that wait for the one at work: after it, or after what Pair does.
  const queued = gen.queued.length ? [seg(' · ', 'dim'), seg(gen.queued.length === 1 ? `gen #${gen.queued[0]} waits` : `${gen.queued.length} more wait`, 'text')] : [];
  const asks = gen.running && ['asking', 'asks'].includes(gen.running.state) ? gen.running.asks ?? null : null; // where its question waits
  const spin = SPINNER[frame % SPINNER.length];
  const elapsed = from => (from && now - from >= ELAPSED_AFTER_MS ? [seg(` ${duration(now - from)}`, 'dim')] : []);
  const since = elapsed(activity.since);
  // Each state long to short: a narrow pane gets a shorter one whole, not a long one cut in the middle.
  let lefts;
  if (connection === 'connecting') lefts = [[seg('… ', 'dim'), seg('connecting to the pair daemon', 'text')], [seg('… ', 'dim'), seg('connecting', 'text')]];
  else if (connection === 'away') {
    // How long it has been away and how many times the pane tried, so a blip reads differently from a dead daemon.
    const gone = elapsed(away?.since);
    const tries = away?.attempts ? [seg(` · attempt ${away.attempts}`, 'dim')] : [];
    lefts = [
      [seg('! ', 'warn'), seg('the pair daemon went away', 'text'), seg(' · reconnecting', 'dim'), ...gone, ...tries],
      [seg('! ', 'warn'), seg('reconnecting', 'text'), ...gone, ...tries],
      [seg('! ', 'warn'), seg('reconnecting', 'text'), ...gone],
      [seg('! ', 'warn'), seg('reconnecting', 'text')],
    ];
  }
  else if (activity.state === 'thinking') lefts = [[seg(`${spin} `, 'accent'), seg(writing ? 'writing' : 'thinking', 'accentBold'), ...since]];
  else if (activity.state === 'tool') {
    const doing = DOING[activity.tool] ?? activity.tool;
    const what = activity.what ?? '';
    lefts = [
      [seg(`${spin} `, 'accent'), seg(doing, 'accentBold'), seg(` ${what}`, 'text'), ...since],
      [seg(`${spin} `, 'accent'), seg(doing, 'accentBold'), seg(` ${baseNames(what)}`, 'text'), ...since],
      [seg(`${spin} `, 'accent'), seg(doing.split(' ')[0], 'accentBold'), ...since],
    ];
  } else if (activity.state === 'remark') {
    // The Watcher looks: its colour.
    lefts = [[seg(`${spin} `, 'watcher'), seg(`looking at ${(activity.what ?? 'a moment').replace(/_/g, ' ')}`, 'text'), ...since], [seg(`${spin} `, 'watcher'), seg('looking', 'text'), ...since]];
  } else if (activity.state === 'waiting' && asks === 'chat') {
    lefts = [[seg('? ', 'warn'), genName(gen.running.gen), seg(' waits for your answer', 'text')], [seg('? ', 'warn'), genName(gen.running.gen), seg(' waits', 'text')]];
  } else if (activity.state === 'waiting') lefts = [[seg('? ', 'warn'), seg('waiting for your answer', 'text')], [seg('? ', 'warn'), seg('waiting', 'text')]];
  else if (role === 'driver') lefts = [[seg('◆ ', 'driverGlyph'), seg('Pair drives', 'driver'), seg(' · any key in Neovim takes it back', 'dim')], [seg('◆ ', 'driverGlyph'), seg('Pair drives', 'driver')]];
  else if (gen.running?.state === 'generating') {
    // A /gen request at work, while Pair does nothing else: its colour.
    const at = elapsed(gen.running.since);
    lefts = [
      [seg(`${spin} `, 'genGlyph'), genName(gen.running.gen), seg(' generating', 'text'), ...at, ...queued],
      [seg(`${spin} `, 'genGlyph'), genName(gen.running.gen), seg(' generating', 'text'), ...at],
      [seg(`${spin} `, 'genGlyph'), genName(gen.running.gen), ...at],
    ];
  } else if (asks === 'editor') {
    // Its question is in Neovim, where it was asked: the chat shows it, read-only.
    lefts = [[seg('? ', 'warn'), genName(gen.running.gen), seg(' asks in Neovim', 'text'), ...queued], [seg('? ', 'warn'), genName(gen.running.gen), seg(' asks', 'text')]];
  } else if (gen.running && gen.running.state === 'asking' && !asks) {
    // Not at work yet: it finds its place and reads the brief.
    lefts = [[seg(`${spin} `, 'genGlyph'), genName(gen.running.gen), seg(' starting', 'text'), ...queued], [seg(`${spin} `, 'genGlyph'), genName(gen.running.gen)]];
  } else {
    const looked = presence?.looked ? ` · looked at ${presence.looked} moment${presence.looked === 1 ? '' : 's'}, spoke ${presence.spoke}` : '';
    const last = presence?.lastAt ? ` · ${ago(presence.lastAt, now)}` : '';
    const watching = [seg('◉ ', 'watcher'), seg(role === 'scout' ? 'watching, as Scout' : 'watching', 'text')];
    lefts = [
      [...watching, ...(looked || last ? [seg(`${looked}${last}`, 'dim')] : [])],
      ...(looked && last ? [[...watching, seg(last, 'dim')]] : []),
      ...(looked || last ? [watching] : []),
      ...(role === 'scout' ? [[seg('◉ ', 'watcher'), seg('Scout', 'text')]] : []),
    ];
    // A request done, with something left to take: what, first; it gives way before the watching does.
    if (gen.ready) {
      const ready = [seg(' · ', 'dim'), genName(gen.ready.gen), seg(`: ${gen.ready.text}`, 'text')];
      lefts = [[...watching, ...ready], ...lefts];
    }
  }
  // Pair works on something else while a request is at work: the request goes after it.
  if (gen.running && ['thinking', 'tool', 'remark'].includes(activity.state) && connection === 'up') {
    const after = [seg(' · ', 'dim'), genName(gen.running.gen), seg(gen.running.state === 'generating' ? ' generating' : asks ? ' asks' : ' starting', 'text')];
    lefts = [...lefts.map(left => [...left, ...after]), ...lefts];
  }
  // What came while the answer streams waits under it, and says so: nothing above the words you read moves.
  const waits = heldText(held);
  // In a narrow pane the seconds give way before it does.
  if (waits) {
    const held = left => [...left, seg(' · ', 'dim'), seg(waits, 'text')];
    lefts = [...lefts.map(held), ...lefts.map(left => held(left.filter(part => !since.includes(part)))), ...lefts];
  }
  const right = [];
  if (connection === 'up') {
    if (scrolled) right.push(seg(`↓ ${scrolled} line${scrolled === 1 ? '' : 's'} below`, 'text'));
    else if (down.length) right.push(seg('! ', 'warn'), seg(`${down.join(', ')} not answering`, 'text'));
    else {
      if (model) right.push(seg(model, 'dim'));
      if (turn?.ms) right.push(seg(`${model ? ' · ' : ''}${(turn.ms / 1000).toFixed(1)}s`, 'dim'));
      if (turn?.tokens) right.push(seg(` · ${turn.tokens >= 1000 ? `${(turn.tokens / 1000).toFixed(1)}k` : turn.tokens} tok`, 'dim'));
      if (turn?.cost) right.push(seg(` · $${turn.cost < 0.01 ? turn.cost.toFixed(4) : turn.cost.toFixed(2)}`, 'dim'));
    }
  }
  // What Pair does comes first: the right side gives way, from its end, before the words get shorter.
  // (A model that does not answer goes whole or not at all.)
  const rights = right.map((_, n) => right.slice(0, right.length - n)).filter(r => r.at(-1).text !== '! ');
  return fittedRule([...rights.map(r => [lefts[0], r]), ...lefts.map(left => [left, []])], width);
}

/** The keys that work now, for the footer. */
export function footerKeys(view) {
  const {mode = 'idle', busy, editorEmpty = true, selectedEntry, confirming, about, scroll = 0, connection = 'up', menu} = view;
  const k = (keys, what, style = 'bold', short = what) => [keys, what, style, short];
  if (mode === 'help') return [k('↑↓ PgUp PgDn', 'scroll'), k('any other key', 'closes this')];
  if (mode === 'search') return [k('↑↓', 'older/newer'), k('Enter', 'keep'), k('Esc', 'close')];
  if (mode === 'menu') return [k('↑↓', 'choose'), k('Tab', 'complete'), k('Enter', {file: 'inserts', keep: 'keeps'}[menu?.kind] ?? 'run'), k('Esc', 'close')];
  if (mode === 'select' && selectedEntry?.kind === 'gen' && cardKeys(selectedEntry.card).length) {
    // A gen card: its own keys, as its action line has them (k there takes the code at the cursor, as a does).
    const keys = [k('c', 'copy'), ...cardKeys(selectedEntry.card).map(([, shown, what]) => k(shown, what, 'bold', what.split(' ')[0]))];
    if (selectedEntry.meta?.place) keys.push(k('j', 'jump'));
    keys.push(k('Esc', 'back'));
    return keys;
  }
  if (mode === 'select' && relayActions(selectedEntry).length) {
    return [k('c', 'copy'), ...relayActions(selectedEntry).map(([, shown, what]) => k(shown, what)), k('Esc', 'back')];
  }
  if (mode === 'select' && selectedEntry) {
    const keys = [k('c', 'copy')];
    if (selectedEntry.meta?.suggestion && !selectedEntry.applied) keys.push(k('a', 'apply'));
    if (selectedEntry.meta?.place) keys.push(k('j', 'jump'));
    if (selectedEntry.meta?.remark) keys.push(k('+/-', 'rate'), k('m', 'mute'), k('f', 'follow up'), k('e', 'explain'));
    if (selectedEntry.kind === 'tool' || selectedEntry.folded) keys.push(k('Enter', selectedEntry.expanded ? 'fold' : 'unfold'));
    keys.push(k('Esc', 'back'));
    return keys;
  }
  // Away, nothing sends: what you type waits in the input.
  if (connection === 'away') return editorEmpty ? [k('Ctrl-D', 'close'), k('?', 'keys')] : [k('Alt-Enter', 'newline'), k('Tab', 'complete')];
  if (confirming && editorEmpty) return view.confirmHint ? [k('y', 'yes', 'answer'), k('n', 'no', 'answer'), k('Esc', 'no')] : [k('y', 'allow', 'answer'), k('n', 'decline', 'answer'), k('Esc', 'decline')];
  if (confirming) return [k('Enter', 'answers'), k('Esc', view.confirmHint ? 'no' : 'decline')];
  const keys = [];
  if (busy) keys.push(k('Esc', 'stop'));
  if (scroll && editorEmpty) keys.push(k('End', 'latest'));
  if (about) keys.push(k('Esc', 'drop the follow-up'));
  if (editorEmpty) keys.push(k('/', 'commands', 'bold', 'cmds'), k('@', 'files'), k('Alt-↑', 'messages', 'bold', 'pick'), k('?', 'keys'));
  else keys.push(k('Enter', 'send'), k('Alt-Enter', 'newline'), k('Tab', 'complete'));
  return keys;
}

/**
 * The footer: the keys of footerKeys, as many as fit, in their short words when the long ones do not all fit. On a
 * picked message, its time on the right.
 */
export function footerLine(view, width) {
  const at = view.mode === 'select' ? view.selectedEntry?.at : null;
  const time = at ? [seg(when(at, view.now ?? Date.now()), 'dim')] : [];
  const room = width - (time.length ? lineWidth(time) + 2 : 0);
  const line = short => {
    const out = [seg(' ')];
    for (const [keys, what, style, brief] of footerKeys(view)) {
      const part = [seg(keys, style), seg(` ${short ? brief : what}`, 'dim')];
      const sep = out.length > 1 ? [seg(' · ', 'dim')] : [];
      if (lineWidth(out) + lineWidth(sep) + lineWidth(part) > room) return {out, whole: false};
      out.push(...sep, ...part);
    }
    return {out, whole: true};
  };
  const long = line(false);
  const {out} = long.whole ? long : line(true);
  return time.length ? spread(out, time, width) : out;
}

/** `label` (an @path) in `width` columns: it loses its start, a folder at a time (@…/retry/backoff.go). */
export function cutStart(label, width) {
  if (textWidth(label) <= width) return label;
  const at = label.startsWith('@') ? '@' : '';
  const parts = label.slice(at.length).split('/');
  for (let i = 1; i < parts.length; i++) {
    const tail = `${at}…/${parts.slice(i).join('/')}`;
    if (textWidth(tail) <= width) return tail;
  }
  const end = [...parts.at(-1)].reverse();
  let out = '';
  for (const char of end) {
    if (textWidth(at + '…' + char + out) > width) break;
    out = char + out;
  }
  return `${at}…${out}`;
}

export const MENU_ROWS = 7;

/** The first of `count` items the menu shows, `rows` at a time, so that the `chosen` one is in sight. */
export const menuStart = (count, chosen, rows = MENU_ROWS) => Math.max(0, Math.min(chosen - rows + 1, count - rows));

/**
 * The menu over the input: `items` as {label, args, detail}, `rows` of them from the one that keeps the `chosen` one
 * in sight, marked; the label, the arguments and what it does each in a column of their own, and a last line for
 * what is above and below. Files lose their start, not their end.
 */
export function menuLines(items, chosen, width, {kind = 'command', rows = MENU_ROWS} = {}) {
  const first = menuStart(items.length, chosen, rows);
  const shown = items.slice(first, first + rows);
  const most = items.some(item => item.detail) ? Math.floor(width / 2) : width - 3;
  const labelWidth = Math.min(Math.max(...items.map(item => textWidth(item.label)), 4) + 2, most);
  const longest = Math.max(0, ...items.map(item => textWidth(item.args ?? '')));
  const argsWidth = longest ? Math.min(longest + 2, Math.max(0, Math.floor((width - 3 - labelWidth) / 2))) : 0;
  const lines = shown.map((item, i) => {
    const mark = first + i === chosen;
    const label = (['file', 'keep'].includes(kind) ? cutStart(item.label, labelWidth - 1) : fitText(item.label, labelWidth - 1)).padEnd(labelWidth);
    const args = item.args && textWidth(item.args) > argsWidth - 2 ? `${fitText(item.args, argsWidth - 3)}…` : item.args ?? '';
    return clipLine([
      seg(mark ? ' ▸ ' : '   ', mark ? 'accent' : 'dim'), seg(label, mark ? 'accentBold' : 'bold'),
      ...(argsWidth ? [seg(args.padEnd(argsWidth), 'text')] : []), seg(item.detail ?? '', 'dim'),
    ], width);
  });
  const above = first;
  const below = items.length - first - shown.length;
  if (above || below) lines.push([seg('   '), seg([...(above ? [`↑ ${above} more`] : []), ...(below ? [`↓ ${below} more`] : [])].join(' · '), 'dim')]);
  return lines;
}

/** The line over the menu: what it lists, and how many of them it shows when not all. */
function menuRule(kind, count, width, title = null) {
  const more = count > MENU_ROWS ? ` · ${MENU_ROWS} of ${count} · type to narrow` : '';
  const name = kind === 'file' ? ' files ' : kind === 'keep' ? ` ${title ?? 'files to keep'}${more} ` : ` commands${more} `;
  return clipLine([seg('╶─', 'rule'), seg(name, 'dim'), seg('─'.repeat(Math.max(0, width - textWidth(name) - 2)), 'rule')], width);
}

/**
 * Pair's head, as on the site: a CRT in the accent, two green eyes and a magenta antenna, in quadrant blocks. Four
 * rows, whatever the words beside it do.
 */
export const HEAD = [
  [seg('   '), seg('▗▖', 'antenna')],
  [seg('▗▛▀▀▀▀▜▖', 'accent')],
  [seg('▐', 'accent'), seg(' '), seg('▀', 'eyes'), seg('  '), seg('▀', 'eyes'), seg(' '), seg('▌', 'accent')],
  [seg('▝▙▄▄▄▄▟▘', 'accent')],
];
const HEAD_AT = 3; // the head's column…
const WORDS_AT = HEAD_AT + 8 + 2; // …and its words'

/** What the pane shows before anything is said: Pair's head and what it does, then how to talk to it. */
export function emptyLines(width) {
  // The words start on the frame's row, beside the head, and end by the measure; where the title does not fit beside
  // it whole, they go under it.
  const title = inlineTokens('Pair · your pair in the second chair', 'text', {markdown: false});
  const beside = Math.min(width, MEASURE) - WORDS_AT >= lineWidth(wrapTokens(title, Infinity)[0]);
  const at = beside ? WORDS_AT : HEAD_AT;
  const room = Math.min(width, MEASURE) - at;
  title[0] = {...title[0], style: 'accentBold'};
  const words = [
    ...wrapTokens(title, room),
    ...wrapTokens(inlineTokens('It watches you work and speaks rarely: a line in Neovim, more here when you ask.', 'text', {markdown: false}), room),
  ];
  const indent = n => seg(' '.repeat(n));
  const top = HEAD.map(row => [indent(HEAD_AT), ...row]);
  if (beside) words.forEach((line, i) => (top[i + 1] ? top[i + 1].push(indent(2), ...line) : top.push([indent(at), ...line])));
  else top.push(...words.map(line => [indent(at), ...line]));
  // A key, then what it does; a /command or @here in it in the accent, as Pair's own words show code.
  const key = (keys, what) => wrapTokens(
    inlineTokens(what, 'text', {markdown: false}).map(token => (/^[/@][a-z]/.test(token.text) ? {...token, style: 'accent'} : token)),
    width, [seg(' '.repeat(HEAD_AT)), seg(keys.padEnd(8), 'bold')], [seg(' '.repeat(HEAD_AT + 8))],
  );
  return [
    ...top,
    blank(),
    ...key('Enter', 'ask anything'),
    ...key('/', 'commands · /drive hands it the keyboard'),
    ...key('@', 'a file, or @here for your selection'),
    ...key('Alt-↑', 'pick a message: copy, apply, jump, rate'),
    ...key('?', 'every key'),
  ].map(line => clipLine(line, width));
}

/** The keys and commands, for ? and /help: `commands` as [name, args, what]. */
export function helpLines(commands, width) {
  const keys = [
    ['Enter', 'send · Alt-Enter or Ctrl-J: a new line'],
    ['↑ ↓', 'move in what you type, else what you sent before'],
    ['Esc', 'stop Pair\'s answer · close a menu · leave a message'],
    ['Tab', 'complete a /command or an @file'],
    ['Alt-↑ Alt-↓', 'pick a message, then:'],
    ['  c a j', 'copy it · apply its suggestion · jump to its line'],
    ['  + - m', 'rate the remark useful or noise · mute its kind'],
    ['  f e', 'ask a follow-up about it · explain it'],
    ['  k d u', 'on a gen card: keep · drop · undo; Enter opens it in Neovim'],
    ['  Enter', 'unfold a long message or the tool lines'],
    ['PgUp PgDn', 'scroll; the mouse wheel too · End: back down'],
    ['Ctrl-F', 'find in the conversation; ↑ ↓ go from match to match'],
    ['Alt-L', 'quiet → normal → chatty'],
    ['Alt-M', 'mouse on or off (off: select text with it)'],
    ['Ctrl-C', 'stop, or clear; twice on an empty line: close'],
  ];
  // The left column is 15 wide, with at least one space after what it names: a command too long for it goes without
  // its arguments, and a name too long even so on a line of its own, with its words under it.
  const two = (left, right, leftStyle = 'bold') => {
    const words = inlineTokens(right, 'text', {markdown: false});
    if (`  ${left}`.length >= 15) return [[seg(`  ${left}`, leftStyle)], ...wrapTokens(words, width, [seg(' '.repeat(15))], [seg(' '.repeat(15))])];
    return wrapTokens(words, width, [seg(`  ${left}`.padEnd(15), leftStyle)], [seg(' '.repeat(15))]);
  };
  const label = (name, args) => (args && name.length + args.length + 1 <= 12 ? `${name} ${args}` : name);
  return [
    [seg(' Keys', 'accentBold')],
    ...keys.flatMap(([left, right]) => two(left, right)),
    blank(),
    [seg(' Commands', 'accentBold'), seg(' · anything else is a question for Pair', 'text')],
    ...commands.flatMap(([name, args, what]) => two(label(name, args), what)),
  ].map(line => clipLine(line, width));
}

/**
 * The whole frame, `height` lines of `width`: the header in its rule, conversation (or the empty card, or the help),
 * menu, the status in its rule, input and footer; painted with `look`. Returns {lines, cursor, transcript: {height, total, ranges}}.
 */
export function renderFrame(view, {width, height, look = {color: false}}) {
  if (width < 24 || height < 8) {
    const lines = Array.from({length: height}, (_, i) => (i === Math.floor(height / 2) ? paintLine(clipLine([seg(' Pair: too small', 'dim')], width), look) : ''));
    return {lines, cursor: null, transcript: {height: 0, total: 0, ranges: []}};
  }
  const top = [headerLine(view.header ?? {}, width)];
  // What you type: after the prompt, wrapped, at most six rows, the cursor's row in sight.
  const prompt = view.confirming ? 'y/N › ' : '› ';
  const inputWidth = width - textWidth(prompt) - 1;
  const layout = view.editor.layout(inputWidth);
  const shown = Math.min(6, layout.rows.length);
  const first = Math.max(0, Math.min(layout.row - shown + 1, layout.rows.length - shown));
  const input = layout.rows.slice(first, first + shown).map((row, i) => [
    seg(i === 0 && first === 0 ? prompt : ' '.repeat(textWidth(prompt)), 'accent'),
    seg(row, 'text'),
  ]);
  if (view.editor.empty && view.placeholder) input[0].push(seg(view.placeholder, 'dim'));
  if (view.about) input.unshift(clipLine([seg('↳ ', 'accent'), seg('follow-up on: ', 'dim'), seg(view.about, 'text')], width));
  // While you find, the find row stands where you type (what you typed waits there).
  if (view.mode === 'search') input.splice(0, input.length, [seg(' find: ', 'accent'), seg(view.search ?? '', 'bold'), seg(view.searchNote ? `  ${view.searchNote}` : '', 'dim')]);
  const bottom = [statusLine({...view, scrolled: view.mode === 'help' ? 0 : view.scroll ?? 0}, width), ...input, footerLine(view, width)];
  const menu = view.menu?.items?.length ? [menuRule(view.menu.kind, view.menu.items.length, width, view.menu.title), ...menuLines(view.menu.items, view.menu.chosen, width, {kind: view.menu.kind})] : [];
  const middle = Math.max(1, height - top.length - bottom.length - menu.length);

  let body;
  let transcript = {height: middle, total: 0, ranges: []};
  if (view.mode === 'help') {
    const help = helpLines(view.commands ?? [], width);
    body = help.slice(view.helpScroll ?? 0, (view.helpScroll ?? 0) + middle);
  } else {
    const {lines, ranges} = transcriptLines(view.entries, width, {selected: view.selected, query: view.mode === 'search' ? view.search : view.query, found: view.found, latestRemark: view.latestRemark, latestCard: view.latestCard, latestRelay: view.latestRelay, now: view.now});
    const card = view.showEmpty ? [blank(), ...emptyLines(width), blank()] : [];
    const all = [...card, ...lines];
    const offset = card.length;
    transcript = {height: middle, total: all.length, ranges: ranges.map(r => ({...r, start: r.start + offset, end: r.end + offset, ...(r.found !== undefined ? {found: r.found + offset} : {})}))};
    const end = Math.max(0, all.length - (view.scroll ?? 0));
    body = all.slice(Math.max(0, end - middle), end);
  }
  while (body.length < middle) body.unshift(blank());
  const lines = [...top, ...body, ...menu, ...bottom].slice(0, height).map(line => paintLine(clipLine(line, width), look));
  const cursorRow = height - 1 - 1 - (shown - 1 - (layout.row - first));
  const cursor = view.mode === 'help' ? null : view.mode === 'search'
    ? {row: height - 2, column: Math.min(width - 1, 7 + textWidth(view.search ?? ''))}
    : {row: cursorRow, column: Math.min(width - 1, textWidth(prompt) + layout.column)};
  return {lines, cursor, transcript};
}
