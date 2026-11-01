---
description: "Search your project by what you mean, not only the exact words: a local EmbeddingGemma 2 index, hybrid ranking, in Telescope, snacks.picker or fzf-lua."
---

# Search by meaning

You know what the code does, not what it calls it. Press `Alt-s`, type "how long to wait before trying again", and
Pair shows the project's chunks of code closest to what you mean, best first, in your picker: `backoff.js:1`, where
the code says `nextDelay` and `attempt`. Choosing one opens it at its line.

It runs on your machine. A small embedding model, EmbeddingGemma 2, turns each chunk of your project into 256 numbers
once, and each search into 256 more; the closest chunks win, together with the chunks that have your words. Nothing
leaves the machine but the model's one download.

## Turn it on

It is off until you say yes. The first `Alt-s` (or `:Pair find`) asks:

> Search by meaning needs its model, EmbeddingGemma 2 (165 MB from Hugging Face, once, checked by its SHA-256). Then
> Pair indexes the project in the background, in its own data folder. Download it now?

`Download` fetches the model and starts the index; `Not now` leaves everything as it was, and the next `Alt-s` asks
again. `:Pair find on` downloads it without asking. Off by default, because a download and a few minutes of two
cores for the first index are not something Pair should do by itself.

The model runs on [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM), Google's on-device runtime, in a small
Python helper Pair starts. Install it once, the way whisper.cpp is installed for [voice](voice.md): Pair looks for a
virtual environment in its data folder first.

```sh
python3 -m venv ~/.local/state/pairing-buddy/meaning/venv
~/.local/state/pairing-buddy/meaning/venv/bin/pip install litert-lm-api==0.19.0
```

It needs Python 3.10 or later; LiteRT-LM has wheels for Linux (x86-64 and ARM64) and macOS on Apple silicon.
Any other Python with `litert-lm-api` works too: set `"meaning": {"python": "/path/to/python"}` in the
[config](config.md#meaning). `pair doctor` says what is missing, with the line to run:

```
✓ meaning  EmbeddingGemma 2 (text, 270M) (revision 9be6e8b, SHA-256 checked) on LiteRT-LM 0.19.0 in ~/.local/state/pairing-buddy/meaning/venv/bin/python; pairing-buddy: 539 files, 3830 chunks, 3.9 MB, 132 ms a chunk
```

## Search

| | |
| --- | --- |
| `Alt-s` | Asks for your words, then searches; in Visual mode, searches for the selected words |
| `:Pair find <words>` | The same, with the words given |
| `:Pair find on` / `:Pair find off` | Download the model and index the open projects / delete the model and every index |

The results open in Telescope if you have it, else snacks.picker, else fzf-lua, else `vim.ui.select`
(`meaning_picker` in [setup](neovim-plugin.md#setup) picks one). Each line is `file:line` and the chunk's first
line; the preview shows the chunk in its file. They are in Pair's order until you type, and what you type filters them
as in any picker. `Enter` opens the file at the chunk's first line. While the index is still being built, the
picker's title says how far (`index 40% built`), and the chunks not yet embedded can still come up for your words.

## How it ranks

Two rankings, fused:

- **By meaning.** Your words, as a search (`task: search result | query: …`), against every chunk (`title: <path> |
  text: …`): the prompts EmbeddingGemma was trained with. The closest by cosine similarity, within 0.1 of the best
  (unrelated code scores close too, so a fixed cut-off would not do).
- **By words.** BM25 over the chunks' words, with identifiers split as well (`retryCount` is `retry` and `count` too)
  and the small words of a question left out.

Each chunk scores `1/(60 + rank)` in each ranking it is in, summed: reciprocal rank fusion, as in lfm-pixel's notes
search, rather than adding scores that are on different scales. A chunk both rankings like goes first; an exact
identifier only the code has still comes up; a question in other words than the code's comes up by meaning alone.

On lfm-pixel's notebook of questions worded unlike the notes, this model got recall@5 0.98 where keywords got 0.03.
On a small project of code (`test/live/meaning.test.mjs`) it put the right file first for each of six such questions.

## The index

- **What goes in.** The files git lists, tracked and untracked, without what `.gitignore` leaves out; without git,
  ripgrep's list, which keeps to `.gitignore` too. Not pictures, sound, archives, fonts, lockfiles, source maps,
  minified files, files over 512 KB, or binaries.
- **Chunks.** At most 60 lines and 1,500 characters, about 400 tokens, cut at a blank line in the second half where
  there is one, so a function stays whole where it can.
- **Built in the background**, once a project has a session: in batches of four chunks, on two cores (`meaning.threads`)
  at low priority (`nice 10`). A search goes before the batches still waiting, so it waits for one batch at most.
- **Kept up to date.** A save re-reads that file and embeds only its changed chunks; each chunk is known by its text's
  hash, so a restart, a moved function or a branch switch back embeds nothing twice. Changes made outside Neovim (a
  checkout, a pull) are found when the session loads and every ten minutes.
- **Kept in Pair's data folder**, `meaning/index/<hash of the project's path>.idx`, never in the project: 256 numbers
  (1 KB) per chunk. A build in progress is written down every 30 s, so a restart keeps most of it.
- **The helper stops** after three minutes with nothing to embed, and gives its memory back (about 320 to 490 MB
  while it runs); the next search or save starts it again in under a second.

On this repository (539 files, 4 MB of code and docs, on a Ryzen 5 9600X):

| | |
| --- | --- |
| First index | 3,830 chunks in 8.5 min, 132 ms a chunk on two cores |
| Index on disk | 3.9 MB |
| A search | 25 to 85 ms once the helper runs; under a second more when it has to start |
| Model load | 0.1 to 0.8 s |
| A save | the file's changed chunks, a fraction of a second each |

## The search trail

When you hunt for something in your pickers and it is not there under your words, Pair's [search
trail](neovim.md#the-search-trail) remark already gets what ripgrep finds for each of your searches. With search by
meaning on, it also gets the two chunks closest to what each search means, as `by meaning: worker.go:30-58 …` lines:
where the thing is when the code calls it something else. That changes what Pair knows when it speaks, not when it
speaks: the speak gate, the talk budget and the wait for your break are the same as for every trail.

## In the ledger

`:Pair today` lists each build (`indexed 3830 chunks by meaning in 507 s: 539 files, 3830 chunks, 3991 KB`), each
search (`searched by meaning "how long to wait": 30 results, first src/backoff.js:1`, `⏎` shows the ranking with each
chunk's similarity and whether your words matched), each lookup for the search trail, and the model's download.

## Why this model and runtime

- **EmbeddingGemma 2, text, 270M.** Apache-2.0, multilingual and good at code (MTEB code 78.7 at 768 numbers, 76.2
  at the 256 Pair keeps), and small: a 165 MB file. Its numbers can be cut to 256 and normalized again with little
  loss, a third of the storage. It is the model lfm-pixel uses for its notes, measured there first.
- **LiteRT-LM, natively, in a Python helper.** The same runtime and the same model file lfm-pixel measured, with its
  native CPU kernels. The alternatives that run inside Node were tried on this repository: ONNX Runtime Web (the
  WebAssembly build) took 2.5 s a chunk where LiteRT-LM takes 0.13 s, so the first index would take hours;
  `onnxruntime-node` downloads its CUDA libraries from NuGet when it is installed on Linux, a network step on every
  `npm install` of Pair; and LiteRT-LM's own npm package is for the browser and WebGPU. A Python helper that you
  install once costs Pair nothing for everyone who never turns it on.
- **The download.** The pinned revision `9be6e8b9` of
  [litert-community/embeddinggemma-2-text-270m-litert-lm](https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm),
  file `embeddinggemma-2-text-270m.litertlm`, 164,626,432 bytes, written to a `.part` file while its SHA-256 is taken
  and kept only if it is `2d079ee2…ab286fb`. Its checksum is noted next to it, so a restart does not read it again; a
  file changed since is not trusted. It is never committed or shipped with Pair.

## Turn it off

`:Pair find off` stops the helper and deletes the model and every index from Pair's data folder; the next `Alt-s`
offers the download again. `"meaning": false` in the [config](config.md#meaning) turns it off for good: `Alt-s` then
says so, and nothing is downloaded or indexed.
