// The optional shell hook: tells Pair what herdr cannot (see docs/herdr.md). When the shell starts it says the
// pane has the hook (`report --ready`), so Pair stops polling the pane's processes; then, for each command line,
// that it started (`--start`) and that it ended with its exit code (`--exit`). Every report carries the shell's pid,
// which names the terminal it ran in outside herdr (a Neovim :terminal's or a tmux pane's, src/pane-watch.mjs); start
// and end also the line's number, so a start that arrives after its own end (each report runs in the background, so
// the prompt never waits for it) is not taken for a command still running. zsh also says when keys change the line at
// the prompt, at most twice a second, straight to the daemon's socket through zsh's own zsocket: no process is
// started for it. bash and fish have no hook for keys, so Pair still tells typing from the pane's text there.
// The hook also emits the OSC 133 marks that Pair's own pane emits (prompt, output, end with the exit code), for a
// terminal that reads them; herdr ignores them today.

// A word in single quotes: in bash and zsh a quote ends them and starts again; fish escapes with a backslash.
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const fishQuote = text => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

const ZSH = (report, socket) => `# pairing-buddy: report commands and typing to Pair
zmodload zsh/datetime 2>/dev/null
_pair_n=0
_pair_preexec() {
  _pair_cmd=$1
  (( ++_pair_n ))
  ${report} $_pair_keys_flag --start --shell $$ --n $_pair_n --cmd "$1" >/dev/null 2>&1 &!
  print -n '\\e]133;C\\a'
}
_pair_precmd() {
  local code=$?
  [[ -n $_pair_cmd ]] && { print -n "\\e]133;D;$code\\a"; ${report} $_pair_keys_flag --exit "$code" --shell $$ --n $_pair_n --cmd "$_pair_cmd" >/dev/null 2>&1 &! }
  _pair_cmd=
  _pair_keys_at=0 # the first key at a new prompt is reported, however soon after the last
  print -n '\\e]133;A\\a'
}
# Keys at the prompt: the line or the cursor changed since the last redraw. Reported at most twice a second.
_pair_line_init() { _pair_line="$CURSOR:$BUFFER" }
_pair_keys() {
  [[ "$CURSOR:$BUFFER" == "$_pair_line" ]] && return
  _pair_line="$CURSOR:$BUFFER"
  (( \${EPOCHREALTIME:-0} - \${_pair_keys_at:-0} < 0.5 )) && return
  _pair_keys_at=\${EPOCHREALTIME:-0}
  local id='^[[:alnum:]:_.%-]*$' # pane ids go into the JSON as they are
  [[ $HERDR_PANE_ID =~ $id && $TMUX_PANE =~ $id ]] || return
  if zmodload zsh/net/socket 2>/dev/null && zsocket ${quote(socket)} 2>/dev/null; then
    print -u $REPLY -r -- '{"type":"typing","pane":"'$HERDR_PANE_ID'","tmux":"'$TMUX_PANE'","shell":'$$'}'
    exec {REPLY}>&-
  fi
}
# Pair is told the pane has the hook only once its hooks are in, and that keys are reported only where they can be:
# zle's hook widgets (zsh 5.3 and later) and the socket module. Otherwise Pair keeps looking at the pane itself.
_pair_keys_flag=
autoload -Uz add-zsh-hook add-zle-hook-widget
if add-zsh-hook preexec _pair_preexec 2>/dev/null && add-zsh-hook precmd _pair_precmd 2>/dev/null; then
  if zmodload zsh/net/socket 2>/dev/null && add-zle-hook-widget line-init _pair_line_init 2>/dev/null \\
      && add-zle-hook-widget line-pre-redraw _pair_keys 2>/dev/null; then
    _pair_keys_flag=--keys
  fi
  ${report} $_pair_keys_flag --ready --shell $$ >/dev/null 2>&1 &!
fi
`;

// bash has no preexec: the DEBUG trap sees each command before it runs. _pair_arm runs last in PROMPT_COMMAND,
// so only the first command typed at the prompt is recorded, not the rest of PROMPT_COMMAND. After an empty line
// the first the trap sees is _pair_precmd, first in PROMPT_COMMAND: no command ran, and the rest of
// PROMPT_COMMAND is none either.
const BASH = report => `# pairing-buddy: report commands to Pair
_pair_n=0
_pair_preexec() {
  [[ -z $_pair_armed || -n $COMP_LINE ]] && return
  _pair_armed=
  [[ $BASH_COMMAND == _pair_* ]] && return
  _pair_cmd=$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')
  (( ++_pair_n ))
  ( ${report} --start --shell $$ --n $_pair_n --cmd "$_pair_cmd" >/dev/null 2>&1 & )
  printf '\\e]133;C\\a'
}
_pair_precmd() {
  local code=$?
  [[ -n $_pair_cmd ]] && { printf '\\e]133;D;%s\\a' "$code"; ( ${report} --exit "$code" --shell $$ --n $_pair_n --cmd "$_pair_cmd" >/dev/null 2>&1 & ) }
  _pair_cmd=
  printf '\\e]133;A\\a'
}
_pair_arm() { _pair_armed=1; }
trap '_pair_preexec' DEBUG
if (( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 501 )); then
  PROMPT_COMMAND=(_pair_precmd "\${PROMPT_COMMAND[@]}" _pair_arm)  # bash 5.1+ runs every element
else
  PROMPT_COMMAND="_pair_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND};_pair_arm"
fi
( ${report} --ready --shell $$ >/dev/null 2>&1 & )
`;

// fish names the command line in its own events, and runs neither for an empty line.
const FISH = report => `# pairing-buddy: report commands to Pair
set -g _pair_n 0
function _pair_preexec --on-event fish_preexec
    set -g _pair_n (math $_pair_n + 1)
    command ${report} --start --shell $fish_pid --n $_pair_n --cmd $argv[1] >/dev/null 2>&1 &
    disown
    printf '\\e]133;C\\a'
end
function _pair_postexec --on-event fish_postexec
    set -l code $status
    printf '\\e]133;D;%s\\a' $code
    command ${report} --exit $code --shell $fish_pid --n $_pair_n --cmd $argv[1] >/dev/null 2>&1 &
    disown
end
function _pair_prompt --on-event fish_prompt
    printf '\\e]133;A\\a'
end
command ${report} --ready --shell $fish_pid >/dev/null 2>&1 &
disown
`;

const HOOKS = {bash: BASH, zsh: ZSH, fish: FISH};

/** The hook for `shell`, which runs `bin report` with node; zsh also writes to the daemon's socket `socket`. */
export function shellHook(shell, bin, {socket = ''} = {}) {
  if (!HOOKS[shell]) throw new Error('usage: pair shell-hook bash|zsh|fish');
  const q = shell === 'fish' ? fishQuote : quote;
  return HOOKS[shell](`${q(process.execPath)} ${q(bin)} report`, socket);
}
