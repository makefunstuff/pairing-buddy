#!/bin/bash
# Records the setup scenes of the film: run.sh <tape> ...  (default: every tape in tapes/). The Neovim scenes come
# from docs/captures/record.sh instead (see clips.sh).
# Each tape gets a fresh scratch dir under /tmp: a home with nothing of yours in it, scratch XDG dirs, and for the
# start tape a git copy of hookd/, a stand-in local model (local-model.mjs) and a daemon on its own socket there
# (never the running pairing-buddy service). It is /tmp and not $TMPDIR on purpose: the sandbox's paths show in the
# videos. It goes when the tape ends, recorded, failed or interrupted, with the model, the daemon and Neovim stopped
# first; CAP_KEEP=1 keeps it. Needs VHS 0.11, ttyd and Neovim 0.11+.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
tapes=("$@"); [ ${#tapes[@]} -gt 0 ] || tapes=("$here"/tapes/*.tape)
vhs=(vhs); command -v mise >/dev/null && vhs=(mise exec ttyd@1.7.7 vhs@0.11.0 -- vhs)
dir= model= recording=
cleanup() { # stops the tape's VHS, its model or installed daemon, and removes its scratch dir
  for pid in $recording $model; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  if [ -n "$dir" ]; then
    for pidfile in "$dir/daemon.pid" "$dir/nvim.pid"; do [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null || true; done
    if [ -n "${CAP_KEEP:-}" ]; then echo "kept: $dir"; else rm -rf "$dir"; fi
  fi
  dir= model= recording=
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for tape in "${tapes[@]}"; do
  name=$(basename "$tape" .tape)
  dir=$(mktemp -d /tmp/pbcap.XXXXXX)
  cp -r "$here/hookd" "$dir/hookd"
  git -C "$dir/hookd" init -q && git -C "$dir/hookd" add -A && git -C "$dir/hookd" -c user.name=dev -c user.email=dev@example.com commit -qm start
  home=$dir/home
  mkdir -p "$home"/{.config,.local/share,.local/state,.cache} "$dir/run"
  # The shell VHS types into: no rc files, a bare prompt, nothing of this machine's home.
  cat > "$dir/env.sh" <<ENV
export PBCAP=$dir HOME=$home XDG_CONFIG_HOME=$home/.config XDG_DATA_HOME=$home/.local/share XDG_STATE_HOME=$home/.local/state
export XDG_CACHE_HOME=$home/.cache XDG_RUNTIME_DIR=$dir/run PAIR_SOCKET=$dir/pair.sock NVIM_APPNAME=pbcap PS1='\$ '
export GOCACHE=$home/.cache/go GOFLAGS=-count=1
unset HERDR_ENV HERDR_SOCKET_PATH HERDR_PANE_ID HERDR_WORKSPACE_ID
for v in \$(compgen -e); do case \$v in *KEY*|*TOKEN*|*SECRET*|*PASSWORD*) unset \$v ;; esac; done
cd $dir/hookd && clear
ENV
  if [ "$name" = install ]; then # a home with nothing in it, npm's prefix inside, the systemctl stand-in first
    mkdir -p "$dir/bin" "$dir/npm-global" && cp "$here/systemctl" "$dir/bin/"
    cat >> "$dir/env.sh" <<ENV
export npm_config_prefix=$dir/npm-global npm_config_cache=$home/.cache/npm npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false MISE_SKIP_RESHIM=1
export PATH=$dir/bin:$dir/npm-global/bin:$(dirname "$(command -v node)"):/usr/bin:/bin
ENV
  elif [ "$name" = start ]; then # pair setup done, the plugin in Neovim's config, one Neovim connected, one local model
    mkdir -p "$dir/bin" "$home/.config/pairing-buddy" "$home/.config/pbcap" && cp "$here/systemctl" "$dir/bin/"
    printf '#!/bin/sh\nexec node %s/bin/pair.mjs "$@"\n' "$repo" > "$dir/bin/pair" && chmod +x "$dir/bin/pair"
    cat > "$home/.config/pairing-buddy/config.json" <<'JSON'
{
  // One local model for both roles: the Watcher scores, the Partner thinks.
  "model": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "local-model",
            "compat": {"supportsReasoningEffort": true}}
}
JSON
    printf "vim.opt.rtp:prepend('%s')\nrequire('pair').setup({auto_connect = true})\n" "$repo" > "$home/.config/pbcap/init.lua"
    cat >> "$dir/env.sh" <<ENV
export PATH=$dir/bin:$(dirname "$(command -v node)"):/usr/bin:/bin NODE_NO_WARNINGS=1
ENV
    (cd "$here" && exec node local-model.mjs 8080) > "$dir/model.log" 2>&1 &
    model=$!
    (set +u; source "$dir/env.sh"; pair setup < /dev/null > "$dir/setup.log" 2>&1; cd "$dir/hookd" && setsid nvim --headless -c "lua require('pair').connect()" internal/delivery/worker.go > /dev/null 2>&1 < /dev/null & echo $! > "$dir/nvim.pid")
  else
    echo "run.sh: no setup for the tape $name" >&2; exit 1
  fi
  sleep 2
  sed "s#@PBCAP@#$dir#g; s#@HERE@#$here#g" "$tape" > "$dir/$name.tape"
  # In the background, so that a SIGTERM's trap runs at once rather than after VHS.
  (cd "$here" && exec timeout 600 "${vhs[@]}" "$dir/$name.tape") &
  recording=$!
  wait $recording
  recording=
  echo "$name: clips/$name.mp4"
  cleanup
done
