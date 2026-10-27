// What the text of one of the user's panes says, for a pane without the shell hook: herdr gives Pair the
// screen's recent lines and nothing about commands (see docs/herdr.md). Pair reads the pane's last lines while
// its shell waits at the prompt; comparing two reads tells typing (the prompt line changed in place) from a
// command that ran in between (that line moved up, with output and a new prompt below it), and the line the
// command was typed on is where its output starts. Pure: no herdr, no clock.

/** The lines of a pane's text, without trailing spaces and blank lines at the end. */
export const linesOf = text => text.replace(/\s+$/, '').split('\n').map(line => line.trimEnd());

/**
 * The index in `lines` of the line the command was typed on, or -1. `before` is the pane's text read at the
 * prompt before the command (its last line has what was typed by then, the command or the start of it); `cmd` is
 * the command as herdr or the shell hook named it. The first that matches, from the end: the line after the
 * one above the prompt then that starts with what was typed, a line that ends with `cmd`, one that has its start.
 */
export function commandLine(lines, {before = null, cmd = ''} = {}) {
  const search = (match, last = lines.length - 1) => lines.findLastIndex((line, i) => i < last && match(line, i));
  if (before) {
    const was = linesOf(before);
    const [above, typed] = was.length > 1 ? was.slice(-2) : [null, was[0]];
    const found = typed ? search((line, i) => line.startsWith(typed) && (above === null || lines[i - 1] === above)) : -1;
    if (found !== -1) return found;
  }
  const command = cmd.trim();
  if (!command) return -1;
  const ends = search(line => line.endsWith(command));
  return ends !== -1 ? ends : search(line => line.includes(command.slice(0, 40)));
}

/** What was typed on `line`, a line that starts with the empty prompt `prompt`; '' when that is not known. */
const typedOn = (line, prompt) => (prompt && line?.startsWith(prompt) ? line.slice(prompt.length).trim() : '');

/**
 * The command from the pane's recent text: what was typed on its command line (else `cmd`), and its output, the
 * lines after that line without the new prompt.
 */
export function commandOutput(text, {before = null, cmd = '', prompt = null} = {}) {
  const lines = linesOf(text);
  const start = commandLine(lines, {before, cmd});
  const output = lines.slice(start + 1, -1).join('\n');
  if (start === -1) return {cmd, output: `(the command's line was not found: the pane's recent lines)\n${output}`};
  return {cmd: typedOn(lines[start], prompt) || cmd, output};
}

/**
 * What happened at the prompt between two reads of the pane's last lines, `before` and `after`, while no command
 * was seen running: `{typed: true}` when only its last line changed or it was shown again (keys at the prompt, Tab); `{ran: {cmd, output}}`
 * when a command was entered and ended in between, too short to be seen running; `{entered: true}` when Enter was
 * pressed but no command can be named (an empty line, Ctrl-C, a prompt not known); `{lost: true}` when the line
 * typed on is not in `after` (read more lines, or the screen was cleared); null when nothing changed.
 * `prompt` is the pane's empty prompt line, what the last line shows before anything is typed, or null.
 */
export function promptChange(before, after, prompt) {
  if (before === after) return null;
  const was = linesOf(before);
  const lines = linesOf(after);
  if (lines.length === was.length && lines.slice(0, -1).every((line, i) => line === was[i])) return {typed: true};
  const at = commandLine(lines, {before});
  if (at === -1) return lines.at(-1) === was.at(-1) ? {entered: true} : {lost: true};
  const line = lines[at];
  if (line === lines.at(-1) && line !== prompt) return {typed: true}; // the line shown again below: Tab listed completions
  const cmd = typedOn(line, prompt);
  if (!cmd || cmd.endsWith('^C')) return {entered: true};
  return {ran: {cmd, output: lines.slice(at + 1, -1).join('\n')}};
}
