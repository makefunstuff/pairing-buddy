# The video: a tutorial of Pair

A tutorial that teaches how Pair works, one idea per scene, in eight chapters: setup and `pair doctor`, the roles
(Watcher, Partner, Navigator, Scout, Driver), exploring code (the wrong turn), tests on save, notes and the blank
page, the hand-over (and taking the wheel back), voice, and Pair with or without herdr. It starts with what Pair is
and the screen you will see, and ends on the keys to remember. A short cut for social media shows three of its
moments.

It plays in the [README](../../README.md) and on the [website](https://makefunstuff.github.io/pairing-buddy/#tour),
where the chapter buttons jump into it.

## How a scene teaches

- **A title card first.** It says the situation and where to look ("A test fails, and you start fixing the wrong
  file. Watch: the margin, under the line you change"), with a small map of the screen that lights that area.
- **Then the capture, at an everyday font size.** Each Neovim scene is a whole 1920x1080 terminal at 16 px, with the
  same layout every time: your code, your terminal under it, Pair's chat on the right, the statusline at the bottom.
  The first scene names the four areas. The camera starts on the whole screen and moves in on the spot that changes;
  the rest dims, and a box with a pointer says what it is. Code that changes gets a before and after.
- **One line sums it up** at the end, over the last frame.
- **Calm pacing.** Every line of the voice is timed to the moment it describes. When a line would come after its
  moment, because the one before it is still being said, the picture holds still just before that moment until the
  voice is there. Waits (a model thinking, you typing an answer) are sped up and say so ("Pair thinks · 4× speed").
- **Captions** for everything said, and chips for what is typed and the keys pressed.

## The look

An old console, to match the site's pixel-art theme: flat colours from a small palette (PICO-8's), no gradients,
glows, blur or soft shadows. Titles are in Press Start 2P, labels in Silkscreen, captions and the cards' sentences in
Pixelify Sans; borders are hard, corners square and shadows solid and stepped. The capture sits in a pixel window
whose title bar names the scene, and the five roles each have a 12x12 sprite. Cards come in with a pixel wipe and go
with a stepped dissolve, boxes blink on, the camera moves in a few hard steps, and once it zooms past 1:1 the capture
is scaled with nearest neighbour, so the zoomed text stays crisp. The capture itself is a real Neovim at 16 px.
Quiet square-wave blips (`sfx.sh`) mark each card and key press, over a chiptune bed.

## What is real

- **The Neovim scenes** (`docs/captures/tapes/t-*.tape`) run the plugin and the daemon of this checkout with a real
  model, DeepSeek (`deepseek-flash` for both roles), with nothing scripted: what Pair says, the tools it calls, its
  ghost text and the cases it types are the model's, from one take each. Neovim runs without herdr: `:Pair chat`
  opens the chat and Pair's pane is a `:terminal`. The voice scene hears its question for real: espeak-ng says it
  into the recorder and a CPU build of whisper.cpp writes it down.
- **The setup scenes** (`capture/`): `install` runs the real `npm install -g github:makefunstuff/pairing-buddy` and
  `pair setup` in an empty sandbox home. `start` shows a one-model config for DeepSeek, `pair auth list` with its key
  stored, and `pair doctor` against DeepSeek.
- **The voice** of the narration is ElevenLabs v4 and the music Google Lyria 3, both through OpenRouter.

## Make it again

Node.js 22+, FFmpeg, Go, a C compiler, clangd, bubblewrap, Neovim 0.11+, VHS 0.11 with ttyd, the JetBrainsMono Nerd
Font, espeak-ng, whisper.cpp built for the CPU with its `base.en` model ([voice.md](../voice.md#1-build-whispercpp-cpu-only)),
a DeepSeek key in `~/.pi/agent/auth.json` (`{"deepseek": {"type": "api_key", "key": "…"}}`, where the key may also be
`!command` that prints it), and an OpenRouter key in `/tmp/openrouter.key` (or `$OPENROUTER_KEY_FILE`). Both keys are
read at run time and never printed: the DeepSeek key goes only into each sandbox's own `auth.json`, never into an
environment variable the recorded shells could show.

```sh
export CAP_MODEL=deepseek CAP_WHISPER_MODEL=/path/to/ggml-base.en.bin CAP_WHISPER=/path/to/whisper-cli
../captures/record.sh t-wrong-turn t-scout t-tests-on-save t-notes t-blank-page t-hand-over t-take-back t-push-to-talk
capture/run.sh                 # clips/install.mp4 and clips/start.mp4 (or name one tape)
./clips.sh                     # the Neovim takes into clips/
node tts.mjs [line ...]        # audio/<line>.mp3 for each line of script.mjs (new or changed lines only, unless named)
node words.mjs                 # words.json: when each word is said, for the captions
node music.mjs                 # audio/music.mp3, the chiptune bed under the voice
./sfx.sh                       # audio/sfx-card.mp3 and audio/sfx-key.mp3, the blips
node build.mjs                 # index.html, captions.vtt, chapters.json, chapters.vtt and frames/
node build.mjs short           # short.html and captions-short.vtt
npx hyperframes@0.8.205 render . --quality delivery --no-browser-gpu --output renders/final.mp4
npx hyperframes@0.8.205 render . -c short.html --quality delivery --no-browser-gpu --output renders/short.mp4
./finish.sh                    # the files people watch, see below
```

A real model says something different on every take, so after recording a scene again, look at it (for example
`ffmpeg -ss <t> -i ../captures/out/t-<scene>.mp4 -frames:v 1 x.png` at the moments it changes) and move that
scene's times and boxes in `script.mjs` to match. The tapes wait for what they need on screen (a question, a
suggestion, "u undoes it") rather than for a fixed time, and fail when it does not come; record that scene again.

`finish.sh` writes `renders/pairing-buddy-tutorial.mp4` (1080p), `renders/pairing-buddy-tutorial-readme.mp4` (the
same at 1080p in two passes to under 10 MB, GitHub's limit for an upload, for the README), the site's `hero.mp4`, `hero.webm`,
`hero-poster.jpg`, `hero.vtt` and `hero-chapters.vtt`, and `renders/pairing-buddy-short.mp4`, the cut for social
media. The README plays the tutorial from a GitHub attachment (GitHub plays a video in a README only from its own
attachments, not from a file in the repository): drop `pairing-buddy-tutorial-readme.mp4` into any comment box on
github.com, put the `user-attachments` link it gives in the README, and clear the box without posting it. The chapter times in the README and on the site come from
`chapters.json`.

`script.mjs` holds the scenes: the title cards, the shots (which stretch of a take, and how fast), the lines of the
voice and when each is said, where the camera goes, the boxes (`spots`), the typed text and keys, the before/after
and the sums; it says how in its header. Times are seconds into a scene's shots, `at(t)` (a moment of the take,
wherever its shot plays it) or `{line: n}` (when the voice starts its nth line). Boxes are in a take's pixels: `G()`
takes terminal cells of a Neovim take, `T()` of a setup take. `build.mjs` turns the script into the composition.

## Keeping it public

Every capture runs as a user whose home is a scratch folder under `/tmp`, with its own socket, so no personal path
or host can show, and the running pairing-buddy service is never touched: the daemon gets a socket in that folder,
`capture/systemctl` stands in for `systemctl --user` during `pair setup`, and the shell the tapes type into has no
variable whose name holds KEY, TOKEN, SECRET or PASSWORD. The scratch folders go when a take ends. Before a new
video is published, OCR its frames and check them and the file's metadata for usernames, home paths, hosts, IP
addresses, ports and keys.

Fonts: Press Start 2P, Silkscreen, Pixelify Sans and JetBrains Mono (`fonts/`, SIL Open Font License). The colorscheme
of the captures is ayu (Apache License 2.0), and `vendor/gsap.min.js` is under GSAP's own licence, not MIT: see
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) for these and for where the voice and the music come from.
