# Voice

Hold `Alt-t` in Neovim, ask aloud, let go: Pair answers under the line you asked on. Hearing runs on your CPU with
whisper.cpp, or through OpenRouter. Voice is off until you set it up; this takes about five minutes.

## 1. Choose who hears you

- **whisper.cpp, on your machine.** Nothing leaves it. Build it once:

  ```sh
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp ~/src/whisper.cpp
  cd ~/src/whisper.cpp
  cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF
  cmake --build build -j --target whisper-cli
  sh models/download-ggml-model.sh base.en
  ```

- **OpenRouter.** No build: a transcription model hears the recording, and a speech model can read answers aloud.
  The recording leaves your machine, and each question costs one transcription. You need an OpenRouter key.

You also need a recorder: `pw-record`, `parec` or `arecord`, which most desktops have.

## 2. Add it to the config

For whisper.cpp:

```jsonc
"voice": {
  "model": "~/src/whisper.cpp/models/ggml-base.en.bin",
  "whisper": "~/src/whisper.cpp/build/bin/whisper-cli"
}
```

For OpenRouter (the key in a file, or `apiKeyEnv`, or `auth` after `pair auth login openrouter`):

```jsonc
"voice": {
  "openrouter": {
    "apiKeyFile": "~/.config/openrouter.key",
    "hear": "openai/whisper-large-v3-turbo",
    "speak": {"model": "x-ai/grok-voice-tts-1.0", "voice": "eve"}
  }
}
```

`speak` is optional: it reads short answers aloud, and only when you are away from the editor.

## 3. Check it

```sh
pair doctor
```

The `voice` line says what records and what hears: for whisper.cpp it hears a second of silence and says how long it
took, for OpenRouter it asks whether the key and the models are taken. It records nothing and sends no audio.

## 4. Ask

1. In Neovim, on the line you want to ask about, hold `Alt-t`. A meter shows under the line: `listening   let go to ask`.

   ![Listening: the meter under the line](../images/listening.png)

2. Say your question, and let go. The line says `hearing`, then the words Pair heard, then its answer in their
   place, with `M-j` when it points at a line. The whole answer is in the chat too.

   ![The answer under the line you asked on; the line it points at has its note](../images/spoken-answer.png)

![Hold Alt-t: a meter under your line; let go: the words Pair heard, then its answer in their place](../images/push-to-talk.gif)

If your terminal makes holding awkward, tap `Alt-t` instead: Pair listens until you press it again, and the line
says `M-t again to ask`. Or set
`listen_mode = 'toggle'` in the plugin's setup: press to start, press again to ask. `:Pair listen` works without the
key.

## More

[Push-to-talk](../voice.md): every field, the key's timing, spoken answers, and what goes where.
