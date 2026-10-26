#!/usr/bin/env bash
# Turns the recordings in out/ into the site's clips and stills and the README's GIFs and stills. Needs FFmpeg
# (with libvpx-vp9, libx264 and libwebp).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/out
SITE=$HERE/../../site/media
IMAGES=$HERE/../images
ff() { ffmpeg -v error -y "$@"; }

clip() { # clip <recording> <site name>: 1280x768 WebM and MP4, 25 fps, no audio
  ff -i "$OUT/$1.mp4" -vf scale=1280:768:flags=lanczos -an -c:v libvpx-vp9 -b:v 0 -crf 40 -row-mt 1 -pix_fmt yuv420p "$SITE/$2.webm"
  ff -i "$OUT/$1.mp4" -vf scale=1280:768:flags=lanczos -an -c:v libx264 -crf 30 -preset veryslow -pix_fmt yuv420p -movflags +faststart "$SITE/$2.mp4"
}
still() { ff -i "$OUT/$1.png" -vf scale=1280:768:flags=lanczos -c:v libwebp -quality 82 "$SITE/$2.webp"; }
gif() { # 1000x600, 15 fps, one palette for the whole clip
  ff -i "$OUT/$1.mp4" -vf "fps=15,scale=1000:600:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" "$IMAGES/$1.gif"
}

clip wrong-turn m1; still remark m1-still1; still jump m1-still2
clip tests-on-save m2; still regression m2-still1; still regression-fix m2-still2
clip hand-over m3; still driving m3-still1; still hand-back m3-still2
for name in wrong-turn tests-on-save hand-over take-back; do gif "$name"; done
for name in gaze remark jump regression regression-fix driving hand-back; do cp "$OUT/$name.png" "$IMAGES/$name.png"; done
# The blank page: its clip as a GIF, the first run's stills.
gif blank-page
for name in blank-question blank-slice first-run-typing first-run; do cp "$OUT/$name.png" "$IMAGES/$name.png"; done
ls -l "$SITE"/m?.* "$SITE"/m?-still* "$IMAGES"/*.gif
