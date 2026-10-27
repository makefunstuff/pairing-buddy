#!/bin/bash
# clips.sh: the film's clips from the captures. docs/captures/record.sh records the shipped plugin at 1400x840
# (out/), capture/run.sh records the setup scenes at 1920x1080 (clips/start.mp4, clips/install.mp4). Each 1400x840
# recording is scaled to 1800x1080 and padded with the terminal's background to 1920x1080, so every clip has one
# coordinate space (P() in build.mjs maps a capture's own pixels into it). Push-to-talk is not recorded by default
# (it needs whisper.cpp), so its clip comes from the README's GIF of it.
set -euo pipefail
cd "$(dirname "$0")"
out=../captures/out
enc() { ffmpeg -v error -y "$@" -an -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -r 25 -movflags +faststart; }
fit() { echo "scale=1800:1080:flags=lanczos,pad=1920:1080:60:0:color=$1"; }
for name in wrong-turn tests-on-save hand-over take-back held-thought search-trail ledger context-card crash delight agents teach notes pickup debrief loop blank-page first-run hand-over-run no-herdr; do
  color='#0F1419'; [ "$name" = held-thought ] && color='#131517'
  enc -i "$out/$name.mp4" -vf "$(fit "$color")" "clips/$name.mp4"
done
enc -i ../images/push-to-talk.gif -vf "$(fit '#0F1419')" clips/push-to-talk.mp4
ls -l clips
