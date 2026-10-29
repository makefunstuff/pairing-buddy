// A board task's branch as a guided review (board stage 2b): :Pair review BDY-80, Alt-r on a relayed "ready to
// merge" line, or /review BDY-80 in the chat. The branch's files show in the review list (:Pair gen list), each as a
// proposal: on top what its agent and reviewer said (Shepherdr's ready summary and facts line), the brief's ≠ check
// run on the branch, and the files in the order the brief makes them matter. Enter shows a file's diff, read only; k
// keeps a file, or one hunk of it, in the user's own checkout, unsaved, as code not theirs yet (┊, origin board:<id>),
// which /undo takes back as one. The branch is read from git, never changed, and nothing is written to the board but
// on a pick that names what it does: a tell, "merge it" told to the task's agent (Shepherdr has no approve), or
// archive, offered once pieces were kept, since merging the whole branch would then bring them in twice.
import {execFile} from 'node:child_process';
import {join, relative} from 'node:path';
import {promisify} from 'node:util';
import {briefEmpty, CHECK_PROMPT, checkInput, parseCheck, quotePlace, readBrief} from './brief.mjs';
import {Board, commandLine} from './board.mjs';
import {hunksOf, linesOf, placeHunks, sizeOf} from './gen-tree.mjs';
import {gitBaseBranch} from './git.mjs';
import {takenMarks} from './owning.mjs';

const run = promisify(execFile);
const FILES = 300; // a review lists at most this many files of the branch
const CHECKED_FILES = 20; // the ≠ brief check reads the changes of this many of them, the first in the review's order
const CHECKED_LINES = 600; // and at most this many lines of those changes in all, with their context
const CHECKED_HUNK = 80; // of which at most this many for one change
const CONTEXT = 3; // lines around each hunk of a file's diff
const REVIEW_DAYS = 7; // a review of the same task and commit opened again within this long is the same one
const DAY = 24 * 60 * 60 * 1000;
const VERBS = new Set(['tell', 'merge', 'archive']);

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

async function git(root, args) {
  const {stdout} = await run('git', ['-C', root, ...args], {timeout: 10_000, maxBuffer: 64 << 20});
  return stdout;
}

/** The text of `path` at commit `rev`, or null when it has none there. */
const textAt = (root, rev, path) => git(root, ['show', `${rev}:${path}`]).catch(() => null);

/**
 * What a task's facts line says, as Shepherdr's agents write it (`PR #31 · commit 1a2b3c4 · checks passed (npm test)
 * · review: 2 rounds, 1 major fixed, 2 minor left (…) · decided: … · not proven: …`, failures first): `review`, the
 * reviewer's part; `checks`; and the `notes`, every other part but the PR, branch and commit, which the review shows
 * elsewhere. All null or empty for a task without facts.
 */
export function reviewFacts(facts) {
  const parts = (facts ?? '').split(/\s+·\s+/).map(part => part.trim()).filter(Boolean);
  const found = {review: null, checks: null, notes: []};
  for (const part of parts) {
    if (/^(PR #?\d+|pull request|branch\s|commit\s)/i.test(part)) continue;
    if (!found.review && /^review(ed)?\b/i.test(part)) found.review = part;
    else if (!found.checks && /^(checks?|tests?)\b/i.test(part)) found.checks = part;
    else found.notes.push(part);
  }
  return found;
}

/**
 * Where in `text` each of the branch's files `rels` is first named: by its path, or by its file name where only one
 * of them has it. Map rel -> index.
 */
export function namedAt(text, rels) {
  const at = new Map();
  if (!text) return at;
  const names = new Map();
  for (const rel of rels) {
    const name = rel.split('/').at(-1);
    names.set(name, names.has(name) ? null : rel);
  }
  const quoted = word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const rel of rels) {
    const name = rel.split('/').at(-1);
    const forms = [rel, ...(names.get(name) === rel && name !== rel ? [name] : [])];
    for (const form of forms) {
      const found = new RegExp(`(^|[\\s\`'"(/])${quoted(form)}(?=$|[\\s\`'"):,.;])`, 'm').exec(text);
      const index = found ? found.index + found[1].length : -1;
      if (found && (!at.has(rel) || index < at.get(rel))) at.set(rel, index);
    }
  }
  return at;
}

/**
 * The branch's files in the order the brief makes them matter: those the brief's check found against it first, then
 * those the task's brief or the note names, in the order they are named, then those the reviewer's facts name; the
 * rest after them, the bigger changes first. `files` are {rel, added, removed}; `named` and `found` map a file to
 * where it is named.
 */
export function orderFiles(files, {against = new Set(), found = new Map(), named = new Map()} = {}) {
  const rank = file => (against.has(file.rel) ? 0 : named.has(file.rel) ? 1 : found.has(file.rel) ? 2 : 3);
  const within = file => (rank(file) === 1 ? named.get(file.rel) : rank(file) === 2 ? found.get(file.rel) : -(file.added + file.removed));
  return [...files].sort((a, b) => rank(a) - rank(b) || within(a) - within(b) || a.rel.localeCompare(b.rel));
}

/** Lines `a` with hunks `ks` (indexes into `hunks`, from hunksOf(a, …)) applied, the others left out. */
export function withHunks(a, hunks, ks) {
  const out = [];
  let at = 0;
  hunks.forEach((hunk, k) => {
    if (!ks.has(k)) return;
    out.push(...a.slice(at, hunk.from), ...hunk.lines);
    at = hunk.to;
  });
  return [...out, ...a.slice(at)];
}

/**
 * What the branch changed in a file, as the ≠ brief check reads it: each change's new lines with CONTEXT lines around
 * them, as `{line, text}` where `line` is the first one's number in `next`, and a change of only deleted lines as its
 * context. At most `max` lines each; overlapping ones are one.
 */
export function changedSpans(base, next, max = CHECKED_HUNK) {
  const b = linesOf(next);
  const spans = [];
  let shift = 0;
  for (const hunk of hunksOf(linesOf(base), b)) {
    const start = hunk.from + shift; // the change's first line in next, 0-based
    shift += hunk.lines.length - (hunk.to - hunk.from);
    const from = Math.max(0, start - CONTEXT);
    const to = Math.min(b.length, start + hunk.lines.length + CONTEXT, from + max);
    const last = spans.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else if (to > from) spans.push({from, to});
  }
  return spans.map(({from, to}) => ({line: from + 1, text: b.slice(from, Math.min(to, from + max)).join('\n')}));
}

/**
 * A file's diff from `base` to `next` (texts; base '' for a new file) as the review shows it: the lines of a unified
 * diff, CONTEXT lines around each hunk, and where each hunk is in them: {lines, hunks: [{k, first, last}]}, 1-based.
 */
export function diffView(base, next) {
  const a = linesOf(base);
  const b = linesOf(next);
  const hunks = hunksOf(a, b);
  const lines = [];
  const at = [];
  let shift = 0; // b's line numbers run this far from a's, after the hunks so far
  let shown = 0; // a's lines shown so far: the context of one hunk does not show again in the next
  hunks.forEach((hunk, k) => {
    const from = Math.max(hunk.from - CONTEXT, shown);
    const to = Math.min(hunk.to + CONTEXT, a.length, hunks[k + 1]?.from ?? a.length);
    const before = a.slice(from, hunk.from);
    const after = a.slice(hunk.to, to);
    const oldCount = before.length + (hunk.to - hunk.from) + after.length;
    const newCount = before.length + hunk.lines.length + after.length;
    lines.push(`@@ -${from + 1},${oldCount} +${from + shift + 1},${newCount} @@`);
    const first = lines.length;
    lines.push(...before.map(line => ` ${line}`), ...a.slice(hunk.from, hunk.to).map(line => `-${line}`), ...hunk.lines.map(line => `+${line}`), ...after.map(line => ` ${line}`));
    at.push({k, first, last: lines.length});
    shift += hunk.lines.length - (hunk.to - hunk.from);
    shown = to;
  });
  return {lines, hunks: at};
}

export class Reviews {
  /** The board task reviews of `gen` (a Gen): its session, ledger and marks are theirs too. */
  constructor(gen) {
    this.gen = gen;
    this.pending = new Map(); // ledger entry -> its ≠ brief check, while it runs
    this.locks = new Map(); // ledger entry -> the last change of it booked or waiting: keeps and the check, one at a time
  }

  /**
   * Runs `change()` once the changes of review `action` before it are done: each reads the entry as the last left it
   * and books it whole, so two keeps (or a keep and the ≠ check) never place a hunk twice or drop the other's pieces.
   */
  locked(action, change) {
    const done = (this.locks.get(action) ?? Promise.resolve()).then(change);
    const settled = done.catch(() => {});
    this.locks.set(action, settled);
    settled.then(() => { if (this.locks.get(action) === settled) this.locks.delete(action); });
    return done;
  }

  get session() { return this.gen.session; }

  get root() { return this.gen.root; }

  get board() {
    if (this.adapter?.command !== this.gen.board) this.adapter = this.gen.board ? new Board(this.gen.board) : null;
    return this.adapter;
  }

  said(text) {
    return this.gen.said(text);
  }

  /** The review booked as ledger entry `action`, as {entry, request, pieces} (see Gen.piecesOf), or null. */
  found(action) {
    const found = this.gen.piecesOf(action);
    return found.entry?.kind === 'generated' && found.entry.data?.shape === 'review' && found.entry.root === this.root ? found : null;
  }

  /** The open reviews of task `id` of the last REVIEW_DAYS days, newest first. */
  reviewsOf(id) {
    return this.session.store.actions(this.root, this.session.now() - REVIEW_DAYS * DAY)
      .filter(row => row.kind === 'generated' && row.data?.shape === 'review' && row.data.task === id).reverse();
  }

  /**
   * Opens task `id`'s branch as a review: read from the board (`task show`: its branch, pull request, ready summary,
   * facts and brief) and from git in this repository (the files its branch changes since it left the branch it merges
   * into). Booked as one ledger entry, the same one again while the branch has no new commit; Neovim's review list
   * opens on it, and the chat gets what the reviewer said. The ≠ brief check runs after, by itself.
   */
  async open(task) {
    const id = typeof task === 'string' ? task.trim() : '';
    if (!this.board) return this.said('There is no board to review a task of ("board": null in the config).');
    if (!/^[\w:-]{1,40}$/.test(id)) return this.said('Say which task to review: :Pair review BDY-80, or /review BDY-80.');
    let shown;
    try {
      shown = await this.board.show(id);
    } catch (error) {
      return this.said(`No review of ${id}: ${error.code === 'ENOENT' ? `the board's command (${this.board.command}) is not installed` : error.message}.`);
    }
    if (!shown.branch) return this.said(`${id} has no branch yet: nothing to review.`);
    const head = (await git(this.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${shown.branch}^{commit}`]).catch(() => '')).trim();
    if (!head) return this.said(`${id}'s branch ${shown.branch} is not in this repository: open its review in a Neovim of ${shown.space ?? 'its space'}.`);
    const base = await gitBaseBranch(this.root);
    if (!base) return this.said(`${id}: this repository has no main branch to compare ${shown.branch} with.`);
    const since = (await git(this.root, ['merge-base', base, head]).catch(() => '')).trim();
    if (!since) return this.said(`${id}: ${shown.branch} has no commit in common with ${base}.`);
    const again = this.reviewsOf(id).find(row => row.data.head === head);
    if (again) {
      this.gen.rebook(again.id, this.found(again.id), {status: shown.status, pr: shown.pr});
      return this.show(again.id, {again: true});
    }
    const files = await this.filesOf(since, head);
    if (!files.length) return this.said(`${id}: ${shown.branch} changes nothing against ${base}.`);
    const facts = reviewFacts(shown.facts);
    const brief = await this.briefOf(shown);
    const rels = files.map(file => file.rel);
    const named = namedAt([shown.brief ?? '', ...(brief?.note?.lines ?? [])].join('\n'), rels);
    const found = namedAt([...(facts.review ? [facts.review] : []), ...facts.notes].join('\n'), rels);
    const order = orderFiles(files, {found, named});
    const pieces = order.map((file, i) => ({
      i, kind: 'branch', file: join(this.root, file.rel), rel: file.rel, status: file.status, binary: file.binary,
      added: file.added, removed: file.removed, hunks: file.hunks, line: 1, state: 'proposed',
      ...(named.has(file.rel) ? {named: true} : {}), ...(found.has(file.rel) ? {found: true} : {}),
    }));
    const kept = this.session.ledger.add('generated', `review ${id} · ${shown.title}`, {
      data: {
        shape: 'review', gen: null, task: id, title: shown.title, branch: shown.branch, base, head, since, pr: shown.pr, status: shown.status,
        note: `${plural(files.length, 'file')} to review`, undo: false,
      },
      detail: {words: shown.title, pieces, review: {said: shown.said, ...facts}, brief: shown.brief, contradicts: [], guessed: [], debrief: []},
    });
    if (kept === undefined || kept === null) return this.said(`${id}: Pair could not book the review.`);
    this.pending.set(kept, this.checkBrief(kept, shown, brief).finally(() => this.pending.delete(kept)));
    return this.show(kept);
  }

  /** The brief the branch runs against: the goal, the reviewed task and the note, as /gen's (see brief.mjs). */
  briefOf(task) {
    const {session} = this;
    return readBrief({
      root: this.root, pin: this.gen.pin, fallback: this.gen.briefName, goal: session.state.goal, task: {id: task.id, title: task.title},
      read: path => session.bufferText(path),
    }).catch(() => null);
  }

  /** The files `head` changes since `since`: {rel, status A|M|D, binary, added, removed, hunks}, at most FILES. */
  async filesOf(since, head) {
    const listed = (await git(this.root, ['diff', '--no-renames', '--name-status', '-z', since, head])).split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i + 1 < listed.length && files.length < FILES; i += 2) {
      const [status, rel] = [listed[i][0], listed[i + 1]];
      const before = status === 'A' ? '' : await textAt(this.root, since, rel);
      const after = status === 'D' ? '' : await textAt(this.root, head, rel);
      const binary = [before, after].some(text => text === null || text.includes('\0'));
      const size = binary ? {added: 0, removed: 0} : sizeOf(status === 'A' ? null : before, after);
      files.push({rel, status: ['A', 'D'].includes(status) ? status : 'M', binary, ...size, hunks: binary ? 0 : hunksOf(linesOf(before), linesOf(after)).length});
    }
    return files;
  }

  /** The review `action` in Neovim's review list, opened on it; the chat says what the reviewer said. */
  show(action, {again = false} = {}) {
    const {entry, pieces} = this.found(action);
    const {task, title, branch, pr} = entry.data;
    const {review = {}} = entry.detail ?? {};
    const files = pieces.filter(piece => piece.kind === 'branch');
    const opened = this.session.notify('editor', {type: 'gen_list_open', action});
    const lines = [
      `review ${task} · ${title} · ${branch} · ${plural(files.length, 'file')}${pr ? ` · ${pr}` : ''}${again ? ' · as you left it' : ''}`,
      ...(review.said ? [`its agent: ${review.said}`] : []),
      review.review ? `reviewer: ${review.review}${review.checks ? ` · ${review.checks}` : ''}` : review.checks ?? 'no review in its facts',
      ...(review.notes ?? []).map(note => `· ${note}`),
    ];
    const hint = opened ? 'In Neovim, :Pair gen list: Enter shows a file\'s diff, k keeps it (or, in the diff, one hunk) unsaved in yours, t tells its agent, a asks it to merge.'
      : 'No Neovim now: :Pair gen list shows it once one connects. Nothing is kept or told from here.';
    this.session.message('pair', lines.join('\n'), {hint});
    this.gen.sendCard?.(action);
    return '';
  }

  /**
   * The ≠ brief check of review `action`: the brief's check (brief.mjs) on what the branch changed, the changes of
   * the first CHECKED_FILES files in the review's order, each with its context and its own line numbers, CHECKED_LINES
   * lines in all. What holds up is booked with the review, and its files go first.
   */
  async checkBrief(action, task, brief) {
    const {askModel} = this.gen;
    if (!askModel || !brief || briefEmpty(brief)) return;
    const found = this.found(action);
    const {since} = found.entry.data;
    const pieces = [];
    let lines = 0;
    for (const piece of found.pieces.filter(one => one.kind === 'branch' && one.status !== 'D' && !one.binary).slice(0, CHECKED_FILES)) {
      const texts = await this.textsOf(found.entry, piece);
      for (const span of texts ? changedSpans(texts.base, texts.next) : []) {
        const shown = linesOf(`${span.text}\n`).slice(0, CHECKED_LINES - lines);
        if (!shown.length) break;
        pieces.push({file: piece.file, line: span.line, insert: false, text: shown.join('\n')});
        lines += shown.length;
      }
    }
    if (!pieces.length) return;
    let check;
    try {
      check = parseCheck(await askModel(CHECK_PROMPT, checkInput(brief, `${task.title} (board task ${task.id}, its whole branch)`, pieces, this.root)), brief, pieces, this.gen.exceptions);
    } catch (error) {
      return this.session.log(`review ${task.id}: checking against the brief failed: ${error.message}`);
    }
    for (const item of check.contradicts) item.place = quotePlace(brief, item);
    await this.locked(action, () => this.bookCheck(action, task, check, since));
  }

  /** Books what the ≠ brief `check` of review `action` found: its lines, and its files first. */
  bookCheck(action, task, check, since) {
    const now = this.found(action);
    if (!now || since !== now.entry.data.since) return;
    const debrief = [
      ...check.contradicts.map(item => `≠ brief "${item.text}" ${item.place} · ${relative(this.root, item.file)}:${item.fileLine} ${item.why}`),
      ...check.guessed.map(text => `? guessed ${text}`),
    ];
    // The files the check found against the brief go first.
    const against = new Set(check.contradicts.map(item => relative(this.root, item.file)));
    const files = now.pieces.filter(one => one.kind === 'branch');
    const order = orderFiles(files, {against, found: new Map(files.filter(one => one.found).map(one => [one.rel, files.indexOf(one)])), named: new Map(files.filter(one => one.named).map(one => [one.rel, files.indexOf(one)]))});
    for (const piece of files) piece.order = order.indexOf(piece);
    for (const piece of files) if (against.has(piece.rel)) piece.against = check.contradicts.filter(item => relative(this.root, item.file) === piece.rel).length;
    this.session.ledger.update(action, {
      data: {...now.entry.data, note: `${now.entry.data.note}${check.contradicts.length ? ` · ≠${check.contradicts.length}` : ''}`},
      detail: {...now.entry.detail, pieces: now.pieces, contradicts: check.contradicts, guessed: check.guessed, debrief},
    });
    this.session.notify('editors', {type: 'gen_kept', task: task.id});
    if (debrief.length) this.session.message('pair', `review ${task.id} · against the brief:\n${debrief.join('\n')}`);
  }

  /** The texts of branch file `piece` of review `entry`: {base, next}, '' for the side a new or deleted file lacks. */
  async textsOf(entry, piece) {
    const {since, head} = entry.data;
    const base = piece.status === 'A' ? '' : await textAt(this.root, since, piece.rel);
    const next = piece.status === 'D' ? '' : await textAt(this.root, head, piece.rel);
    return base === null || next === null ? null : {base, next};
  }

  /** The hunks of branch file `i` of `found` that are kept now (taken, not undone): a Set of their indexes. */
  keptHunks(found, i) {
    return new Set(found.pieces.filter(one => one.kind === 'hunk' && one.source === i && one.state === 'taken').map(one => one.hunk));
  }

  /**
   * Enter on a file of review `action`: its diff, read only, as the editor shows it: {type: 'review_diff', action,
   * piece, task, name, title, lines, hunks: [{k, first, last, kept}]}, or {error}.
   */
  async diff(action, i) {
    const found = this.found(action);
    const piece = found?.pieces.find(one => one.kind === 'branch' && one.i === i);
    if (!piece) return {error: 'that file is not in the review any more'};
    const {task, branch, base} = found.entry.data;
    if (piece.binary) return {error: `${piece.rel} is not text: git diff ${base}...${branch} -- ${piece.rel} shows it`};
    const texts = await this.textsOf(found.entry, piece);
    if (!texts) return {error: `${piece.rel} cannot be read from ${branch}`};
    const view = diffView(texts.base, texts.next);
    const kept = this.keptHunks(found, i);
    const what = {A: 'new', D: 'deleted', M: 'changed'}[piece.status];
    return {
      type: 'review_diff', action, piece: i, task, name: piece.rel, file: piece.file, status: piece.status,
      title: `${task} · ${piece.rel} · ${what} on ${branch}`, lines: view.lines, hunks: view.hunks.map(hunk => ({...hunk, kept: kept.has(hunk.k)})),
    };
  }

  /**
   * k in the review list (a whole file) or in a file's diff (`hunk`, one of them): what the branch changes goes into
   * the user's checkout, unsaved, in their buffer as it is now, one hunk at a time; each is code not theirs yet, origin
   * board:<id>, which /undo takes back. A hunk on lines they changed since is left out, and said. A file the branch
   * deletes is not deleted: Pair deletes no file of the user's.
   */
  keep(action, i, hunk = null) {
    return this.locked(action, () => this.keepNow(action, i, hunk));
  }

  async keepNow(action, i, hunk) {
    const session = this.session;
    const found = this.found(action);
    const target = found?.pieces.find(one => one.kind === 'branch' && one.i === i);
    if (!target) return this.said('That file is not in the review any more.');
    const {task, branch} = found.entry.data;
    const name = target.rel;
    if (target.binary) return this.said(`${task}: ${name} is not text, so Pair does not keep it; git checkout ${branch} -- ${name} takes it as it is.`);
    if (target.status === 'D') return this.said(`${task}: ${branch} deletes ${name}; Pair deletes no file of yours, so delete it yourself if you want that.`);
    const texts = await this.textsOf(found.entry, target);
    if (!texts) return this.said(`${task}: ${name} cannot be read from ${branch}.`);
    const a = linesOf(texts.base);
    const hunks = hunksOf(a, linesOf(texts.next));
    const kept = this.keptHunks(found, i);
    const wanted = (hunk === null ? hunks.map((_, k) => k) : [hunk]).filter(k => k >= 0 && k < hunks.length && !kept.has(k));
    if (!wanted.length) return this.said(`${task}: ${name}${hunk === null ? '' : `, that change,`} is kept already.`);
    const origin = `board:${task}`;
    const made = [];
    let skipped = 0;
    let failure = null;
    for (const k of wanted) {
      // From the file as the branch has it with what is kept so far, to the same with hunk k too.
      const from = withHunks(a, hunks, kept);
      const to = withHunks(a, hunks, new Set([...kept, k]));
      const current = await session.bufferText(target.file).catch(() => (target.status === 'A' ? '' : null));
      if (current === null) {
        failure = `${name} is not in your checkout`;
        break;
      }
      const text = lines => (lines.length ? `${lines.join('\n')}\n` : '');
      const placed = placeHunks(text(from), text(to), current);
      if (placed.conflicts || !placed.hunks.length) {
        skipped++;
        continue;
      }
      const reply = await session.requestEditor({type: 'board_keep', file: target.file, origin, hunks: placed.hunks.map(({line, endLine, insert, text}) => ({line, endLine, insert, text}))})
        .catch(error => ({error: error.message}));
      if (!Array.isArray(reply?.kept)) {
        failure = reply?.error ?? 'no Neovim is connected to keep it in';
        break;
      }
      // Neovim applied them from the bottom up: a piece's lines move with what the pieces above it added or removed.
      const shift = j => reply.kept.reduce((sum, other, m) => sum + (placed.hunks[m]?.line < placed.hunks[j]?.line && other ? other.after.length - other.before.length : 0), 0);
      reply.kept.forEach((applied, j) => {
        const shape = placed.hunks[j] ?? placed.hunks[0];
        const one = {...applied, from: applied.from + shift(j), to: applied.to + shift(j)};
        const piece = {
          i: found.pieces.length, kind: 'hunk', file: target.file, line: shape.line, endLine: shape.endLine, insert: shape.insert, text: shape.text, old: shape.old,
          note: `${name} · ${k + 1} of ${hunks.length}`, source: i, hunk: k, state: 'taken',
          patch: {file: target.file, before: one.before, after: one.after}, from: one.from, to: one.to, marks: takenMarks(shape.text, one.from),
        };
        found.pieces.push(piece);
        made.push(piece);
      });
      kept.add(k);
    }
    if (!made.length) return this.said(`${task}: ${name}: nothing kept${failure ? `: ${failure}` : skipped ? `: you changed ${skipped === 1 ? 'those lines' : 'the lines of each change'} since; git show ${branch}:${name} has it` : ''}.`);
    const stopped = failure ? ` The rest was not kept: ${failure}.` : '';
    const warned = Boolean(found.entry.data.warned);
    const keptFiles = found.pieces.filter(one => one.kind === 'branch' && this.keptHunks(found, one.i).size).length;
    const files = found.pieces.filter(one => one.kind === 'branch').length;
    // changedAt: /undo takes back the newest change, and a review opened days ago may be kept from today.
    this.gen.rebook(action, found, {note: `${keptFiles} of ${plural(files, 'file')} kept`, undo: true, warned: true, changedAt: session.now()});
    session.ledger.update(action, {state: 'applied'});
    this.gen.sendMarks(action, task, made);
    session.notify('editors', {type: 'gen_kept', task});
    const lines = made.reduce((sum, piece) => sum + (piece.to - piece.from + 1), 0);
    const left = hunks.length - kept.size;
    const whole = left ? ` ${plural(left, 'change')} of it not kept${skipped ? ` (${skipped} on lines you changed since)` : ''}.` : '';
    const twice = warned ? '' : ` You kept pieces of ${task}: merging its whole branch now would bring them in twice. A in the list offers archive ${task}, to run or copy.`;
    return this.said(`${task}: ${name}: ${plural(made.length, 'change')}, ${plural(lines, 'line')}, kept unsaved in yours, marked ┊ as not yours yet. /undo takes them back.${whole}${stopped}${twice}`);
  }

  /**
   * t, a and A in a review: the board's words for `verb` on task `id`: 'tell' (`text`), 'merge' (a tell that asks its
   * agent to merge: Shepherdr has no approve, and Pair never runs `shepherdr merge`), 'archive'. With `run`, on the
   * pick that names it, the board runs them and the ledger books it; without, they come back as a command line to copy.
   * {line} or {said}, or {error}.
   */
  async boardDo({task, verb, text = '', run = false}) {
    const board = this.board;
    if (!board) return {error: 'there is no board ("board": null in the config)'};
    if (!VERBS.has(verb) || typeof task !== 'string' || !/^[\w:-]{1,40}$/.test(task)) return {error: 'no such board command'};
    const words = verb === 'tell' ? board.tellWords(task, `${text ?? ''}`.trim()) : verb === 'merge' ? board.mergeWords(task) : board.archiveWords(task);
    if (verb === 'tell' && !words.at(-1)) return {error: 'there is nothing to tell'};
    const line = commandLine(words);
    if (!run) return {line};
    try {
      const said = (await board.run(words.slice(1), {cwd: this.root})).trim();
      const booked = {tell: `told ${task}: ${words.at(-1)}`, merge: `told ${task} to merge it`, archive: `archived ${task}`}[verb];
      this.session.ledger.add('board', booked, {data: {task, verb}});
      if (verb === 'archive') for (const row of this.reviewsOf(task)) this.session.ledger.update(row.id, {data: {...row.data, archived: true}});
      this.session.notify('editors', {type: 'gen_kept', task});
      return {said: said || `${task}: done.`};
    } catch (error) {
      return {error: error.code === 'ENOENT' ? `the board's command (${board.command}) is not installed` : error.message};
    }
  }

  /** The review booked as `row`, as :Pair gen list shows it (see Gen.review). */
  row(row, entry) {
    const pieces = entry.detail?.pieces ?? [];
    const found = {pieces};
    const files = pieces.filter(piece => piece.kind === 'branch').sort((a, b) => (a.order ?? a.i) - (b.order ?? b.i));
    const kept = files.some(piece => this.keptHunks(found, piece.i).size);
    return {
      action: row.id, gen: null, shape: 'review', task: row.data.task, title: row.data.title, branch: row.data.branch, base: row.data.base,
      pr: row.data.pr ?? null, status: row.data.status ?? null, words: entry.detail?.words ?? row.text, at: row.at, state: row.state, note: row.data.note ?? '',
      running: false, checking: this.pending.has(row.id), archived: Boolean(row.data.archived), kept,
      review: entry.detail?.review ?? {}, files: [], changes: [],
      branch_files: files.map(piece => {
        const hunks = this.keptHunks(found, piece.i).size;
        return {
          piece: piece.i, name: piece.rel, file: piece.file, status: piece.status, binary: Boolean(piece.binary), added: piece.added ?? 0, removed: piece.removed ?? 0,
          hunks: piece.hunks ?? 0, kept: hunks, against: piece.against ?? 0, found: Boolean(piece.found), named: Boolean(piece.named),
        };
      }),
      contradicts: (entry.detail?.debrief ?? []).filter(line => line.startsWith('≠')),
      guessed: entry.detail?.guessed ?? [],
    };
  }
}
