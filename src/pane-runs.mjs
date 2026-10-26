// How the shell in Pair's own pane hands over each command: herdr cannot say when a command ends or how, and its
// screen text is at most 1000 lines, so the shell itself writes them down. Its rc file (below) copies the output of
// command N to N.out as it shows it, and writes N's exit code to N.exit once it ends; `next` holds the number of
// the next command, or "running N" while N runs. Pair reads these files, never the screen.
import {watch} from 'node:fs';
import {mkdir, open, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const MAX_OUTPUT_BYTES = 4 << 20; // more is cut in the middle: the first error and the summary at the end stay

// bash runs the DEBUG trap before each command; _pair_armed lets only the first one typed at a prompt start a
// run, and the trap skips the prompt's own functions. The output goes through tee to the screen and the file, so
// the command's stdout is a pipe, not the terminal: no colours, no pager, no progress bars. `tee -i` outlives a
// Ctrl-C, so the file keeps the end of a stopped command. The OSC 133 marks (prompt, command, output, end with
// exit code) are for a terminal that understands them; herdr ignores them today (see docs/herdr.md).
export const RC = `# Pair's own pane (pairing-buddy): each command's output also goes to $PAIR_RUNS/N.out, its exit code to N.exit
HISTFILE=
_pair_n=1
_pair_exit=0
_pair_running=
_pair_armed= # the first prompt arms it, not the rest of this file
_pair_start() {
  [[ -z $_pair_armed || $BASH_COMMAND == _pair_* ]] && return
  _pair_armed=
  _pair_running=$_pair_n
  printf 'running %s\\n' "$_pair_n" > "$PAIR_RUNS/next"
  printf '\\e]133;C\\a'
  exec {_pair_out}>&1 {_pair_err}>&2 > >(exec tee -i "$PAIR_RUNS/$_pair_n.out") 2>&1
  _pair_tee=$!
}
_pair_end() {
  _pair_exit=$?
  if [[ -n $_pair_running ]]; then
    exec 1>&$_pair_out 2>&$_pair_err {_pair_out}>&- {_pair_err}>&-
    wait "$_pair_tee" 2>/dev/null
    printf '%s\\n' "$_pair_exit" > "$PAIR_RUNS/$_pair_running.exit.tmp"
    command mv -f "$PAIR_RUNS/$_pair_running.exit.tmp" "$PAIR_RUNS/$_pair_running.exit"
    _pair_n=$((_pair_running + 1))
    _pair_running=
  fi
  printf '%s\\n' "$_pair_n" > "$PAIR_RUNS/next"
  printf '\\e]133;D;%s\\a' "$_pair_exit"
  _pair_armed=1
}
PROMPT_COMMAND=_pair_end
trap _pair_start DEBUG
PS1='\\[\\e]133;A\\a\\]scout[$_pair_n] exit $_pair_exit $ \\[\\e]133;B\\a\\]'
`;

/** The files of the shell in one of Pair's panes, in its own directory `dir`. */
export class PaneRuns {
  constructor(dir) {
    this.dir = dir;
  }

  /** Writes the rc file and returns the line that starts the shell with it. No rc files of yours, no history file. */
  async shellLine() {
    await this.remove();
    await mkdir(this.dir, {recursive: true, mode: 0o700});
    await writeFile(join(this.dir, 'pane.bash'), RC);
    const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
    return `exec env PAIR_RUNS=${quote(this.dir)} bash --noprofile --rcfile ${quote(join(this.dir, 'pane.bash'))} -i`;
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

  /** Resolves once command `number` has ended. */
  ended(number, timeoutMs) {
    return waitFor(this.dir, () => exists(join(this.dir, `${number}.exit`)), timeoutMs);
  }

  /** The exit code and the whole output of command `number`, which has ended; its files are removed. */
  async result(number) {
    const exit = Number(await readFile(join(this.dir, `${number}.exit`), 'utf8'));
    const output = shown(await readCapped(join(this.dir, `${number}.out`))).replace(/\n$/, '');
    await rm(join(this.dir, `${number}.exit`), {force: true});
    await rm(join(this.dir, `${number}.out`), {force: true});
    return {exit, output};
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
