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

Run `:Pair find on`. Search by meaning runs its model, EmbeddingGemma 2, with LiteRT-LM in a small Python helper, and
Pair fetches both itself; it first says what and how big:

```
Pair: Search by meaning: installing LiteRT-LM 0.19.0 (33 MB from PyPI, SHA-256 pinned) in a venv in Pair's data folder, then downloading EmbeddingGemma 2 (text, 270M) (165 MB from Hugging Face, SHA-256 checked), once…
```

It needs Python 3.10 or later on your machine; the venv is Pair's own, in its data folder, and pip installs only the
one wheel pinned by its SHA-256. Without such a Python (or on a machine LiteRT-LM has no wheel for), it says what to
do in one line and the word search keeps working. Neovim shows how far each download is, and the ledger books both.

Then Pair embeds the project in the background, on two cores at low priority; Neovim shows how far as a progress
message. A project the size of Pair's own (550 files) takes about nine minutes the first time; after that, a save
only embeds the pieces you changed. (Already running an embedding model, in llama.cpp or Ollama? Put it in the config
as `embedding` instead: [another embedding model](../meaning.md#another-embedding-model). Would rather install
LiteRT-LM by hand, or have a Python with it already? See [turn EmbeddingGemma on](../meaning.md#turn-embeddinggemma-on).)

## 3. Search

Press `Alt-s` again and type what you mean:

```
> wait longer after each failed delivery
```

Your words find nothing; stop typing, and the closest pieces join the list a moment later, best first, each as
`file:line` and its first line of code, with the piece in the preview. `Enter` opens it at its line, `<C-q>` sends the
list to quickfix. In Visual mode, `Alt-s` starts with the selected words; `:Pair find <words>` works too, and
`/find <words>` in the chat.

## 4. What it did

`:Pair today` lists LiteRT-LM's install, the model's download, the index's build and each piece you opened from a search, and `⏎` on one shows the ranking: each
piece's similarity to your words, and whether your words were in it.

`:Pair find off` deletes the model, the indexes and the venv Pair made again. More, including how the two rankings meet and what the
index holds, is in [Search by meaning](../meaning.md).
