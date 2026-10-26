#!/usr/bin/env bash
# Records the scenes with VHS into out/: ./record.sh [scene ...] (default: all of them).
# Each scene gets its own scratch directory under /tmp/paircap.*: the project, the daemon's socket and data, and
# Neovim's XDG directories. Nothing of your own Neovim, pair config, history or daemon is read or touched.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
AYU=01faacb4cb76e8cf72ad9858c581d80876260ab3 # ayu-theme/ayu-vim, Apache-2.0
TELESCOPE=40aedd8a68c78a656a10a8d62d80c54af59420fb # nvim-telescope/telescope.nvim, MIT: for the search trail
PLENARY=74b06c6c75e4eeb3108ec01852001636d85a932b # nvim-lua/plenary.nvim, MIT: Telescope needs it
SCENES=("$@")
[ ${#SCENES[@]} -gt 0 ] || SCENES=(wrong-turn tests-on-save hand-over take-back search-trail)
mkdir -p "$HERE/out"

fetch() { # fetch <github repo> <commit> <dir>: one commit, no history
  git init -q "$3" && git -C "$3" fetch -q --depth 1 "https://github.com/$1" "$2" && git -C "$3" checkout -q FETCH_HEAD
}

for scene in "${SCENES[@]}"; do
  CAP=$(mktemp -d /tmp/paircap.XXXXXX)
  mkdir -p "$CAP/ayu/colors" "$CAP/xdg/config" "$CAP/xdg/data" "$CAP/xdg/state" "$CAP/xdg/cache"
  curl -fsSL "https://raw.githubusercontent.com/ayu-theme/ayu-vim/$AYU/colors/ayu.vim" -o "$CAP/ayu/colors/ayu.vim"
  if [ "$scene" = search-trail ]; then
    fetch nvim-telescope/telescope.nvim $TELESCOPE "$CAP/telescope.nvim"
    fetch nvim-lua/plenary.nvim $PLENARY "$CAP/plenary.nvim"
  fi
  export CAP CAP_REPO=$REPO CAP_HERE=$HERE PAIR_CONFIG=$CAP/config.json HISTFILE=$CAP/history
  export XDG_CONFIG_HOME=$CAP/xdg/config XDG_DATA_HOME=$CAP/xdg/data XDG_STATE_HOME=$CAP/xdg/state XDG_CACHE_HOME=$CAP/xdg/cache
  node "$HERE/stage.mjs" "$scene" "$CAP" 2> "$CAP/stage.log" &
  stage=$!
  for _ in $(seq 300); do [ -e "$CAP/ready" ] && break; sleep 0.1; done
  [ -e "$CAP/ready" ] || { cat "$CAP/stage.log"; exit 1; }
  (cd "$HERE" && vhs "tapes/$scene.tape") > "$CAP/vhs.log" 2>&1 || { tail "$CAP/vhs.log"; kill $stage; exit 1; }
  kill $stage; wait $stage || true
  echo "$scene: out/$scene.mp4 (logs in $CAP)"
done
