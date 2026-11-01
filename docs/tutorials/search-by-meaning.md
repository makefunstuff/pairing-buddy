---
description: "Find code when you do not know what it is called: Alt-s searches the project by meaning, in Telescope, snacks.picker or fzf-lua."
---

# Search by meaning

You know what the code does, not its name: somewhere it waits longer after each failed delivery, and grep for
"retry" finds nothing. Search the project by what you mean. Three minutes, once.

## 1. Install the runtime

Search by meaning runs its model with LiteRT-LM, in a small Python helper. Put it in a venv where Pair looks for it
(Python 3.10 or later):

```sh
python3 -m venv ~/.local/state/pairing-buddy/meaning/venv
~/.local/state/pairing-buddy/meaning/venv/bin/pip install litert-lm-api==0.19.0
```

`pair doctor` checks it: `✓ meaning  search by meaning is off: :Pair find on downloads EmbeddingGemma 2 (text, 270M)
(165 MB, once); LiteRT-LM 0.19.0 in … is ready`.

## 2. Turn it on

In Neovim, in your project, press `Alt-s`. Pair asks whether to download the model (165 MB from Hugging Face,
checked by its SHA-256); choose `Download`. Neovim says when it is there, and Pair indexes the project in
the background, on two cores at low priority. A project the size of Pair's own (540 files) takes about eight minutes
the first time; after that, a save only embeds the chunks you changed.

## 3. Search

Press `Alt-s` again and type what you mean:

```
Find by meaning: wait longer after each failed delivery
```

The closest chunks open in Telescope (or snacks.picker, or fzf-lua), best first, each as `file:line` and its first
line, with the chunk in the preview. `Enter` opens it at its line. In Visual mode, `Alt-s` searches for the selected
words; `:Pair find <words>` works too.

## 4. What it did

`:Pair today` lists the index's build and each search, and `⏎` on a search shows its ranking: each chunk's similarity
to your words, and whether your words were in it.

`:Pair find off` deletes the model and the indexes again. More, including how the two rankings fuse and what the
index holds, is in [Search by meaning](../meaning.md).
