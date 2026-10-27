#!/bin/bash
# finish.sh [tour render] [short render]: from the HyperFrames renders (default renders/final.mp4 and
# renders/short.mp4), the files people watch: renders/pairing-buddy-tour.mp4 (1080p, under GitHub's 10 MB for a
# README video), the site's 720p hero.mp4, hero.webm and hero-poster.jpg with its captions and chapters (hero.vtt,
# hero-chapters.vtt), and renders/pairing-buddy-x.mp4, the cut for X. The sound is normalised to -16 LUFS;
# metadata is dropped.
set -euo pipefail
cd "$(dirname "$0")"
in=${1:-renders/final.mp4}
short=${2:-renders/short.mp4}
out=renders/pairing-buddy-tour.mp4
site=../../site/public/media
mix=$(mktemp --suffix=.wav)
trap 'rm -f "$mix"' EXIT
loud() { ffmpeg -v error -y -i "$1" -vn -af "loudnorm=I=-16:TP=-3:LRA=11,alimiter=limit=0.66:level=false" -ar 48000 "$mix"; }
loud "$in"
ffmpeg -v error -y -i "$in" -i "$mix" -map 0:v -map 1:a -map_metadata -1 -metadata title="pairing-buddy: a person in the second chair" \
  -c:v libx264 -preset veryslow -crf 38 -tune animation -x264-params aq-mode=3 -pix_fmt yuv420p -c:a aac -ac 1 -b:a 64k -movflags +faststart "$out"
ffmpeg -v error -y -i "$in" -i "$mix" -map 0:v -map 1:a -map_metadata -1 -vf scale=1280:720:flags=lanczos \
  -c:v libx264 -preset veryslow -crf 30 -tune animation -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart "$site/hero.mp4"
ffmpeg -v error -y -i "$in" -i "$mix" -map 0:v -map 1:a -map_metadata -1 -vf scale=1280:720:flags=lanczos \
  -c:v libvpx-vp9 -b:v 0 -crf 48 -row-mt 1 -cpu-used 2 -c:a libopus -b:a 80k "$site/hero.webm"
# The poster: Pair's words under your line, in "Then it speaks" (chapters.json has the times).
ffmpeg -v error -y -ss 116 -i "$out" -frames:v 1 -vf scale=1280:720 -q:v 3 "$site/hero-poster.jpg"
cp captions.vtt "$site/hero.vtt"
cp chapters.vtt "$site/hero-chapters.vtt"
if [ -e "$short" ]; then
  loud "$short"
  ffmpeg -v error -y -i "$short" -i "$mix" -map 0:v -map 1:a -map_metadata -1 -metadata title="pairing-buddy" \
    -c:v libx264 -preset slow -crf 22 -tune animation -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart renders/pairing-buddy-x.mp4
fi
ls -l renders/pairing-buddy-*.mp4 "$site"/hero*
