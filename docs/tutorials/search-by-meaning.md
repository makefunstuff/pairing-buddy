---
description: "Find code when you do not know what it is called: Alt-s, a live picker with your words on every key and their meaning as you pause."
---

# Search by meaning

You know what the code does, not its name: somewhere it waits longer after each failed delivery, and grep for
"retry" finds nothing. Search the project by what you mean. Three minutes, once.

## 1. Search by words, at once

In Neovim, in your project, press `Alt-s` and type. The picker works like `live_grep`, with loose words: on every key
it shows the pieces of code (functions, classes, methods with their doc comments) that have all your words, with
identifiers split, so `delivery fail` finds `onDeliveryFailed`. Its title says `words only: :Pair find on adds
meaning`: no model yet.

## 2. Add meaning

Search by meaning runs its model, EmbeddingGemma 2, with LiteRT-LM in a small Python helper. Put it in a venv where
Pair looks for it (Python 3.10 or later):

```sh
python3 -m venv ~/.local/state/pairing-buddy/meaning/venv
~/.local/state/pairing-buddy/meaning/venv/bin/pip install litert-lm-api==0.19.0
```

`pair doctor` checks it: `✓ meaning  words only: :Pair find on downloads EmbeddingGemma 2 (text, 270M) (165 MB, once)
for meaning, or set an "embedding" model; LiteRT-LM 0.19.0 in … is ready`.

Then `:Pair find on` downloads the model (165 MB from Hugging Face, checked by its SHA-256), and Pair embeds the
project in the background, on two cores at low priority; Neovim shows how far as a progress message. A project the
size of Pair's own (550 files) takes a quarter of an hour the first time; after that, a save only embeds the pieces
you changed. (Already running an embedding model, in llama.cpp or Ollama? Put it in the config as `embedding` instead:
[another embedding model](../meaning.md#another-embedding-model).)

## 3. Search

Press `Alt-s` again and type what you mean:

```
> wait longer after each failed delivery
```

Your words find nothing; stop typing, and the closest pieces join the list a moment later, best first, each as
`file:line` and its first line of code, with the piece in the preview. `Enter` opens it at its line, `<C-q>` sends the
list to quickfix. In Visual mode, `Alt-s` starts with the selected words; `:Pair find <words>` works too, and `/find
<words>` in the chat.

## 4. What it did

`:Pair today` lists the index's build and each piece you opened from a search, and `⏎` on one shows the ranking: each
piece's similarity to your words, and whether your words were in it.

`:Pair find off` deletes the model and the indexes again. More, including how the two rankings meet and what the
index holds, is in [Search by meaning](../meaning.md).
