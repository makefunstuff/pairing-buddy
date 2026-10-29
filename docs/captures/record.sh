#!/usr/bin/env bash
# Records the scenes with VHS into out/: ./record.sh [scene ...] (default: all of them but the tutorial's t-*).
# CAP_LOOK=site records the site's loops instead: the same scenes in tokyonight with a larger font (tapes/head-site.tape),
# into out/site/, so that the docs' GIFs and stills in out/ stay as they are.
# CAP_MODEL=deepseek gives the stage a real model (see README.md, the tutorial's scenes).
# Each scene gets its own scratch directory under /tmp/paircap.*: the project, the daemon's socket and data, and
# Neovim's XDG directories. It is /tmp and not $TMPDIR on purpose: its paths show in the videos, and a short one keeps
# the socket paths short. It goes when the scene ends, recorded, failed or interrupted, with the stage stopped first;
# CAP_KEEP=1 keeps it and its logs.
# Nothing of your own Neovim, pair config, history or daemon is read or touched. The clock is UTC, so the times the
# ledger shows are not your time zone.
set -euo pipefail
# The crash scene crashes a program on purpose: no core dumps, and none handed to the crash reporter (see test/no-core.mjs).
prlimit --pid $$ --core=1 2>/dev/null || ulimit -c 0
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
AYU=01faacb4cb76e8cf72ad9858c581d80876260ab3 # ayu-theme/ayu-vim, Apache-2.0
TELESCOPE=40aedd8a68c78a656a10a8d62d80c54af59420fb # nvim-telescope/telescope.nvim, MIT: for the search trail and the context card
PLENARY=74b06c6c75e4eeb3108ec01852001636d85a932b # nvim-lua/plenary.nvim, MIT: Telescope needs it
MINI=561751e839b99a4baca36b9d963166b66d2536a6 # echasnovski/mini.nvim, MIT: only mini.base16
TOKYONIGHT=cdc07ac78467a233fd62c493de29a17e0cf2b2b6 # folke/tokyonight.nvim, Apache-2.0: the site's loops
# Nothing of the session you record from reaches a scene: not the herdr (or the board) you may run this in. The
# no-herdr scenes have no herdr at all, the others its stand-in.
for v in $(compgen -e); do case $v in HERDR_*|SHEPHERDR_*|AGENT_BROWSER_*|TERM_PROGRAM*) unset "$v" ;; esac; done
SCENES=("$@")
[ ${#SCENES[@]} -gt 0 ] || SCENES=(wrong-turn tests-on-save hand-over take-back held-thought search-trail ledger context-card crash delight agents teach notes pickup debrief loop blank-page first-run hand-over-run no-herdr chat chat-layout gen-here gen-file gen-try gen-scaffold gen-board review brief-sync doctor worktrees roles)
mkdir -p "$HERE/out"
if [ "${CAP_LOOK:-}" = site ]; then mkdir -p "$HERE/out/site"; export CAP_SCHEME=tokyonight; fi

fetch() { # fetch <github repo> <commit> <dir>: one commit, no history
  git init -q "$3" && git -C "$3" fetch -q --depth 1 "https://github.com/$1" "$2" && git -C "$3" checkout -q FETCH_HEAD
}

CAP= stage= tape=
cleanup() { # stops the scene's VHS and stage, and removes its scratch directory
  for pid in $tape $stage; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  if [ -n "$CAP" ]; then if [ -n "${CAP_KEEP:-}" ]; then echo "logs in $CAP"; else rm -rf "$CAP"; fi; fi
  CAP= stage= tape=
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for scene in "${SCENES[@]}"; do
  CAP=$(mktemp -d /tmp/paircap.XXXXXX)
  mkdir -p "$CAP/ayu/colors" "$CAP/mini/lua/mini" "$CAP/xdg/config" "$CAP/xdg/data" "$CAP/xdg/state" "$CAP/xdg/cache"
  curl -fsSL "https://raw.githubusercontent.com/ayu-theme/ayu-vim/$AYU/colors/ayu.vim" -o "$CAP/ayu/colors/ayu.vim"
  if [ "$scene" = search-trail ] || [ "$scene" = context-card ]; then
    fetch nvim-telescope/telescope.nvim $TELESCOPE "$CAP/telescope.nvim"
    fetch nvim-lua/plenary.nvim $PLENARY "$CAP/plenary.nvim"
  fi
  curl -fsSL "https://raw.githubusercontent.com/echasnovski/mini.nvim/$MINI/lua/mini/base16.lua" -o "$CAP/mini/lua/mini/base16.lua"
  [ "${CAP_SCHEME:-}" != tokyonight ] || fetch folke/tokyonight.nvim $TOKYONIGHT "$CAP/tokyonight.nvim"
  tapefile=tapes/$scene.tape
  if [ "${CAP_LOOK:-}" = site ]; then # the same tape, on the site's head and into out/site/
    sed -e 's#tapes/head.tape#tapes/head-site.tape#' -e 's#out/#out/site/#g' "$HERE/$tapefile" > "$CAP/scene.tape"
    tapefile=$CAP/scene.tape
  fi
  export TZ=UTC CAP CAP_REPO=$REPO CAP_HERE=$HERE PAIR_CONFIG=$CAP/config.json HISTFILE=$CAP/history
  export XDG_CONFIG_HOME=$CAP/xdg/config XDG_DATA_HOME=$CAP/xdg/data XDG_STATE_HOME=$CAP/xdg/state XDG_CACHE_HOME=$CAP/xdg/cache
  node "$HERE/stage.mjs" "$scene" "$CAP" 2> "$CAP/stage.log" &
  stage=$!
  for _ in $(seq 300); do [ -e "$CAP/ready" ] && break; sleep 0.1; done
  [ -e "$CAP/ready" ] || { cat "$CAP/stage.log"; exit 1; }
  # In the background, so that a SIGTERM's trap runs at once rather than after VHS.
  (cd "$HERE" && exec vhs "$tapefile") > "$CAP/vhs.log" 2>&1 &
  tape=$!
  wait $tape || { tape=; tail "$CAP/vhs.log"; exit 1; }
  tape=
  echo "$scene: out/${CAP_LOOK:+$CAP_LOOK/}$scene.mp4"
  cleanup
done
