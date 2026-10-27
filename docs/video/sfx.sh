#!/bin/bash
# sfx.sh: the chiptune accents, square waves made with FFmpeg: audio/sfx-card.mp3 (a rising two-note blip when a
# title or chapter card comes in) and audio/sfx-key.mp3 (a short tick for a key press). build.mjs plays them quietly.
set -euo pipefail
cd "$(dirname "$0")"
sq() { echo "0.5*sgn(sin(2*PI*$1*t))*exp(-${2}*t)"; } # a square wave of $1 Hz that decays at $2
ffmpeg -v error -y -f lavfi -i "aevalsrc='if(lt(t,0.07),$(sq 660 6),$(sq 990 9))':s=44100:d=0.32" -af "afade=t=out:st=0.24:d=0.08" -ac 1 -b:a 64k audio/sfx-card.mp3
ffmpeg -v error -y -f lavfi -i "aevalsrc='$(sq 1320 40)':s=44100:d=0.12" -af "afade=t=out:st=0.06:d=0.06" -ac 1 -b:a 64k audio/sfx-key.mp3
ls -l audio/sfx-*.mp3
