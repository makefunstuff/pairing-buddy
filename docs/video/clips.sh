#!/bin/bash
# clips.sh: the tutorial's clips from the captures. docs/captures/record.sh records the Neovim scenes (t-*) at
# 1920x1080 with a real model (CAP_MODEL=deepseek), capture/run.sh the setup scenes straight into clips/. Each
# Neovim take is encoded once more for the film (H.264, 25 fps), so every clip has the same size and pixels.
set -euo pipefail
cd "$(dirname "$0")"
out=../captures/out
for take in "$out"/t-*.mp4; do
  ffmpeg -v error -y -i "$take" -an -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -r 25 -movflags +faststart "clips/$(basename "$take")"
done
ls -l clips
