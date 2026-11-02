---
description: "Find code as quickly as ripgrep with loose words: a live picker, words on every key and meaning from a local index as you pause."
---

# Search by meaning

You know what the code does, not what it calls it. Press `Alt-s` and type "method that removes user": the picker
works like `live_grep`. On every key it shows the pieces of code that have your words, with identifiers split
(`removeUserFromTeam` is also remove, user, from and team), comments and strings too. Stop typing for 150 ms and the
pieces closest to what you mean join the list below them: in Pair's own code, `src/auth.mjs:46 export async function
logout({id, credentials})` first, though it says neither "remove" nor "user". Nothing you already see moves. `Enter` opens a piece at its line, and in
Telescope `<C-q>` sends the hits to the quickfix list.

The word search works on its own, with no model at all. Meaning needs an embedding model: EmbeddingGemma 2, which
Pair downloads once when you say so and runs on your machine, or a model of your own behind an OpenAI-compatible
`/v1/embeddings` ([below](#another-embedding-model)). Nothing leaves the machine but EmbeddingGemma's one download and
its runtime's, unless you point Pair at a server elsewhere.

## Search

| | |
| --- | --- |
| `Alt-s` | Opens the live picker; in Visual mode, with the selected words typed in it |
| `:Pair find [words]` | The same, with the words typed in it |
| `:Pair find on` / `:Pair find off` | Install LiteRT-LM, download EmbeddingGemma 2 and embed the open projects / delete the model, every index and the venv Pair made |
| `:Pair index rebuild` | Make the project's index again from its files, every vector too |
| `/find <words>` | In the [chat](chat.md): the ten best pieces, meaning and words fused, as `file:line` lines |

The picker is Telescope if you have it, else snacks.picker, else fzf-lua, else `vim.ui.select`
(`meaning_picker` in [setup](neovim-plugin.md#setup) picks one; `meaning_debounce_ms` is the pause, 150 ms). Each line
is `file:line` and the piece's first line of code (its doc comment is above it; the preview shows both). The list is
in Pair's order: the words' hits as they came, best first by BM25, then meaning's, best first. `Enter` opens the piece
at that line. In Telescope, `<C-q>` sends every hit to the quickfix list, as in any picker; in snacks.picker it is
`<C-q>` too, and in fzf-lua `ctrl-q` sends the selected ones.

The picker's title says what is missing: `words only: :Pair find on adds meaning` without a model, `index 40% built`
while the first build runs, and how long meaning took once it came (`Find (31 ms)`). With `vim.ui.select`, which
cannot change while it is open, you type your words first and get one list, meaning and words fused (as `/find`).

Scout's and the Driver's `search` tool can ask the index too: with `meaning: true` it searches by meaning and words
instead of ripgrep, for "where do we …" in your words, and when ripgrep finds nothing for two or more plain words, the index's
best pieces come with its "No matches." ([scout.md](scout.md)).

## How it ranks

- **Words, on every key.** The pieces that have every word you typed, each as the start of one of theirs (`retr`
  finds `retryCount`, `removes` finds `removeUser`: words are stemmed), ranked by BM25. Identifiers are split, and
  comments, strings and the file's path are words too; the small words of a question are left out. Every word, as in
  lfm-pixel: a question in other words than the code's finds nothing here and is left to its meaning, and a name only
  the code has finds its piece. It is a SQLite FTS5 index: a few milliseconds a key on this repository.
- **Meaning, once you pause.** Your words are embedded once (as `task: search result | query: …` for EmbeddingGemma)
  and compared with every piece's vector, brute force: 1.5 ms for this repository's 6,639 pieces, 16 ms for 100,000
  (62 ms at 768 numbers a piece), so there is no approximate index to keep. The closest, within 0.1 of the best (unrelated code scores close
  too, so a fixed cut-off would not do).
- **Fused, where one list is asked for.** `/find`, `vim.ui.select` and the `search` tool score each piece
  `1/(60 + rank)` in each ranking it is in, summed: reciprocal rank fusion, as in lfm-pixel's notes search, rather
  than adding scores on different scales. The live pickers keep what you already see in place instead: meaning's hits
  that the words did not find go below them.

On lfm-pixel's notebook of questions worded unlike the notes, EmbeddingGemma got recall@5 0.98 where keywords got
0.03. On a small project of code (`test/live/meaning.test.mjs`) it put the right file first for each of six such
questions.

## Rerank

Meaning and words get the right piece into the first ten most of the time, but not always first. A decision model
(a classifier that answers a question with a probability for each answer and writes no text, such as LiquidAI's
d1-2B on llama.cpp) can read those ten and say which one you are looking for. Pair asks it once, one question whose
answers are the pieces, each as its `file:line` and the first 160 characters of its text from its doc comment on; the
pieces then go best first by the probability the model gives each, and the rest of the list stays as it was.

It is asked only where a list is settled, never on a key:

- **`/find` and the `search` tool** wait for it, up to `timeoutMs` (3 s), then answer; `/find`'s first line says
  `reranked by d1-2B`. The `search` tool within a path is not reranked: the project's first ten may be none of the path's.
- **The live pickers** (Telescope and snacks.picker) show the words and then meaning as before, without waiting; once
  the list has stayed as it is for `meaning_rerank_delay_ms` (400 ms) after meaning came, the fused ranking's first ten
  (`/find`'s) go first, in the model's order, once; the rest of the list follows as it was. The title says `reranking`
  meanwhile and `reranked by d1-2B (2.4 s)` once it applied. A key before then drops it. The piece you are on stays
  the one you are on, wherever it moves. fzf-lua's list only grows, so it is not reranked there; nor is a picker's
  list while search by meaning has no model (words only), though `/find` reranks the words then.
- **`vim.ui.select`** waits for it too, as `/find`, and its prompt says `(reranked by d1-2B)` when it applied.

A model that is down, slower than `timeoutMs`, or answers oddly (no probability for a piece, or none that stands out)
leaves the order as it was, and after a failure it is not asked for a minute, so a model that is off costs one wait.
It gets one question at a time, `pair doctor`'s check too while the daemon runs: a search while a rerank runs keeps its
order, and a picker's rerank waits for the one under way. A question once sent is never cut off but by the timeout (a
server would go on with it): a key, the picker closing, or a newer rerank from the same Neovim drop a rerank still
waiting, and leave the answer of one under way unused. On a CPU the model's time is the rerank's; a model that serves
other work too is better given an instance of its own if you search often.

```jsonc
"rerank": {"api": "system-one", "baseUrl": "http://127.0.0.1:8080/v1", "model": "d1-2B"}
```

It is a [decision model entry](config.md#rerank): `"api": "system-one"` for a System One server (llama.cpp's decision
models answer `POST /v1/systemone`; TypeSafe and OpenRouter serve it too), `"llama-cpp"` for a chat model on
llama.cpp's server asked for the probability of each answer, `"openai"` for OpenAI's Decisions API, or a `provider`
with one of its classifiers. `top` is how many pieces it reads (10), `timeoutMs` how long a search waits (3000). Its key
goes as a model's. `pair doctor` asks it a search's worth of pieces and says how long it took:

```
✓ rerank  d1-2B at http://127.0.0.1:8080/v1 reranks 10 pieces in 1.6 s (a search waits up to 3.0 s)
```

Without the entry it says `off`, and every search keeps the order of meaning and words.

**Measured** on Pair's own repository with EmbeddingGemma 2 and d1-2B (Q8_0, on a Ryzen 5 9600X's CPU), on 32
questions worded unlike what they should find, 25 about code and 7 about the docs (a Markdown knowledge base):
`test/fixtures/rerank-queries.json`, run by `test/live/rerank.test.mjs`. The order before is `/find`'s, meaning and
words fused.

| | recall@5 | MRR |
| --- | --- | --- |
| All 32, before → after | 0.72 → 0.81 | 0.50 → 0.74 |
| Code (25) | 0.76 → 0.84 | 0.59 → 0.77 |
| Docs (7) | 0.57 → 0.71 | 0.17 → 0.64 |

The rerank took 2.4 s at the median, 2.7 s at the 95th percentile, all 32 within the 3 s budget. Fewer characters a
piece were quicker and ranked a little worse (100: 1.9 s, MRR 0.70); six pieces 1.6 s (MRR 0.70, recall@5 0.75); fifteen
3.3 s for no better MRR. The model can only reorder what the search found: a piece outside the first ten stays where it
was. The questions were written for this measure, by one person: a small set, so take the numbers as a direction.

## The index

- **What goes in.** The files git lists, tracked and untracked, without what `.gitignore` leaves out; without git,
  ripgrep's list, which keeps to `.gitignore` too. Not pictures, sound, archives, fonts, lockfiles, source maps,
  minified files, files over 512 KB, or binaries.
- **Pieces.** Each function, class and method with the comments right above it (its doc comment), found by
  Neovim's tree-sitter where Neovim has a parser for the file's language: Pair runs a headless Neovim without your
  config (`nvim -u NONE -l`), with the parsers Neovim ships and those your Neovim has (it tells Pair at connect). A
  definition longer than 60 lines becomes its head and the definitions inside it (a class's methods); one with none,
  or longer than 1,500 characters (about 400 tokens), is cut at blank lines. The lines between definitions, and whole files with no parser (or no
  Neovim), go in blocks cut at blank lines. Markdown's parser makes each section a piece.
- **Built in the background**, once a project has a session: its words first (this repository's 550 files in about a
  second), then its vectors in batches of four, on two cores (`meaning.threads`) at low priority (`nice 10`). A search
  goes before the batches still waiting, so it waits for one batch at most. Neovim shows how far the build is as a
  progress message (Neovim 0.12: your statusline or fidget may show it; an older Neovim gets a note when it ends).
- **Kept up to date.** A save reads that file again and embeds only the pieces whose text changed; changes made
  outside Neovim (a checkout, a pull) are found when the session loads and every ten minutes. A file's pieces whose
  text changed meanwhile are read again before they are embedded.
- **Shared by worktrees.** A piece is known by the hash of its path and text, and its vector is kept by that hash and
  the model: the worktrees of one repository share one index file, and a worktree on another branch embeds only what that branch changed (switching branches in one worktree embeds again
  what the old branch had and the new one lacks, once the index looks the project over).
- **Up to 20,000 pieces a project**: past that, the files left are not indexed, and the picker says so.
- **What it keeps: positions and vectors, no copy of the code.** A SQLite file per repository (worktrees share it):
  each piece's file, lines, hash, kind and name, an FTS5 index of its words (lower case and stemmed, with where each
  stands, so not secret: no punctuation, but their order could be read back) without the text itself, and a vector per hash
  (256 numbers, 1 KB, for EmbeddingGemma). The lines shown are read from your files.
- **Where.** In Pair's data folder, `index/<repository>-<hash>.sqlite`, by default: nothing goes in the repository.
  With `"meaning": {"index": "project"}` in the [config](config.md#meaning) it is `.pair/index.sqlite` in the
  repository's main worktree instead, and Pair adds `.pair/` to `.git/info/exclude` (your own ignore list, not the
  team's `.gitignore`).
- **The embedder stops** after three minutes with nothing to embed, and gives its memory back (about 320 to 490 MB
  while EmbeddingGemma runs); the next search or save starts it again in under a second.

On this repository (550 files, 4 MB of code and docs, on a Ryzen 5 9600X), with EmbeddingGemma 2:

| | |
| --- | --- |
| Words index | 6,639 pieces from 549 files in 1.1 s; a word search in 1 to 4 ms |
| First vectors | 6,639 pieces in 9 min 11 s, 83 ms a piece on the default two cores (5 min on six) |
| Index on disk | 13.5 MB (6.8 MB of it vectors) |
| Meaning | 28 to 46 ms once the embedder runs (the query's vector, then 1.5 ms to compare); under a second more when it has to start |
| A save | the file's changed pieces, a fraction of a second each |

## Another embedding model

A code embedding model of your own, served by llama.cpp's `llama-server --embeddings`, Ollama, LM Studio, vLLM or a
cloud API, goes in the config as `embedding`, next to the [models](config.md#models):

```jsonc
"embedding": {"api": "openai", "baseUrl": "http://127.0.0.1:8080/v1", "model": "jina-embeddings-v2-base-code"}
```

Search by meaning is then on at once, with no download, and EmbeddingGemma is not used. Its key goes as a model's
(`apiKeyFile`, `apiKeyEnv`, `auth` or `apiKey`). Pair knows the prompts nomic-embed-code, nomic-embed-text,
EmbeddingGemma and Qwen3-Embedding were trained with; for another model that has some, set `queryPrefix` and
`documentPrefix`. `dimensions` asks a model that can for shorter vectors. Vectors are kept per model, so switching
embeds the project again (and the other model's vectors go at the next look). A code model finds code best:
nomic-embed-code (7B, 3,584 numbers a piece: 14 KB, so 90 MB of vectors for this repository) or the much smaller
jina-embeddings-v2-base-code (768 numbers). `pair doctor` embeds one word to check it answers. If it fails, the
picker and `/find` say why and the words still rank.

## The search trail

When you hunt for something in your pickers and it is not there under your words, Pair's [search
trail](neovim.md#the-search-trail) remark already gets what ripgrep finds for each of your searches. With search by
meaning on, it also gets the two pieces closest to what each search means, as `by meaning: worker.go:30-58 …` lines:
where the thing is when the code calls it something else, while the embedder runs (the trail never waits for a model
to load). That changes what Pair knows when it speaks, not when it speaks: the speak gate, the talk budget and the
wait for your break are the same as for every trail.

## In the ledger

`:Pair today` lists each build of ten pieces or more (`indexed 6639 pieces by meaning in 551 s: 549 files, 6639
pieces, 13780 KB`; a save's few pieces get no line of their own), each piece you open from a picker (`searched by
meaning "method that removes user" in the picker: 1 result, first src/teams.js:42`), each `/find` and `search` tool
search (`⏎` shows the ranking with each piece's similarity and whether your words matched), each rerank (`reranked
"method that removes user" in the picker with d1-2B in 2410 ms: 3 of 10 moved, first now src/auth.mjs:46 (was
src/teams.js:12)`, or why it kept the order; `⏎` shows the order before and after, with the model's probability for each), each lookup for the
search trail, `:Pair index rebuild`, LiteRT-LM's install (`⏎` shows the venv's Python), the model's download,
and `:Pair find off` deleting them. The words you type on
the way are not booked.

## Why this model and runtime

- **EmbeddingGemma 2, text, 270M.** Apache-2.0, multilingual and good at code (MTEB code 78.7 at 768 numbers, 76.2
  at the 256 Pair keeps), and small: a 165 MB file. Its numbers can be cut to 256 and normalized again with little
  loss, a third of the storage. It is the model lfm-pixel uses for its notes, measured there first, and the default
  when no `embedding` model is set.
- **LiteRT-LM, natively, in a Python helper.** The same runtime and the same model file lfm-pixel measured, with its
  native CPU kernels. The alternatives that run inside Node were tried on this repository: ONNX Runtime Web (the
  WebAssembly build) took 2.5 s a piece where LiteRT-LM takes 0.13 s, so the first index would take hours;
  `onnxruntime-node` downloads its CUDA libraries from NuGet when it is installed on Linux, a network step on every
  `npm install` of Pair; and LiteRT-LM's own npm package is for the browser and WebGPU. A Python helper installed
  when you turn it on costs Pair nothing for everyone who never does.
- **The download.** The pinned revision `9be6e8b9` of
  [litert-community/embeddinggemma-2-text-270m-litert-lm](https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm),
  file `embeddinggemma-2-text-270m.litertlm`, 164,626,432 bytes, written to a `.part` file while its SHA-256 is taken
  and kept only if it is `2d079ee2…ab286fb`. Its checksum is noted next to it, so a restart does not read it again; a
  file changed since is not trusted. It is never committed or shipped with Pair.

### Turn EmbeddingGemma on

`:Pair find on` asks nothing more: turning it on is the yes. It says once, up front, what it fetches and how big, then
shows how far as it goes, as Neovim messages:

1. **LiteRT-LM** 0.19.0, the runtime, unless the Python Pair would run already has that version. Pair makes a virtual
   environment in its data folder, `~/.local/state/pairing-buddy/meaning/venv`, with the first `python3` (or
   `python3.14` down to `python3.10`) that is 3.10 or later, on PATH or where Homebrew, python.org's installer, pyenv
   and `~/.local/bin` keep them. It downloads the one wheel for your machine from PyPI (17 to 33 MB), kept only if its
   SHA-256 is the one in Pair's lock file (`src/meaning-runtime.txt`), and pip installs it from that file into the
   venv: no index, `--require-hashes`, no other package, nothing built from source. Nothing goes outside that folder.
2. **EmbeddingGemma 2**, 165 MB from Hugging Face, once, checked by its SHA-256.

Then Pair embeds the open projects in the background. It is off by default, because two downloads and a few minutes
of two cores for the first build are not something Pair should do by itself. The ledger books what came.

The model runs on [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM), Google's on-device runtime, in a small
Python helper Pair starts. LiteRT-LM has wheels for Linux (x86-64 and ARM64, glibc 2.27 or later) and macOS on Apple
silicon. If Python 3.10 or later is missing, cannot make a venv (Debian and Ubuntu put that in `python3-venv`), or
the machine has no wheel, `:Pair find on` says so in one line with what to do, leaves nothing behind, and the word
search works as before. Any other Python with `litert-lm-api` works too: set `"meaning": {"python":
"/path/to/python"}` in the [config](config.md#meaning). It wins: Pair installs nothing into it and never deletes it.

If you would rather install it by hand (say, when PyPI is reached only through a proxy pip knows of), make the same
venv yourself, and `:Pair find on` uses it as it is; it is yours, so `:Pair find off` leaves it. The lock file is
`src/meaning-runtime.txt` in Pair's install (its npm package, or your plugin manager's checkout):

```sh
python3 -m venv ~/.local/state/pairing-buddy/meaning/venv
~/.local/state/pairing-buddy/meaning/venv/bin/pip install --require-hashes -r <Pair's folder>/src/meaning-runtime.txt
```

`pair doctor` says what is missing and what turning it on fetches, and how big and how old each index is:

```
✓ meaning  EmbeddingGemma 2 (text, 270M) (revision 9be6e8b, SHA-256 checked) on LiteRT-LM 0.19.0 in ~/.local/state/pairing-buddy/meaning/venv/bin/python (the venv Pair made) answers (900 ms with loading); pairing-buddy: 549 files, 6639 pieces, 13.5 MB, updated 4 min ago, 83 ms a piece
```

## Turn it off

`:Pair find off` stops the embedder and deletes EmbeddingGemma, every index (in Pair's data folder, and the open
projects' `.pair/index.sqlite`) and the venv with LiteRT-LM if Pair made it (never a venv you made, nor
`meaning.python`); a download or install under way stops and leaves nothing. The word index is made again, in
seconds, at the next search. With an `embedding` model, it is not asked again until `:Pair find on`. `"meaning":
false` in the [config](config.md#meaning) turns it all off for good: `Alt-s` then says so, and nothing is downloaded or indexed.
