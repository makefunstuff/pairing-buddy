#!/bin/bash
# clips.sh: the tutorial's clips from the captures. docs/captures/record.sh records the Neovim scenes (t-*) at
# 1920x1080 with a real model (CAP_MODEL=deepseek), capture/run.sh the setup scenes straight into clips/. Each
# Neovim take is encoded once more for the film (H.264, 25 fps), so every clip has the same size and pixels.
# A sandboxed run (/gen try, /gen scaffold) prints its whole bwrap line in Pair's pane, with the sockets and folders
# of the machine it ran on: in those takes the pane's rows are covered, and the cover says so.
set -euo pipefail
cd "$(dirname "$0")"
out=../captures/out
font=$(fc-match -f '%{file}' 'JetBrainsMono Nerd Font')
# take: from:top,... the seconds Pair's pane shows the run, and its top in pixels from then (it grows as a split opens).
# They are this take's: after recording t-gen-try or t-gen-scaffold again, look at its frames and set them anew.
declare -A MASK=([t-gen-try]=26.8:760,30.6:640 [t-gen-scaffold]=35.2:760,53.5:690)
cover=$(mktemp)
trap 'rm -f "$cover"' EXIT
printf "Pair's pane: the run, in its sandbox (its command line, with this machine's paths, is covered)" > "$cover"
for take in "$out"/t-*.mp4; do
  name=$(basename "$take" .mp4)
  vf=null
  if [ -n "${MASK[$name]:-}" ]; then
    vf=
    phases=(${MASK[$name]//,/ })
    for i in "${!phases[@]}"; do
      IFS=: read -r from top <<< "${phases[$i]}"
      until=$(cut -d: -f1 <<< "${phases[$((i + 1))]:-99999:0}")
      on="enable='between(t,$from,$until)'"
      vf+="${vf:+,}drawbox=x=0:y=$top:w=1920:h=$((1030 - top)):color=0x0f1419:t=fill:$on,drawtext=fontfile='$font':textfile=$cover:fontsize=20:fontcolor=0x5c6773:x=12:y=$((top + 10)):$on"
    done
  fi
  ffmpeg -v error -y -i "$take" -an -vf "$vf" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -r 25 -movflags +faststart "clips/$name.mp4"
done
ls -l clips
