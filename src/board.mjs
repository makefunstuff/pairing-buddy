// The work board, Shepherdr, behind one small adapter: what Pair reads of it (its spaces, their tasks, a task's
// branch, pull request and report) and the few command lines it composes for you. Every call is the board's own
// command with a list of words, never a shell. Pair reads the board by itself; it writes to it only when you pick a
// choice that names what it does (/gen board's picks: add only, or add and delegate, with a plan first or for research
// only; in a task's review, a tell, "merge it" told to its agent, or archive), and it never merges, stops or sets
// anything.
import {execFile} from 'node:child_process';
import {basename} from 'node:path';

export const BOARD = 'shepherdr';
export const TITLE_MAX = 32; // the board refuses a longer title: it fits one line on a phone
export const MERGE_IT = 'merge it'; // what a review's merge pick tells the task's agent
const TIMEOUT_MS = 5000;
const ADD_TIMEOUT_MS = 60_000;
const REPORTS_LOOKED_AT = 20; // of a space's newest artifacts, this many are asked who made them // an add is never cut short: one that went through but answered late would be made twice

/**
 * Runs the board's `command` with `args`: its output, or an error whose message is what it said (the board writes its
 * refusals to stdout). `code` ENOENT means the command is not installed.
 */
export function boardRun(command, args, {cwd, timeoutMs = TIMEOUT_MS} = {}) {
  return new Promise((resolve, reject) => execFile(command, args, {cwd, timeout: timeoutMs, maxBuffer: 64 << 20}, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    const said = `${stdout ?? ''}`.trim() || `${stderr ?? ''}`.trim();
    reject(Object.assign(new Error(said || error.message), {code: error.code}));
  }));
}

/** The space a task's place names: `p:<machine>:pairing-buddy` is pairing-buddy. */
const spaceOf = place => (typeof place === 'string' && place.startsWith('p:') ? place.split(':').slice(2).join(':') : null);

/**
 * A task as Pair keeps it: {id, title, status, sub, machine}, and from `task show` also {space, branch, pr, outcome,
 * said, facts, brief}: what its agent said when it reported ready, its facts line (PR · commit · checks · review · not
 * proven), and its brief (`desc`, "No brief yet." for none).
 */
function taskOf(raw) {
  const task = {id: raw.id, title: raw.title ?? raw.name ?? raw.id, status: raw.status, sub: raw.sub ?? '', machine: raw.machine ?? null};
  if ('place' in raw || 'branch' in raw) {
    const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
    Object.assign(task, {
      space: spaceOf(raw.place), branch: raw.branch ?? null, pr: raw.pr?.url ?? null, outcome: raw.outcome ?? null,
      said: text(raw.said), facts: text(raw.facts), brief: raw.desc === 'No brief yet.' ? null : text(raw.desc),
    });
  }
  return task;
}

/**
 * What each pick of a hand-off does: whether the task's agent waits for a go (`later`: add only) or starts at once
 * (delegate), and what the brief then says in its own words. Pair adds only the pick the user named.
 */
export const PICKS = {
  add: {later: true},
  delegate: {later: false},
  plan: {later: false, says: 'Plan first: before you change any code, write your plan and wait for my go.'},
  research: {later: false, says: 'Research only: find out, and write it up as a report (an artifact). Change no code and open no pull request.'},
};

/** The lines of `space list`: `name  KEY  /path  github:o/r`, the home space `~  (home space)  /path`. */
export function parseSpaces(text) {
  return text.split('\n').map(line => line.split(/\s{2,}/)).filter(cols => cols.length >= 3 && cols[1] !== '(home space)')
    .map(([name, key, path, github]) => ({name, key, path, github: github?.replace(/^github:/, '') ?? null}));
}

/** The ids in `artifact list`'s lines (`a12  v2  Research report  · pairing-buddy · 2h`), newest first. */
export const artifactIds = text => text.split('\n').map(line => /^(\S+)\s{2}v\d+\s{2}/.exec(line)?.[1]).filter(Boolean);

/**
 * Whether `artifact show`'s text says task `id`'s agent or reviewer made it: its first line ends `by BDY-7 agent.`, and
 * each version names who made it (`  v1  2h  BDY-7 agent`). The list cannot say: it names the space a task's artifact
 * is kept in, not the task.
 */
export function madeBy(text, id) {
  const name = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${name} (?:agent|reviewer)(?=[\\s.]|$)`, 'm').test(text);
}

export class Board {
  /** `command` is the board's command (`shepherdr`, or a path). */
  constructor(command = BOARD, {timeoutMs = TIMEOUT_MS} = {}) {
    Object.assign(this, {command, timeoutMs});
  }

  run(args, {cwd} = {}) {
    return boardRun(this.command, args, {cwd, timeoutMs: this.timeoutMs});
  }

  /** The board's open tasks (not archived), of every space or of `space`. */
  async tasks({space = null} = {}) {
    const listed = JSON.parse(await this.run(['task', 'list', ...(space ? ['--space', space] : []), '--json']));
    if (!Array.isArray(listed)) throw new Error('task list --json is not a list');
    return listed.filter(task => !task.archived).map(taskOf);
  }

  /** One task, with its space, branch and pull request. */
  async show(id) {
    return taskOf(JSON.parse(await this.run(['task', 'show', id, '--json'])));
  }

  /** The spaces: [{name, key, path, github}], the home space left out (it holds no repo). */
  async spaces() {
    return parseSpaces(await this.run(['space', 'list']));
  }

  /**
   * The file of task `id`'s report: the newest artifact its agent or reviewer made, among the newest of its `space`
   * (a task's artifacts are kept in its space); null when it made none.
   */
  async report(id, {space = null} = {}) {
    const ids = artifactIds(await this.run(['artifact', 'list', ...(space ? [`--space=${space}`] : [])]));
    for (const artifact of ids.slice(0, REPORTS_LOOKED_AT)) {
      const shown = await this.run(['artifact', 'show', artifact]);
      if (madeBy(shown, id)) return shown.match(/^HTML: (.+)$/m)?.[1].trim() ?? null;
    }
    return null;
  }

  /**
   * The words that add a task: `title` (cut to TITLE_MAX), `brief`, in `space`. `later`, its agent reads the brief and
   * waits for a go (add only); without, it starts at once (add and delegate). Each option is one word, `--brief=…`:
   * the board reads `--brief` followed by a word that starts with `--` as a flag without its value.
   */
  addWords({title, brief, space = null, later = true}) {
    return [this.command, 'task', 'add', boardTitle(title), `--brief=${brief}`, ...(space ? [`--space=${space}`] : []), ...(later ? ['--later'] : [])];
  }

  /**
   * The words that hand a task to the board as `pick` (one of PICKS) says: add only, add and delegate, delegate with a
   * plan first, or delegate for research only. The board has no flag for a plan or research: the brief says it.
   */
  handoffWords({title, brief, space = null, pick}) {
    const {later, says = null} = PICKS[pick];
    return this.addWords({title, brief: says ? `${brief}\n\n${says}` : brief, space, later});
  }

  /** The words that tell task `id` something, which is also the go for a task that waits. */
  tellWords(id, text) {
    return [this.command, 'task', 'tell', id, text];
  }

  /**
   * The words that ask task `id`'s agent to merge it. Shepherdr has no approve: a task merges when its brief or the
   * owner says so, so this is a tell, and Pair never runs `shepherdr merge` itself.
   */
  mergeWords(id) {
    return this.tellWords(id, MERGE_IT);
  }

  /** The words that archive task `id`: out of every list, its record kept (a running agent is stopped first). */
  archiveWords(id) {
    return [this.command, 'task', 'archive', id];
  }

  /** Runs `words` (from addWords): the id of the task it added, and what the board said. */
  async add(words, {cwd} = {}) {
    const said = (await boardRun(this.command, words.slice(1), {cwd, timeoutMs: ADD_TIMEOUT_MS})).trim();
    return {id: said.match(/^Added ([\w:-]+):/)?.[1] ?? null, said};
  }
}

/** A title the board takes: one line, at most TITLE_MAX characters, cut at a word; no leading dash, which reads as a flag. */
export function boardTitle(text) {
  const line = text.replace(/\s+/g, ' ').trim().replace(/^-+\s*/, '');
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const words = /\s/.test(line[TITLE_MAX - 1]) ? cut : cut.replace(/\s+\S*$/, ''); // a word cut in two goes
  return `${words.trimEnd() || cut}…`;
}

/** `words` as one line to read and paste in a shell: each word quoted where it has to be, `--brief='…'` after its `=`. */
export function commandLine(words) {
  const quote = word => (/^[\w./:=@%+,-]*$/.test(word) && word ? word : `'${word.replace(/'/g, `'\\''`)}'`);
  return words.map(word => {
    const option = /^(--[\w-]+=)([\s\S]*)$/.exec(word);
    return option ? `${option[1]}${quote(option[2])}` : quote(word);
  }).join(' ');
}

/** The task number a branch is named for: 25 in `work/25-context-card` or `25-fix`; null for `main` or `release/2.0`. */
export function branchNumber(branch) {
  const number = branch?.match(/(?:^|\/)(\d+)(?:[-_]|$)/)?.[1];
  return number ? Number(number) : null;
}

/** The number of a board task: 82 in BDY-82. */
export const taskNumber = id => Number(id?.match(/-(\d+)$/)?.[1] ?? NaN);

/**
 * The space of a project, of the board's `spaces`: the one whose folder is the repo's main checkout, else the one
 * named as the repo is (`repos`, from repoNames). Null when the board does not know the repo.
 */
export function spaceFor(spaces, {repos = [], checkout = null}) {
  return spaces.find(space => checkout && space.path === checkout)
    ?? spaces.find(space => repos.includes(space.name) || repos.includes(basename(space.path)))
    ?? null;
}

// A task's status in words, as the context card and the chat's header say it.
const STATE = {need: 'needs you', ready: 'ready to merge', merging: 'merging', work: 'working', queued: 'queued', todo: 'to do', done: 'done', idle: 'idle', off: 'stopped'};
export const stateWords = status => STATE[status] ?? status ?? '';

/**
 * The board as it concerns a project: `task`, the one of its space whose number its branch has, and the space's other
 * tasks that are working and that wait for you. Null without a board, or when the board does not know the repo.
 */
export function boardContext(tasks, {space, branch}) {
  if (!tasks || !space) return null;
  const number = branchNumber(branch);
  const task = number === null ? null : tasks.find(each => taskNumber(each.id) === number) ?? null;
  const others = tasks.filter(each => each !== task);
  const brief = each => ({id: each.id, title: each.title});
  return {
    space,
    task: task && {id: task.id, title: task.title, state: stateWords(task.status), msg: task.sub ?? '', pr: task.pr ?? null},
    working: others.filter(each => ['work', 'merging'].includes(each.status)).length,
    waiting: others.filter(each => each.status === 'need').map(brief),
  };
}

/**
 * Whether a command line is the board launching one of its agents (the board typed it, not the user): the agent
 * gets an option naming a file of the board's own, as in `claude --settings ~/.shepherdr/…/hooks/x.settings.json`.
 */
export const boardLaunch = cmd => /(?:^|\s)--[\w-]+[= ]\S*(?:\.shepherdr\/\S*(?:hooks|prompts)\/|\.herdr-projects\/data\/tasks\/)/.test(cmd);
