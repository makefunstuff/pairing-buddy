// The search trail: what the user searched for in Neovim's pickers since they last edited, and what they opened.
// Searches that end in nothing, or the same words again, are scent gone cold: the user's words are not the code's.
// Only a trail goes to the models, and only with a remark about it; `:Pair trail` shows the same lines.
import {execFile} from 'node:child_process';

export const TRAIL = {
  windowMs: 4 * 60_000, // a hunt for one thing: searches this close together, with no edit between them
  settleMs: 3000, // a trail is looked at once the user has paused this long after its last search
  min: 3,
};

const MATCH_LINES = 3; // per query, of the project's matches the Partner gets
const GREP_MS = 3000;

/** The searches since the user's last edit and within the window: one hunt for one thing. */
export function currentTrail(state, now) {
  return state.searches.filter(search => search.at > state.lastEditAt && now - search.at <= TRAIL.windowMs);
}

const sameWords = query => query.trim().toLowerCase().replace(/\s+/g, ' ');

/** The queries searched more than once in `trail`. */
export function repeats(trail) {
  const seen = new Map();
  for (const search of trail) seen.set(sameWords(search.query), (seen.get(sameWords(search.query)) ?? 0) + 1);
  return [...seen].filter(([, times]) => times > 1).map(([query]) => query);
}

/**
 * Whether `trail` looks lost: at least TRAIL.min searches, and one closed with nothing opened or the same words
 * searched again. Three searches that each opened a file are the user finding their way, not losing it.
 */
export function lost(trail) {
  return trail.length >= TRAIL.min && (trail.some(search => !search.file) || repeats(trail).length > 0);
}

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : noun.endsWith('h') ? 'es' : 's'}`;

/** One search as a line: `Live Grep "give up": 0 results, closed with nothing opened`. */
export function searchLine(search) {
  const results = search.results === null || search.results === undefined ? '' : `${plural(search.results, 'result')}, `;
  const end = search.file ? `opened ${search.file}${search.line ? `:${search.line}` : ''}` : 'closed with nothing opened';
  return `${search.picker} "${search.query}": ${results}${end}`;
}

/** The trail as the models see it, a line per search, oldest first. */
export const trailLines = trail => trail.map(search => `- ${searchLine(search)}`).join('\n');

/** What the trail looks like in one sentence, for `:Pair trail`. */
export function trailSummary(trail) {
  if (!trail.length) return 'No searches since your last edit.';
  const seconds = Math.round((trail.at(-1).at - trail[0].at) / 1000);
  const parts = [`${plural(trail.length, 'search')} in ${seconds} s since your last edit`];
  const empty = trail.filter(search => !search.file).length;
  if (empty) parts.push(`${empty} closed with nothing opened`);
  for (const query of repeats(trail)) parts.push(`"${query}" more than once`);
  return `${parts.join('; ')}.`;
}

const rg = (root, args) => new Promise(resolve => {
  execFile('rg', args, {cwd: root, timeout: GREP_MS, maxBuffer: 1 << 20}, (error, stdout) => {
    resolve(error && error.code !== 1 ? null : stdout.split('\n').filter(Boolean));
  });
});

/**
 * What the project has for each query of `trail`: file names and lines that contain its words, as ripgrep finds
 * them without regard to case. The Partner of a Navigator cannot search, and the words the code does not have
 * are half the story.
 */
export async function trailMatches(root, trail) {
  const queries = [...new Set(trail.map(search => search.query.trim()).filter(Boolean))];
  const files = (await rg(root, ['--files'])) ?? [];
  const lines = await Promise.all(queries.map(async query => {
    const named = files.filter(file => file.toLowerCase().includes(query.toLowerCase())).slice(0, MATCH_LINES);
    const found = await rg(root, ['--fixed-strings', '--ignore-case', '--line-number', '--no-heading', '--color', 'never',
      '--max-columns', '160', '--max-count', '2', '--', query, '.']);
    if (!found) return `"${query}": could not search`;
    const matches = found.slice(0, MATCH_LINES).map(line => `  ${line.replace(/^\.\//, '')}`);
    const more = found.length > MATCH_LINES ? `  (${found.length - MATCH_LINES} more)` : null;
    if (!named.length && !matches.length) return `"${query}": nothing in the project`;
    return [`"${query}":${named.length ? ` files ${named.join(', ')}` : ''}`, ...matches, ...(more ? [more] : [])].join('\n');
  }));
  return `What the project has for those words (ripgrep, any case):\n${lines.join('\n')}`;
}
