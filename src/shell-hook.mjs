// The optional shell hook: reports each finished command and its exit code, which herdr cannot tell Pair.
// It runs `pair report` in the background, so the prompt never waits for it.

const ZSH = bin => `# pairing-buddy: report finished commands to Pair
_pair_preexec() { _pair_cmd=$1 }
_pair_precmd() {
  local code=$?
  [[ -n $_pair_cmd ]] && { '${process.execPath}' '${bin}' report --exit "$code" --cmd "$_pair_cmd" &! }
  _pair_cmd=
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec _pair_preexec
add-zsh-hook precmd _pair_precmd
`;

// bash has no preexec: the DEBUG trap sees each command before it runs. _pair_arm runs last in PROMPT_COMMAND,
// so only the first command typed at the prompt is recorded, not the rest of PROMPT_COMMAND.
const BASH = bin => `# pairing-buddy: report finished commands to Pair
_pair_preexec() {
  [[ -z $_pair_armed || -n $COMP_LINE ]] && return
  _pair_armed=
  _pair_cmd=$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')
}
_pair_precmd() {
  local code=$?
  [[ -n $_pair_cmd ]] && ( '${process.execPath}' '${bin}' report --exit "$code" --cmd "$_pair_cmd" >/dev/null 2>&1 & )
  _pair_cmd=
}
_pair_arm() { _pair_armed=1; }
trap '_pair_preexec' DEBUG
if (( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 501 )); then
  PROMPT_COMMAND=(_pair_precmd "\${PROMPT_COMMAND[@]}" _pair_arm)  # bash 5.1+ runs every element
else
  PROMPT_COMMAND="_pair_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND};_pair_arm"
fi
`;

export function shellHook(shell, bin) {
  if (shell === 'zsh') return ZSH(bin);
  if (shell === 'bash') return BASH(bin);
  throw new Error('usage: pair shell-hook bash|zsh');
}
