#!/bin/bash
# finish.sh [render]: from the HyperFrames render (default renders/final.mp4), the files people watch:
# renders/pairing-buddy-tour.mp4 (1080p, under GitHub's 10 MB for a README video) and the site's 720p
# hero.mp4, hero.webm and hero-poster.jpg. The sound is normalised to -16 LUFS; metadata is dropped.
set -euo pipefail
cd "$(dirname "$0")"
in=${1:-renders/final.mp4}
out=renders/pairing-buddy-tour.mp4
site=../../site/media
mix=$(mktemp --suffix=.wav)
trap 'rm -f "$mix"' EXIT
ffmpeg -v error -y -i "$in" -vn -af "loudnorm=I=-16:TP=-3:LRA=11,alimiter=limit=0.66:level=false" -ar 48000 "$mix"
ffmpeg -v error -y -i "$in" -i "$mix" -map 0:v -map 1:a -map_metadata -1 -metadata title="pairing-buddy: a person in the second chair" \
  -c:v libx264 -preset veryslow -crf 30 -tune animation -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart "$out"
ffmpeg -v error -y -i "$in" -i "$mix" -map 0:v -map 1:a -map_metadata -1 -vf scale=1280:720:flags=lanczos \
  -c:v libx264 -preset veryslow -crf 28 -tune animation -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart "$site/hero.mp4"
ffmpeg -v error -y -i "$in" -i "$mix" -map 0:v -map 1:a -map_metadata -1 -vf scale=1280:720:flags=lanczos \
  -c:v libvpx-vp9 -b:v 0 -crf 48 -row-mt 1 -cpu-used 2 -c:a libopus -b:a 80k "$site/hero.webm"
ffmpeg -v error -y -ss 24.5 -i "$out" -frames:v 1 -vf scale=1280:720 -q:v 3 "$site/hero-poster.jpg"
ls -l "$out" "$site"/hero*
