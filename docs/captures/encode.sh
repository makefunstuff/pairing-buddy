#!/usr/bin/env bash
# Turns the recordings in out/ into the docs' GIFs and stills, and those in out/site/ (record.sh with CAP_LOOK=site)
# into the front page's loops and posters. ./encode.sh site does only the loops; with no argument, the loops are
# encoded too when out/site/ is there. Needs FFmpeg (with libvpx-vp9, libx264 and libwebp).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/out
SITE=$HERE/../../site/public/media
IMAGES=$HERE/../images
ff() { ffmpeg -v error -y "$@"; }

loop() { # loop <recording> <site name> <cut> <speed> <end>: the lead-in up to <cut> s plays <speed> times as fast,
  # so the payoff shows within about 2.5 s; the rest plays as recorded, up to <end> s. 1280x768 WebM and MP4, 25 fps,
  # no audio. Landing.vue's callouts are timed on these clips: move them with the numbers here.
  local vf="[0:v]trim=0:$3,setpts=(PTS-STARTPTS)/$4[a];[0:v]trim=$3:$5,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1,fps=25[v]"
  ff -i "$OUT/site/$1.mp4" -filter_complex "$vf" -map '[v]' -an -c:v libvpx-vp9 -b:v 0 -crf 38 -row-mt 1 -pix_fmt yuv420p "$SITE/$2.webm"
  ff -i "$OUT/site/$1.mp4" -filter_complex "$vf" -map '[v]' -an -c:v libx264 -crf 28 -preset veryslow -pix_fmt yuv420p -movflags +faststart "$SITE/$2.mp4"
}
poster() { ff -i "$OUT/site/$1.png" -c:v libwebp -quality 85 "$SITE/$2.webp"; }

# The loops, when CAP_LOOK=site recorded them: always with ./encode.sh site, and with no argument if out/site/ is there.
if [ "${1:-}" = site ] || [ -d "$OUT/site" ]; then
  loop wrong-turn m1 12.4 6 25.5; poster remark m1-poster
  loop tests-on-save m2 9.4 5 24.4; poster regression m2-poster
  loop hand-over m3 5.6 4 20.4; poster hand-back m3-poster
  ls -l "$SITE"/m?.* "$SITE"/m?-poster.webp
fi
[ "${1:-}" != site ] || exit 0
gif() { # 1000x600, 15 fps, one palette for the whole clip
  ff -i "$OUT/$1.mp4" -vf "fps=15,scale=1000:600:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" "$IMAGES/$1.gif"
}

for name in wrong-turn tests-on-save hand-over take-back held-thought ledger context-card crash delight agents teach notes pickup debrief loop hand-over-run chat; do gif "$name"; done
# The ledger's stills from its video: the list before u (5.6 s) and after it (8.5 s), see tapes/ledger.tape.
frame() { ff -ss "$2" -i "$OUT/$1.mp4" -frames:v 1 "$IMAGES/$3.png"; }
frame ledger 5.6 ledger; frame ledger 8.5 ledger-undone
# The chat's command menu and key help from its video, 7.3 s and 3 s before the end (see tapes/chat.tape: VHS's
# screenshots of them came out stale).
ff -sseof -7.3 -i "$OUT/chat.mp4" -frames:v 1 "$IMAGES/chat-menu.png"
ff -sseof -3 -i "$OUT/chat.mp4" -frames:v 1 "$IMAGES/chat-help.png"
for name in gaze remark jump regression regression-fix driving hand-back held held-shown context context-trimmed build-error crash-jump crash new-warning delight agents-line agents-list teach-hint teach notes-margin notes-decision notes-tasks pickup pickup-jump debrief debrief-edit loop-same loop-moved loop-runs run-hand-back chat-empty chat-remark chat-working chat-answer chat-find chat-select chat-narrow chat-wide; do cp "$OUT/$name.png" "$IMAGES/$name.png"; done
# push-to-talk needs whisper.cpp to record (see README.md), so it is encoded only when it was recorded.
if [ -e "$OUT/push-to-talk.mp4" ]; then
  gif push-to-talk
  cp "$OUT/listening.png" "$IMAGES/listening.png"
  cp "$OUT/answer.png" "$IMAGES/spoken-answer.png"
fi
# The blank page: its clip as a GIF, the first run's stills.
gif blank-page
for name in blank-question blank-slice first-run-typing first-run; do cp "$OUT/$name.png" "$IMAGES/$name.png"; done
ls -l "$IMAGES"/*.gif
# The search trail: the README's GIF and the docs' stills.
gif search-trail
for name in trail-cue trail-panel trail-jump; do cp "$OUT/$name.png" "$IMAGES/$name.png"; done
