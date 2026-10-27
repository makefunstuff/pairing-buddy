// How the shell in Pair's own pane hands over each command: herdr cannot say when a command ends or how, and its
// screen text is at most 1000 lines, so the shell itself writes them down. Its rc file (below) copies all it shows
// to pane.log, with a mark before and after the output of command N, and writes N's exit code to N.exit once it
// ends; `next` holds the number of the next command, or "running N" while N runs. Pair cuts each command's output
// out of the log between its marks, never out of the screen.
import {watch} from 'node:fs';
import {mkdir, open, readFile, rm, truncate, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const MAX_OUTPUT_BYTES = 4 << 20; // more is cut in the middle: the first error and the summary at the end stay
const END_MS = 2000; // how long tee may take to write the end mark after the command ended

// The shell's stdout and stderr go through one tee, started once before any command, to the screen and the log:
// no pipe of a command (`a | b`), subshell or job left in the background (`cmd &`) depends on it, and Ctrl-C
// leaves it (`tee -i`). Commands write to a pipe, not the terminal: no colours, no pager, no progress bars. bash
// shows PS0 in the shell itself after it read a line with a command in it, before running it: there the array
// subscript sets the running command's number and the mark `C;aid=pairN` goes to the log. PROMPT_COMMAND writes
// the end mark with the exit code. These are OSC 133 marks, for a terminal that reads them too; herdr ignores them
// today (see docs/herdr.md). Each file is written whole and renamed into place, so Pair never reads half of one,
// and N.exit comes last: once it is there, `next` already holds the number of the command after N.
export const RC = `# Pair's own pane (pairing-buddy): all it shows also goes to $PAIR_RUNS/pane.log, each exit code to N.exit
HISTFILE=
exec > >(exec tee -i -a "$PAIR_RUNS/pane.log") 2>&1
_pair_n=1
_pair_exit=0
_pair_running=
_pair_set=()
_pair_put() { printf '%s\\n' "$2" > "$PAIR_RUNS/$1.tmp" && command mv -f "$PAIR_RUNS/$1.tmp" "$PAIR_RUNS/$1"; }
_pair_end() {
  _pair_exit=$?
  local ended=$_pair_running
  if [[ -n $ended ]]; then
    printf '\\e]133;D;%s;aid=pair%s\\a' "$_pair_exit" "$ended"
    _pair_n=$((ended + 1))
    _pair_running=
  fi
  _pair_put next "$_pair_n"
  [[ -n $ended ]] && _pair_put "$ended.exit" "$_pair_exit"
}
PROMPT_COMMAND=_pair_end
PS0='\${_pair_set[_pair_running=_pair_n]}$(_pair_put next "running $_pair_n")\\e]133;C;aid=pair\${_pair_n}\\a'
PS1='\\[\\e]133;A\\a\\]scout[$_pair_n] exit $_pair_exit $ \\[\\e]133;B\\a\\]'
`;

/** The marks around the output of command `number` in the log. */
const startMark = number => `\x1b]133;C;aid=pair${number}\x07`;
const endMark = number => new RegExp(`\\x1b\\]133;D;\\d+;aid=pair${number}\\x07`);

/** Where the rc file is in a pane's folder `dir`; the shell reads it last, with PAIR_RUNS set to `dir`. */
export const rcFileIn = dir => join(dir, 'pane.bash');

/** The files of the shell in one of Pair's panes, in its own directory `dir`. */
export class PaneRuns {
  constructor(dir) {
    this.dir = dir;
  }

  /** Writes the rc file into an empty folder, for a new shell. */
  async prepare() {
    await this.remove();
    await mkdir(this.dir, {recursive: true, mode: 0o700});
    await writeFile(rcFileIn(this.dir), RC);
  }

  /** Removes the files, once the pane is closed. */
  remove() {
    return rm(this.dir, {recursive: true, force: true});
  }

  /** The number of the next command when the shell waits at its prompt; null while a command runs or without the shell. */
  async next() {
    const text = await readFile(join(this.dir, 'next'), 'utf8').catch(() => '');
    return /^\d+$/.test(text.trim()) ? Number(text) : null;
  }

  /** Resolves once the shell waits at its prompt, with the number of its next command. */
  async ready(timeoutMs) {
    await waitFor(this.dir, async () => (await this.next()) !== null, timeoutMs);
    return this.next();
  }

  /** Empties the log while the shell waits at its prompt, so it holds little more than the next command. */
  clearLog() {
    return truncate(join(this.dir, 'pane.log'), 0).catch(() => {});
  }

  /** Resolves once command `number` has ended. */
  ended(number, timeoutMs) {
    return waitFor(this.dir, () => exists(join(this.dir, `${number}.exit`)), timeoutMs);
  }

  /**
   * The exit code and the whole output of command `number`, which has ended: what the log has between its marks,
   * so not what a job it left in the background prints later. Its exit file is removed.
   */
  async result(number) {
    const exit = Number(await readFile(join(this.dir, `${number}.exit`), 'utf8'));
    const log = join(this.dir, 'pane.log');
    await waitFor(this.dir, async () => endMark(number).test(await readCapped(log)), END_MS).catch(() => {});
    const text = await readCapped(log);
    const start = text.indexOf(startMark(number));
    const end = text.search(endMark(number));
    const output = text.slice(start === -1 ? 0 : start + startMark(number).length, end === -1 ? undefined : end);
    await rm(join(this.dir, `${number}.exit`), {force: true});
    return {exit, output: `${start === -1 ? '(earlier output cut)\n' : ''}${shown(output).replace(/\n+$/, '')}`};
  }
}

/**
 * What a terminal shows of `text`: without escape sequences (colours, `clear`) and, of a line a progress bar
 * rewrote with carriage returns, its last version.
 */
export const shown = text => text
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '')
  .split('\n').map(line => line.replace(/\r+$/, '').split('\r').at(-1)).join('\n');

const exists = path => readFile(path).then(() => true, () => false);

/** Resolves once `check()` is true, looking each time a file in `dir` changes; rejects after `timeoutMs`. */
function waitFor(dir, check, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      watcher.close();
      error ? reject(error) : resolve();
    };
    const look = () => check().then(ok => ok && finish(), finish);
    const watcher = watch(dir, look);
    watcher.on('error', finish);
    const timer = setTimeout(() => finish(new Error('timed out')), timeoutMs);
    look();
  });
}

/** The text of the file at `path`; of a very long one, its first and last MAX_OUTPUT_BYTES / 2. */
async function readCapped(path) {
  const file = await open(path).catch(() => null);
  if (!file) return '';
  try {
    const {size} = await file.stat();
    if (size <= MAX_OUTPUT_BYTES) return (await file.readFile('utf8'));
    const half = MAX_OUTPUT_BYTES / 2;
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    await file.read(head, 0, half, 0);
    await file.read(tail, 0, half, size - half);
    return `${head.toString('utf8')}\n(${size - MAX_OUTPUT_BYTES} bytes cut)\n${tail.toString('utf8')}`;
  } finally {
    await file.close();
  }
}
