#!/bin/sh
# Makes Pair's four earcons from sine waves with ffmpeg: each under a second, its peak below -10 dB. CC0.
set -e
cd "$(dirname "$0")"
note() { # note FREQ START DECAY: a sine from START seconds, with a short attack and an exponential decay
  echo "gte(t,$2)*sin(2*PI*$1*(t-$2))*min(1,(t-$2)/0.008)*exp(-(t-$2)*$3)"
}
earcon() { # earcon NAME SECONDS EXPRESSION
  ffmpeg -v error -y -f lavfi -i "aevalsrc='$3':s=22050:d=$2" -ac 1 -c:a pcm_s16le -fflags +bitexact -flags:a +bitexact -map_metadata -1 "$1.wav"
}
# green: two notes up, after a red run
earcon green 0.7 "0.26*($(note 659.25 0 14)+$(note 987.77 0.12 6))"
# red: one low note, with its octave so laptop speakers carry it
earcon red 0.6 "0.2*($(note 220 0 5)+0.4*$(note 440 0 7))"
# tick: Pair speaks, felt more than heard
earcon tick 0.08 "0.32*$(note 1760 0 70)"
# handback: the Driver is done, a fifth down
earcon handback 0.7 "0.22*($(note 880 0 14)+$(note 587.33 0.12 6))"
