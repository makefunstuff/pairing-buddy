// The ledger: everything Pair did in a project, one line each. What it read, said, pointed at, showed, suggested,
// searched, ran, typed, asked you and was refused, and the moments it stayed quiet. `:Pair today` in Neovim and
// /today in the chat list the day's. An edit of Pair's keeps the file's text before and after it, so it can be undone
// later, after other edits too: Neovim merges the undo into the buffer as it is now (see lua/pair/merge.lua).

const OUTPUT_CHARS = 20_000; // of a command's output, the ledger keeps the end
const TEXT_CHARS = 120; // of the words on one line of the list

/** How a kind of entry reads in the list. */
const LABELS = {quiet: 'stayed quiet'};

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const firstLine = text => {
  const line = text.trim().split('\n')[0];
  return line.length > TEXT_CHARS ? `${line.slice(0, TEXT_CHARS - 1)}…` : line;
};

/** A command's output as the ledger keeps it: its end, saying so when it is cut. */
export const keptOutput = output => (output.length > OUTPUT_CHARS ? `(earlier output cut)\n${output.slice(-OUTPUT_CHARS)}` : output);

/** The clock time of `at`, as 09:12. */
const clock = at => new Date(at).toTimeString().slice(0, 5);

/** Local midnight before `now`: where "today" starts. */
export function startOfDay(now) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export class Ledger {
  /** Books into `store` for session `sessionId`; `changed()` hears of each new or changed entry. */
  constructor({store, sessionId, changed = () => {}, now = Date.now}) {
    Object.assign(this, {store, sessionId, changed, now});
    this.last = null; // the entry booked last: {id, kind, text}
  }

  /**
   * Books one thing Pair did: `text` is its line in the list, `data` what the list shows besides (place, note,
   * result, remark, answer, undo), `detail` what the entry opens to. Reads in a row are one entry. Returns its id.
   */
  add(kind, text, {data = {}, detail = null} = {}) {
    if (kind === 'read' && this.last?.kind === 'read') {
      if (!this.last.text.split(', ').includes(text)) this.last.text = `${this.last.text}, ${text}`;
      this.update(this.last.id, {text: this.last.text, data});
      return this.last.id;
    }
    const id = this.store.addAction({sessionId: this.sessionId, at: this.now(), kind, text: firstLine(text), data, detail});
    this.last = {id, kind, text: firstLine(text)};
    this.changed();
    return id;
  }

  /** A moment Pair let pass: the gate's `reason`, and whether it was the budget (not the bar) that held it back. */
  quiet(trigger, reason, {budget = false} = {}) {
    return this.add('quiet', trigger, {data: {budget}, detail: {why: reason}});
  }

  /** Changes entry `id`: its `data` is merged into what it has, the rest replaced. */
  update(id, {data, ...rest}) {
    const merged = data ? {data: {...this.store.action(id).data, ...data}} : {};
    this.store.updateAction(id, {...rest, ...merged});
    this.changed();
  }
}

/** The text of a run of quiet entries: how many, and what held them back. */
function quietText(entries) {
  const budget = entries.filter(entry => entry.data.budget).length;
  const parts = [[entries.length - budget, 'under the bar'], [budget, 'over the budget']].filter(([count]) => count);
  const moments = plural(entries.length, 'moment');
  if (parts.length === 1) return `${moments} ${parts[0][1]}`;
  return `${moments}: ${parts.map(([count, what]) => `${count} ${what}`).join(', ')}`;
}

const same = (a, b) => a.kind === b.kind && a.text === b.text && a.data.note === b.data.note && a.data.result === b.data.result;

/**
 * The entries as the list shows them, oldest first: quiet moments in a row are one line, and so are runs of one
 * command in a row with the same result. Each row has `ids`, the entries it stands for.
 */
export function ledgerRows(entries) {
  const rows = [];
  for (const entry of entries) {
    const row = rows.at(-1);
    if (row && entry.kind === 'quiet' && row.kind === 'quiet') {
      row.entries.push(entry);
      continue;
    }
    if (row && entry.kind === 'ran' && same(row.entries.at(-1), entry)) {
      row.entries.push(entry);
      continue;
    }
    rows.push({kind: entry.kind, entries: [entry]});
  }
  return rows.map(({kind, entries}) => {
    const last = entries.at(-1);
    const count = entries.length > 1 && kind === 'ran' ? ` · ${entries.length} times` : '';
    return {
      ...last.data,
      id: last.id,
      ids: entries.map(entry => entry.id),
      time: clock(entries[0].at),
      kind,
      label: LABELS[kind] ?? kind,
      text: kind === 'quiet' ? quietText(entries) : last.text,
      note: last.data.note ? `${last.data.note}${count}` : count.slice(3) || undefined,
      state: last.state ?? undefined,
      verdict: last.verdict ?? undefined,
      more: entries.some(entry => entry.more),
    };
  });
}

const duration = ms => {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};

/** Today's ledger of `root`: its rows, and one line that sums it up. */
export function today(store, root, now) {
  const since = startOfDay(now);
  const rows = ledgerRows(store.actions(root, since));
  const verdicts = store.verdicts(root, since);
  const useful = verdicts.filter(verdict => verdict === 'useful').length;
  const summary = `${plural(rows.length, 'thing')} · ${plural(verdicts.length, 'remark')}, ${useful} useful · ${duration(store.activeMs(since))}`;
  return {rows, summary};
}

/** What the entries `ids` of `root` open to, as a title and lines of text; null when there is nothing to show. */
export function ledgerDetail(store, root, ids) {
  const entries = ids.map(id => store.action(id)).filter(entry => entry?.root === root && entry.detail);
  if (!entries.length) return null;
  const last = entries.at(-1);
  if (last.kind === 'quiet') {
    return {title: 'why it stayed quiet', text: entries.map(entry => `${clock(entry.at)}  ${entry.text}: ${entry.detail.why}`).join('\n')};
  }
  if (last.detail.output !== undefined) return {title: last.text, text: last.detail.output || '(no output)'};
  if (last.detail.words) return {title: 'what it said', text: last.detail.words};
  return null;
}

/** How the state of a row reads in the chat, which cannot act on it. */
function chatState(row) {
  if (row.state === 'undone') return 'undone';
  if (row.state === 'applied') return 'accepted';
  if (row.verdict) return row.verdict === 'dismissed' ? 'noise' : row.verdict;
  if (row.answer) return `you said ${row.answer}`;
  return '';
}

/** Today's ledger as lines for the chat pane. */
export function ledgerText({rows, summary}) {
  if (!rows.length) return ['Pair has done nothing here today.'];
  const width = Math.max(...rows.map(row => row.label.length));
  const lines = rows.map(row => {
    const state = chatState(row);
    return [row.time, row.label.padEnd(width), row.text, row.note && `· ${row.note}`, state && `(${state})`].filter(Boolean).join('  ');
  });
  return [...lines, `${summary} · :Pair today in Neovim goes there, shows output and undoes edits`];
}
