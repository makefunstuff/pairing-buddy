// The optional shell hook: reports each finished command and its exit code, which herdr cannot tell Pair, with the
// shell's pid, which names the terminal it ran in outside herdr. It runs `pair report` in the background, so the
// prompt never waits for it. It also emits the OSC 133 marks
// that Pair's own pane emits (prompt, output, end with the exit code), for a terminal that reads them; herdr
// ignores them today (see docs/herdr.md).

const ZSH = bin => `# pairing-buddy: report finished commands to Pair
_pair_preexec() { _pair_cmd=$1; print -n '\\e]133;C\\a' }
_pair_precmd() {
  local code=$?
  [[ -n $_pair_cmd ]] && { print -n "\\e]133;D;$code\\a"; '${process.execPath}' '${bin}' report --exit "$code" --cmd "$_pair_cmd" --shell $$ &! }
  _pair_cmd=
  print -n '\\e]133;A\\a'
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec _pair_preexec
add-zsh-hook precmd _pair_precmd
`;

// bash has no preexec: the DEBUG trap sees each command before it runs. _pair_arm runs last in PROMPT_COMMAND,
// so only the first command typed at the prompt is recorded, not the rest of PROMPT_COMMAND; after an empty
// line the trap sees the prompt's own functions first, which are no command either.
const BASH = bin => `# pairing-buddy: report finished commands to Pair
_pair_preexec() {
  [[ -z $_pair_armed || -n $COMP_LINE || $BASH_COMMAND == _pair_* ]] && return
  _pair_armed=
  _pair_cmd=$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')
  printf '\\e]133;C\\a'
}
_pair_precmd() {
  local code=$?
  [[ -n $_pair_cmd ]] && { printf '\\e]133;D;%s\\a' "$code"; ( '${process.execPath}' '${bin}' report --exit "$code" --cmd "$_pair_cmd" --shell $$ >/dev/null 2>&1 & ) }
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
`;

// fish names the command line in its own events, and runs neither for an empty line.
const FISH = bin => `# pairing-buddy: report finished commands to Pair
function _pair_preexec --on-event fish_preexec
    printf '\\e]133;C\\a'
end
function _pair_postexec --on-event fish_postexec
    set -l code $status
    printf '\\e]133;D;%s\\a' $code
    command '${process.execPath}' '${bin}' report --exit $code --cmd $argv[1] --shell $fish_pid >/dev/null 2>&1 &
    disown
end
function _pair_prompt --on-event fish_prompt
    printf '\\e]133;A\\a'
end
`;

const HOOKS = {bash: BASH, zsh: ZSH, fish: FISH};

export function shellHook(shell, bin) {
  if (!HOOKS[shell]) throw new Error('usage: pair shell-hook bash|zsh|fish');
  return HOOKS[shell](bin);
}
