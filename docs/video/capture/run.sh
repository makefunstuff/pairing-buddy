#!/bin/bash
# Records the captures of the shipped plugin: run.sh <tape> ...  (default: every tape in tapes/)
# Each tape gets a fresh scratch dir under /tmp: a git copy of hookd/, scratch XDG dirs and the harness's daemon
# on its own socket there (never the running pairing-buddy service). Needs VHS 0.11, ttyd, Go and Neovim 0.11+.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tapes=("$@"); [ ${#tapes[@]} -gt 0 ] || tapes=("$here"/tapes/*.tape)
vhs=(vhs); command -v mise >/dev/null && vhs=(mise exec ttyd@1.7.7 vhs@0.11.0 -- vhs)
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
cd $dir/hookd && clear
ENV
  if [ "$name" = install ]; then # a home with nothing in it, npm's prefix inside, the systemctl stand-in first
    mkdir -p "$dir/bin" "$dir/npm-global" && cp "$here/systemctl" "$dir/bin/"
    cat >> "$dir/env.sh" <<ENV
export npm_config_prefix=$dir/npm-global npm_config_cache=$home/.cache/npm npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false MISE_SKIP_RESHIM=1
export PATH=$dir/bin:$dir/npm-global/bin:$(dirname "$(command -v node)"):/usr/bin:/bin
ENV
  else
  (cd "$dir/hookd" && GOCACHE="$home/.cache/go" go vet ./... && GOCACHE="$home/.cache/go" go test -count=1 ./... >/dev/null 2>&1 || true) # a warm build cache: Pair's pane waits 5 s at most
  (cd "$here" && GOCACHE="$home/.cache/go" exec node harness.mjs "$dir" > "$dir/harness.log" 2>&1) &
  harness=$!
  fi
  sleep 2
  sed "s#@PBCAP@#$dir#g; s#@HERE@#$here#g" "$tape" > "$dir/$name.tape"
  (cd "$here" && timeout 600 "${vhs[@]}" "$dir/$name.tape")
  if [ "$name" = install ]; then
    [ -f "$dir/daemon.pid" ] && kill "$(cat "$dir/daemon.pid")" 2>/dev/null || true
  else
    kill "$harness" 2>/dev/null || true
  fi
  echo "$name: $dir/$name.mp4 (log: $dir/harness.log)"
done
