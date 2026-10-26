#!/usr/bin/env bash
# Records the scenes with VHS into out/: ./record.sh [scene ...] (default: all six).
# Each scene gets its own scratch directory under /tmp/paircap.*: the project, the daemon's socket and data, and
# Neovim's XDG directories. Nothing of your own Neovim, pair config, history or daemon is read or touched.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
AYU=01faacb4cb76e8cf72ad9858c581d80876260ab3 # ayu-theme/ayu-vim, Apache-2.0
SCENES=("$@")
[ ${#SCENES[@]} -gt 0 ] || SCENES=(wrong-turn tests-on-save hand-over take-back blank-page first-run)
mkdir -p "$HERE/out"

for scene in "${SCENES[@]}"; do
  CAP=$(mktemp -d /tmp/paircap.XXXXXX)
  mkdir -p "$CAP/ayu/colors" "$CAP/xdg/config" "$CAP/xdg/data" "$CAP/xdg/state" "$CAP/xdg/cache"
  curl -fsSL "https://raw.githubusercontent.com/ayu-theme/ayu-vim/$AYU/colors/ayu.vim" -o "$CAP/ayu/colors/ayu.vim"
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
