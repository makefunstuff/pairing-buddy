// What the full-screen chat pane draws, from its state: the header (where you pair, on what, in which role and at
// which level), the conversation, the status row (what Pair does now), what you type, and a line of the keys that
// work now. Each message has a gutter with its time and who speaks: you, pair (answers), watch (what Pair said
// unasked), ·· (notes of the pane and the daemon), !! (errors); what Pair's tools did is a ⎿ line under the question.
// Pair's words are Markdown: code blocks, `code`, **bold**, lists and headings show as such, a suggestion as a diff.
// Everything here is pure: lines of segments in, lines of segments out (see chat-style.mjs), so it is tested as text.
import {clipLine, fitText, lineWidth, paintLine, textWidth} from './chat-style.mjs';

const seg = (text, style = 'text') => ({text, style});
const blank = () => [];

const LABELS = {you: 'you', pair: 'pair', watch: 'watch', system: '··', error: '!!', confirm: '?', note: '··'};
const LABEL_STYLES = {you: 'you', pair: 'pair', watch: 'watch', system: 'dim', error: 'errorBold', confirm: 'warn', note: 'dim'};
const NARROW = 52; // below this, the gutter goes above the words
const GUTTER = 13; // the selection bar, HH:MM, a space, the name in five, a space
const FOLD_OVER = 18; // a longer message folds to its start…
const FOLD_TO = 12; // …this long
const SPINNER = ['▖', '▘', '▝', '▗'];

/** What a tool did, in the past (the ⎿ line) and as it runs (the status row). Point and suggest show as messages. */
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
    if (code !== undefined) out.push({space, text: code, style: 'code'});
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
 * colon after it) wrap as one word; a word longer than a line is cut where it must be.
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
        const piece = fitText(text, Math.max(1, width - used));
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

/** One line of preformatted text cut into lines of `width`: the first after `prefix`, the others after `more`. */
function hardWrap(text, width, style, prefix = [], more = prefix) {
  const lines = [];
  let rest = text.replace(/\t/g, '    ');
  do {
    const lead = lines.length ? more : prefix;
    const part = fitText(rest, Math.max(1, width - lineWidth(lead))) || rest.slice(0, 1);
    lines.push([...lead, seg(part, style)]);
    rest = rest.slice(part.length);
  } while (rest);
  return lines;
}

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

/**
 * `text` as Markdown, in lines of segments at most `width` wide: fenced code (a bar on its left, not re-wrapped
 * at words; a diff in its colours), headings, lists with a hanging indent, quotes, and paragraphs with `code` in the
 * accent and **bold**. A line indented four spaces is code too, as Pair's notes write it.
 */
export function markdownLines(text, width, {base = 'text'} = {}) {
  const lines = [];
  let fence = null; // the language of the code block we are in, or null
  let blankBefore = false;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const fenceMatch = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(raw);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[2].toLowerCase() : null;
      blankBefore = false;
      continue;
    }
    if (fence !== null) {
      const style = fence === 'diff' ? diffStyle(raw) : 'text';
      lines.push(...hardWrap(raw || ' ', width, style, [seg('│ ', 'rule')]));
      blankBefore = false;
      continue;
    }
    if (!raw.trim()) {
      if (lines.length && !blankBefore) lines.push(blank());
      blankBefore = true;
      continue;
    }
    blankBefore = false;
    if (/^( {4}|\t)/.test(raw)) {
      lines.push(...hardWrap(raw.replace(/^( {4}|\t)/, ''), width, 'text', [seg('  ', 'text')]));
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      lines.push(...wrapTokens(inlineTokens(heading[1], 'bold').map(token => ({...token, style: token.style === 'code' ? 'code' : 'bold'})), width));
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (item) {
      const depth = Math.min(3, Math.floor(item[1].length / 2));
      const mark = /\d/.test(item[2]) ? `${item[2]} ` : '• ';
      const indent = '  '.repeat(depth);
      lines.push(...wrapTokens(inlineTokens(item[3], base), width, [seg(indent + mark, 'dim')], [seg(' '.repeat(textWidth(indent + mark)), 'text')]));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) {
      lines.push(...wrapTokens(inlineTokens(quote[1], 'dim'), width, [seg('▎ ', 'rule')]));
      continue;
    }
    lines.push(...wrapTokens(inlineTokens(raw.trim(), base), width));
  }
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
    return hardWrap(line, width, removed ? 'del' : 'add', [seg('│', 'rule'), seg(removed ? '- ' : '+ ', removed ? 'del' : 'add')], [seg('│  ', 'rule')]);
  };
  return lines.flatMap(side);
}

// Messages.

/** The lines of what `entry` says, `width` wide, without its gutter. */
export function bodyLines(entry, width, {continued = false} = {}) {
  const {kind, text = '', meta = {}} = entry;
  if (kind === 'tool') {
    const done = entry.tools.map(({tool, what}) => toolDone(tool, what));
    if (entry.expanded) return done.flatMap(line => hardWrap(line, width, 'dim', [seg('⎿ ', 'dim')]));
    return [clipLine([seg('⎿ ', 'dim'), seg(done.join(' · '), 'dim')], width)];
  }
  if (kind === 'confirm') {
    const lines = wrapTokens(inlineTokens(text, 'warn'), width);
    // A question with a hint of its own (a /gen request's) says what its answers do, not allow and decline.
    const answer = entry.answer === undefined ? (entry.hint ? [seg(entry.hint, 'dim')] : [seg('y', 'bold'), seg(' allow · ', 'dim'), seg('n', 'bold'), seg(' decline', 'dim')])
      : [seg(entry.hint ? 'you answered' : entry.answer ? 'you allowed it' : 'you declined', entry.answer || entry.hint ? 'ok' : 'dim')];
    return [...lines, answer];
  }
  if (kind === 'note') return text.split('\n').flatMap(line => hardWrap(line, width, 'dim'));
  if (kind === 'you') {
    const about = meta.about && entry.aboutText ? [[seg('↳ about: ', 'dim'), ...clipLine([seg(entry.aboutText, 'dim')], width - 9)]] : [];
    return [...about, ...plainLines(text, width)];
  }
  if (kind === 'system') return plainLines(text, width, 'dim');
  if (kind === 'error') return plainLines(text, width, 'error');
  // Pair's words: a remark says what about first; a suggestion shows as a diff under its first line.
  const lines = [];
  if (meta.trigger && !continued) {
    const head = [seg(meta.trigger.replace(/_/g, ' '), 'watchMeta')];
    if (meta.place) head.push(seg(` · ${meta.place.file}:${meta.place.line}`, 'watchMeta'));
    if (entry.verdict) head.push(seg(entry.verdict === 'useful' ? '  ✓ useful' : '  ✗ noise', entry.verdict === 'useful' ? 'ok' : 'dim'));
    lines.push(clipLine(head, width));
  }
  if (meta.suggestion) {
    const [first] = text.split('\n');
    const note = /suggestion: (.*)$/.exec(first)?.[1] ?? first;
    if (meta.place && !meta.trigger) lines.push(clipLine([seg('✎ suggested change · ', 'accent'), seg(`${meta.place.file}:${meta.place.line}`, 'accent')], width));
    lines.push(...markdownLines(note, width));
    lines.push(...diffLines(meta.suggestion, width));
    if (entry.applied) lines.push([seg('✓ taken', 'ok')]);
  } else {
    lines.push(...markdownLines(text, width));
  }
  if (entry.partial) {
    const last = lines.at(-1) ?? [];
    if (lines.length) lines[lines.length - 1] = [...last, seg(' ▍', 'accent')];
    else lines.push([seg('▍', 'accent')]);
  }
  return lines;
}

/** Underlines what matches `query` in `line` (any case). */
function highlight(line, query) {
  if (!query) return line;
  const needle = query.toLowerCase();
  return line.flatMap(s => {
    const lower = s.text.toLowerCase();
    if (!lower.includes(needle)) return [s];
    const parts = [];
    let at = 0;
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
      if (i > at) parts.push(seg(s.text.slice(at, i), s.style));
      parts.push(seg(s.text.slice(i, i + needle.length), 'match'));
      at = i + needle.length;
    }
    if (at < s.text.length) parts.push(seg(s.text.slice(at), s.style));
    return parts;
  });
}

/** Whether `entry` matches the search `query`. */
export const matches = (entry, query) => Boolean(query) && searchText(entry).toLowerCase().includes(query.toLowerCase());

/** All the text of `entry`, as search and copy see it. */
export function searchText(entry) {
  if (entry.kind === 'tool') return entry.tools.map(({tool, what}) => toolDone(tool, what)).join('\n');
  const diff = entry.meta?.suggestion ? `\n${entry.meta.suggestion.new.join('\n')}` : '';
  return `${entry.text ?? ''}${diff}`;
}

/** Whether `entry` starts a new turn in the gutter: another speaker than `previous`, or another minute. */
function startsTurn(entry, previous) {
  if (entry.kind === 'tool') return false;
  if (!previous) return true;
  return previous.kind !== entry.kind || clock(previous.at) !== clock(entry.at) || Boolean(entry.meta?.remark && entry.meta.remark !== previous.meta?.remark);
}

/**
 * The lines of the whole conversation `width` wide, and where each message is among them ({start, end}, end
 * exclusive). `selected` is the index of the selected message, `query` what search looks for, `latestRemark`
 * the index of the remark whose rating keys the pane shows.
 */
export function transcriptLines(entries, width, {selected = -1, query = '', latestRemark = -1} = {}) {
  const narrow = width < NARROW;
  const lines = [];
  const ranges = [];
  let previous = null;
  entries.forEach((entry, index) => {
    const turn = startsTurn(entry, previous);
    const quiet = kind => ['system', 'note'].includes(kind);
    const spaced = entry.kind !== 'tool' && previous && (turn || !(quiet(entry.kind) && quiet(previous.kind)));
    if (spaced && lines.length) lines.push(blank());
    const start = lines.length;
    const bar = seg(index === selected ? '▌' : ' ', 'bar');
    const label = LABELS[entry.kind] ?? '';
    const head = turn && label ? [seg(entry.at ? clock(entry.at) : '     ', 'dim'), seg(' '), seg(narrow ? label : label.padEnd(5), LABEL_STYLES[entry.kind])] : null;
    const bodyWidth = Math.max(8, narrow ? width - 3 : width - GUTTER - 1);
    const continued = Boolean(entry.meta?.remark && entry.meta.remark === previous?.meta?.remark);
    let body = bodyLines(entry, bodyWidth, {continued});
    if (!entry.expanded && entry.kind !== 'tool' && body.length > FOLD_OVER) {
      const hidden = body.length - FOLD_TO;
      body = [...body.slice(0, FOLD_TO), [seg(`… ${hidden} more lines · ${index === selected ? 'Enter' : 'Alt-↑ and Enter'} shows all`, 'dim')]];
    }
    if (index === latestRemark && !entry.verdict) body.push([seg('+', 'bold'), seg(' useful · ', 'dim'), seg('-', 'bold'), seg(' noise · ', 'dim'), seg('Alt-↑', 'bold'), seg(' more', 'dim')]);
    if (query && matches(entry, query)) body = body.map(line => highlight(line, query));
    if (narrow) {
      if (head) lines.push([bar, ...head]);
      for (const line of body) lines.push([bar, seg('  '), ...line]);
    } else {
      body.forEach((line, i) => {
        const gutter = i === 0 && head ? [...head, seg(' ')] : [seg(' '.repeat(GUTTER - 1))];
        lines.push([bar, ...gutter, ...line]);
      });
      if (!body.length && head) lines.push([bar, ...head]);
    }
    ranges.push({start, end: lines.length});
    previous = entry;
  });
  return {lines: lines.map(line => clipLine(line, width)), ranges};
}

// The pane's other parts.

/** The header: where you pair and on what, then the role and the level, on the right. */
export function headerLine({project, goal, role, level, muted = []}, width) {
  const right = [seg(role ?? '', 'dim'), seg(' · ', 'dim'), seg(level ?? '', 'dim'), ...(muted.length ? [seg(` · ${muted.length} muted`, 'dim')] : [])];
  const left = [seg(' pair', 'accentBold'), ...(project ? [seg(` · ${project}`, 'bold')] : []), ...(goal ? [seg(` · ${goal}`, 'text')] : [])];
  return spread(left, role ? [...right, seg(' ')] : [], width);
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

/**
 * The status row: what Pair does now on the left (with a spinner while it works), and on the right the model, how
 * long its last answer took and what it cost, or that you scrolled up.
 */
export function statusLine(view, width) {
  const {activity = {state: 'idle'}, presence, connection = 'up', now = Date.now(), frame = 0, turn, model, scrolled = 0, role, keepWheel} = view;
  const spin = SPINNER[frame % SPINNER.length];
  const since = activity.since ? ` · ${duration(now - activity.since)}` : '';
  let left;
  if (connection === 'connecting') left = [seg('… connecting to the pair daemon', 'dim')];
  else if (connection === 'away') left = [seg('⚠ the pair daemon went away · reconnecting', 'warn')];
  else if (activity.state === 'thinking') left = [seg(`${spin} `, 'accent'), seg('thinking', 'accentBold'), seg(`${since} · `, 'dim'), seg('Esc', 'bold'), seg(' stops', 'dim')];
  else if (activity.state === 'tool') left = [seg(`${spin} `, 'accent'), seg(`${DOING[activity.tool] ?? activity.tool} `, 'accentBold'), seg(activity.what ?? '', 'text'), seg(since, 'dim')];
  else if (activity.state === 'remark') left = [seg(`${spin} `, 'dim'), seg(`looking at ${(activity.what ?? 'a moment').replace(/_/g, ' ')}`, 'dim'), seg(since, 'dim')];
  else if (activity.state === 'waiting') left = [seg('? ', 'warn'), seg('Pair waits for your answer: ', 'warn'), ...(activity.hint ? [seg(activity.hint, 'dim')] : [seg('y', 'bold'), seg(' allow · ', 'dim'), seg('n', 'bold'), seg(' decline', 'dim')])];
  else if (role === 'driver') left = [seg('◆ ', 'accent'), seg(keepWheel ? 'Pair keeps the wheel · any key in Neovim takes it back' : 'Pair drives', 'accent')];
  else {
    const looked = presence?.looked ? ` · looked at ${presence.looked} moment${presence.looked === 1 ? '' : 's'}, spoke ${presence.spoke}` : '';
    const last = presence?.lastAt ? ` · ${ago(presence.lastAt, now)}` : '';
    left = [seg('◇ ', 'accent'), seg(role === 'scout' ? 'watching, as Scout' : 'watching', 'dim'), seg(`${looked}${last}`, 'dim')];
  }
  const right = [];
  if (connection !== 'up') return spread([seg(' '), ...left], [], width);
  if (scrolled) right.push(seg(`↓ ${scrolled} line${scrolled === 1 ? '' : 's'} below · End`, 'warn'));
  else {
    if (model) right.push(seg(model, 'dim'));
    if (turn?.ms) right.push(seg(`${model ? ' · ' : ''}${(turn.ms / 1000).toFixed(1)}s`, 'dim'));
    if (turn?.tokens) right.push(seg(` · ${turn.tokens >= 1000 ? `${(turn.tokens / 1000).toFixed(1)}k` : turn.tokens} tok`, 'dim'));
    if (turn?.cost) right.push(seg(` · $${turn.cost < 0.01 ? turn.cost.toFixed(4) : turn.cost.toFixed(2)}`, 'dim'));
  }
  // What Pair does comes first: the right side gives way, from its end.
  const head = [seg(' '), ...left];
  while (right.length && lineWidth(head) + lineWidth(right) + 2 > width) right.pop();
  if (right.length && right[0].text.startsWith(' · ')) right[0] = {...right[0], text: right[0].text.slice(3)};
  return spread(head, right.length ? [...right, seg(' ')] : [], width);
}

/** The keys that work now, for the footer. */
export function footerKeys(view) {
  const {mode = 'idle', busy, editorEmpty = true, selectedEntry, confirming, about} = view;
  const k = (keys, what) => [keys, what];
  if (mode === 'help') return [k('↑↓ PgUp PgDn', 'scroll'), k('any other key', 'closes this')];
  if (mode === 'search') return [k('type', 'to find'), k('↑↓', 'older/newer'), k('Enter', 'keep'), k('Esc', 'close')];
  if (mode === 'menu') return [k('↑↓', 'choose'), k('Tab', 'complete'), k('Enter', 'run'), k('Esc', 'close')];
  if (mode === 'select' && selectedEntry) {
    const keys = [k('c', 'copy')];
    if (selectedEntry.meta?.suggestion && !selectedEntry.applied) keys.push(k('a', 'apply'));
    if (selectedEntry.meta?.place) keys.push(k('j', 'jump'));
    if (selectedEntry.meta?.remark) keys.push(k('+/-', 'rate'), k('m', 'mute'), k('f', 'follow up'), k('e', 'explain'));
    if (selectedEntry.kind === 'tool' || selectedEntry.folded) keys.push(k('Enter', selectedEntry.expanded ? 'fold' : 'unfold'));
    keys.push(k('Esc', 'back'));
    return keys;
  }
  if (confirming && editorEmpty) return view.confirmHint ? [k('y', 'yes'), k('n', 'no'), k('or type', 'an answer')] : [k('y', 'allow'), k('n', 'decline'), k('or type', 'an answer')];
  const keys = [];
  if (busy) keys.push(k('Esc', 'stop'));
  if (about) keys.push(k('Esc', 'drop the follow-up'));
  if (editorEmpty) keys.push(k('/', 'commands'), k('@', 'files'), k('Alt-↑', 'messages'), k('?', 'keys'));
  else keys.push(k('Enter', 'send'), k('Alt-Enter', 'newline'), k('Tab', 'complete'));
  return keys;
}

/** The footer: the keys of footerKeys, as many as fit. */
export function footerLine(view, width) {
  const out = [seg(' ')];
  for (const [keys, what] of footerKeys(view)) {
    const part = [seg(keys, 'bold'), seg(` ${what}`, 'dim')];
    const sep = out.length > 1 ? [seg(' · ', 'dim')] : [];
    if (lineWidth(out) + lineWidth(sep) + lineWidth(part) > width) break;
    out.push(...sep, ...part);
  }
  return out;
}

/** The menu over the input: `items` as {label, detail}, the `chosen` one marked. */
export function menuLines(items, chosen, width) {
  const labelWidth = Math.min(Math.max(...items.map(item => textWidth(item.label)), 4) + 2, Math.floor(width / 2));
  return items.map((item, i) => {
    const mark = i === chosen;
    const label = fitText(item.label, labelWidth - 1).padEnd(labelWidth);
    return clipLine([seg(mark ? ' ▸ ' : '   ', mark ? 'accent' : 'dim'), seg(label, mark ? 'accentBold' : 'bold'), seg(item.detail ?? '', 'dim')], width);
  });
}

/** The line over the menu: what it lists. */
function menuRule(kind, width) {
  const name = kind === 'file' ? ' files ' : ' commands ';
  return clipLine([seg('╶─', 'rule'), seg(name, 'dim'), seg('─'.repeat(Math.max(0, width - name.length - 2)), 'rule')], width);
}

/** What the pane shows before anything is said: what Pair does, and how to talk to it. */
export function emptyLines(width) {
  const text = (words, style = 'dim', first = [seg('  ')], rest = [seg('  ')]) => wrapTokens(inlineTokens(words, style, {markdown: false}), width, first, rest);
  const key = (keys, words) => text(words, 'dim', [seg(`  ${keys.padEnd(7)}`, 'bold')], [seg(' '.repeat(9))]);
  const mascot = ['▗▄▄▖ ', '▐▘▝▌ ', '▝▀▀▘ '];
  const intro = text('It watches you work and speaks rarely: a line in Neovim, more here when you ask.', 'dim', [seg('       ')], [seg('       ')]);
  const top = [[seg('  '), seg(mascot[0], 'accent'), seg('Pair', 'accentBold'), seg(' · your pair in the second chair')], ...intro];
  top.forEach((line, i) => {
    if (i > 0 && i < mascot.length) line.splice(0, 1, seg('  '), seg(mascot[i], 'accent'));
  });
  return [
    ...top,
    blank(),
    [seg('  Ask anything below; '), seg('Enter', 'bold'), seg(' sends.')],
    ...key('/', 'commands: /drive hands it the keyboard, /scout gives it a pane'),
    ...key('@', 'a file, or @here for what you selected in Neovim'),
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
    ['  Enter', 'unfold a long message or the tool lines'],
    ['PgUp PgDn', 'scroll; the mouse wheel too · End: back down'],
    ['Ctrl-F', 'find in the conversation'],
    ['Alt-L', 'quiet → normal → chatty'],
    ['Alt-M', 'mouse on or off (off: select text with it)'],
    ['Ctrl-C', 'stop, or clear; twice on an empty line: close'],
  ];
  // The left column is 15 wide, with at least one space after what it names: a command too long for it goes without its arguments.
  const two = (left, right, leftStyle = 'bold') => wrapTokens(inlineTokens(right, 'dim', {markdown: false}), width, [seg(`  ${left}`.padEnd(15), leftStyle)], [seg(' '.repeat(15))]);
  const label = (name, args) => (args && name.length + args.length + 1 <= 12 ? `${name} ${args}` : name);
  return [
    [seg(' Keys', 'accentBold')],
    ...keys.flatMap(([left, right]) => two(left, right)),
    blank(),
    [seg(' Commands', 'accentBold'), seg(' · anything else is a question for Pair', 'dim')],
    ...commands.flatMap(([name, args, what]) => two(label(name, args), what)),
  ].map(line => clipLine(line, width));
}

/**
 * The whole frame, `height` lines of `width`: header, conversation (or the empty card, or the help), menu, rule,
 * status, input and footer; painted with `look`. Returns {lines, cursor, transcript: {height, total, ranges}}.
 */
export function renderFrame(view, {width, height, look = {color: false}}) {
  if (width < 24 || height < 8) {
    const lines = Array.from({length: height}, (_, i) => (i === Math.floor(height / 2) ? paintLine(clipLine([seg(' Pair: too small', 'dim')], width), look) : ''));
    return {lines, cursor: null, transcript: {height: 0, total: 0, ranges: []}};
  }
  const top = [headerLine(view.header ?? {}, width), rule(width)];
  // What you type: after the prompt, wrapped, at most six rows, the cursor's row in sight.
  const prompt = view.confirming ? 'y/N › ' : '› ';
  const inputWidth = width - textWidth(prompt) - 1;
  const layout = view.editor.layout(inputWidth);
  const shown = Math.min(6, layout.rows.length);
  const first = Math.max(0, Math.min(layout.row - shown + 1, layout.rows.length - shown));
  const input = layout.rows.slice(first, first + shown).map((row, i) => [
    seg(i === 0 && first === 0 ? prompt : ' '.repeat(textWidth(prompt)), view.confirming ? 'warn' : 'accent'),
    seg(row, 'text'),
  ]);
  if (view.editor.empty && view.placeholder) input[0].push(seg(view.placeholder, 'dim'));
  if (view.about) input.unshift(clipLine([seg('↳ ', 'accent'), seg('follow-up on: ', 'dim'), seg(view.about, 'text')], width));
  if (view.search !== undefined && view.mode === 'search') input.unshift([seg(' find: ', 'accent'), seg(view.search, 'bold'), seg(view.searchNote ? `  ${view.searchNote}` : '', 'dim')]);
  const bottom = [rule(width), statusLine(view, width), ...input, footerLine(view, width)];
  const menu = view.menu?.items?.length ? [menuRule(view.menu.kind, width), ...menuLines(view.menu.items, view.menu.chosen, width)] : [];
  const middle = Math.max(1, height - top.length - bottom.length - menu.length);

  let body;
  let transcript = {height: middle, total: 0, ranges: []};
  if (view.mode === 'help') {
    const help = helpLines(view.commands ?? [], width);
    body = help.slice(view.helpScroll ?? 0, (view.helpScroll ?? 0) + middle);
  } else {
    const {lines, ranges} = transcriptLines(view.entries, width, {selected: view.selected, query: view.mode === 'search' ? view.search : view.query, latestRemark: view.latestRemark});
    const card = view.showEmpty ? [blank(), ...emptyLines(width), blank()] : [];
    const all = [...card, ...lines];
    const offset = card.length;
    transcript = {height: middle, total: all.length, ranges: ranges.map(r => ({start: r.start + offset, end: r.end + offset}))};
    const end = Math.max(0, all.length - (view.scroll ?? 0));
    body = all.slice(Math.max(0, end - middle), end);
  }
  while (body.length < middle) body.unshift(blank());
  const lines = [...top, ...body, ...menu, ...bottom].slice(0, height).map(line => paintLine(clipLine(line, width), look));
  const cursorRow = height - 1 - 1 - (shown - 1 - (layout.row - first));
  const cursor = view.mode === 'help' ? null : view.mode === 'search'
    ? {row: height - 1 - shown - (view.about ? 1 : 0) - 1, column: Math.min(width - 1, 7 + textWidth(view.search ?? ''))}
    : {row: cursorRow, column: Math.min(width - 1, textWidth(prompt) + layout.column)};
  return {lines, cursor, transcript};
}
