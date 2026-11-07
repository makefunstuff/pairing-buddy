---
description: "Find code as quickly as ripgrep with loose words: semantic-grep's live picker, words on every key and meaning from Pair's local index as you pause."
---

# Search by meaning

You know what the code does, not what it calls it. Press `Alt-s` and type "method that removes user": on every key the
picker shows the pieces of code that have your words (identifiers split, comments and strings too), and once you stop
typing the pieces closest to what you mean join the list below them: in Pair's own code, `src/auth.mjs:46 export
async function logout({id, credentials})` first, though it says neither "remove" nor "user". Or write a whole
sentence, `:Pair files where search results are reranked`, and get the files it is about, best first, each at its best
line.

The search itself is [semantic-grep](https://github.com/makefunstuff/semantic-grep.nvim): its Neovim plugin is the
picker, and its library is the index, the word and meaning search and the rerank in Pair's daemon. How it ranks, what
the index holds and how it is kept up to date, the pickers and their keys, and the rerank's behaviour are in
[its README](https://github.com/makefunstuff/semantic-grep.nvim#readme); which models suit which machine, and what each one scores, in its
[docs/profiles.md](https://github.com/makefunstuff/semantic-grep.nvim/blob/main/docs/profiles.md) and
[docs/benchmark.md](https://github.com/makefunstuff/semantic-grep.nvim/blob/main/docs/benchmark.md). This page has what Pair adds: its daemon as
the one index of a project while Pair runs, EmbeddingGemma 2 turned on and off for you, semantic-grep's profiles and
notes writer in Pair's config, Scout's and the Driver's `search`, the search trail and the ledger. Install semantic-grep.nvim next to Pair ([install.md](install.md)); without
it `Alt-s` says so, and everything else of Pair works.

The word search works on its own, with no model at all. Meaning needs an embedding model: EmbeddingGemma 2, which Pair
downloads once when you say so and runs on your machine, one of semantic-grep's [profiles](#model-profiles), or a model
of your own behind an OpenAI-compatible `/v1/embeddings` ([below](#another-embedding-model)). Nothing leaves the
machine but EmbeddingGemma's one download and its runtime's, unless you point Pair at a server elsewhere (the `cloud`
and `openrouter` profiles do).

## Search

| | |
| --- | --- |
| `Alt-s` | Opens semantic-grep's live picker; in Visual mode, with the selected words typed in it |
| `:Pair find [words]` | The same, with the words typed in it |
| `:Pair files [sentence]` | semantic-grep's files view: the files the sentence is about, best first, each at its best line; `Enter` opens one there. `meaning_files_key` in Pair's [setup](neovim-plugin.md#setup) maps it to a key (none by default) |
| `:Pair find on` / `:Pair find off` | Install LiteRT-LM, download EmbeddingGemma 2 and embed the open projects / delete the model, every index and the venv Pair made |
| `:Pair index rebuild` | Make the project's index again from its files, every vector too |
| `/find <words>` | In the [chat](chat.md): the ten best pieces, meaning and words fused, as `file:line` lines |

While Pair's Neovim plugin is connected it registers the daemon as semantic-grep's source
(`require('semantic-grep').register_source`), so `:SemanticGrep`, `:SemanticGrep files` and `:checkhealth
semantic-grep` ask the daemon too,
the project of your session is indexed once (by the daemon, in Pair's data folder), and semantic-grep's own server is
not started. Once Pair disconnects, semantic-grep goes back to its own server, with its own index (in Neovim's data
folder) and the models of its own `setup()`. `meaning_picker`, `meaning_debounce_ms` and `meaning_rerank_delay_ms` in
Pair's [setup](neovim-plugin.md#setup), when set, go to semantic-grep's `picker`, `debounce_ms` and `rerank_delay_ms`;
the models are Pair's config's, not semantic-grep's `setup()`. When the picker's title says `words only`,
`:Pair find on` adds meaning.

Scout's and the Driver's `search` tool can ask the index too: with `meaning: true` it searches by meaning and words
instead of ripgrep, for "where do we …" in your words, and when ripgrep finds nothing for two or more plain words, the
index's best pieces come with its "No matches." ([scout.md](scout.md)).

## Rerank

A decision model can move its pick of the first pieces of a settled search (the fused list of `/find`, the `search` tool
and `vim.ui.select`, and the picker's list once meaning came) to the top when it stands out (semantic-grep's README
says how). In Pair it is the config's `rerank` entry, a [decision model entry](config.md#rerank) as `decision`'s: an
`api` at a `baseUrl` (`"system-one"`, `"llama-cpp"` or `"openai"`), or a `provider` with one of its classifiers, its key
as a model's; or a cross-encoder (`"api": "rerank"`, a `/rerank` such as llama.cpp's `--rerank`), which reorders every
piece it reads; or a list of them, best first. `top` is how many pieces it reads (10), `timeoutMs` how long a search
waits (3000; 1000 for one another follows), `chars` how much of each piece it reads (1200 for a cross-encoder, 160
otherwise).

```jsonc
"rerank": [
  {"api": "system-one", "baseUrl": "http://127.0.0.1:8081/v1", "model": "gpu-model", "top": 15, "timeoutMs": 1000},
  {"api": "system-one", "baseUrl": "http://127.0.0.1:8080/v1", "model": "d1-2B"}
]
```

`pair doctor` asks it a search's worth of pieces, in turn as a search does, and names the one that answered, why the
ones before it did not, and what follows; without the entry it says `off`:

```
✓ rerank  d1-2B at http://127.0.0.1:8080/v1 reranks 10 pieces in 2.4 s (a search waits up to 3.0 s); first gpu-model at http://127.0.0.1:8081/v1 failed (fetch failed)
```

On Pair's own repository (`test/fixtures/rerank-queries.json`, run by `test/live/rerank.test.mjs`), d1-2B on a CPU
took recall@5 from 0.72 to 0.81 and MRR from 0.47 to 0.71 in 2.4 s at the median; d3-flash on a GPU did as well in
0.19 s, and with fifteen pieces reached 0.84 and 0.75. The cross-encoders semantic-grep measured, and which a profile
picks, are in its [docs/profiles.md](https://github.com/makefunstuff/semantic-grep.nvim/blob/main/docs/profiles.md#rerankers).

## Model profiles

semantic-grep names the models its [benchmark](https://github.com/makefunstuff/semantic-grep.nvim/blob/main/docs/benchmark.md) measured best for a kind
of machine: `laptop` (the CPU only), `beefy` (a GPU), `cloud` (hosted APIs) and `openrouter` (hosted, no GPU and no
server). One field in Pair's [config](config.md#meaning) takes one:

```jsonc
"meaning": {"profile": "beefy"}
```

It sets the `embedding` and `rerank` models to the profile's; EmbeddingGemma on LiteRT-LM is then not used. What the
config sets itself goes over the profile's, as semantic-grep's `setup()` takes it: `"embedding": {"baseUrl":
"http://127.0.0.1:9000/v1"}` moves the profile's model, another `model` is an entry of its own, `"rerank": false`
turns the profile's reranker off, and a decision model or a list in `rerank` is yours. Which models each profile
names, what they score and cost, and how to start their `llama-server`s are in semantic-grep's
[docs/profiles.md](https://github.com/makefunstuff/semantic-grep.nvim/blob/main/docs/profiles.md); the local ones expect them on this machine, the hosted
ones a key in the variable the profile names (`pair setup` stores it for the service). `:checkhealth semantic-grep`
names the profile and asks each model once. Vectors are kept per model, so switching embeds the project again.

## Notes on the pieces

A sentence on what a piece of code does, in the words you would search with, is searched with its code and read by
the reranker: searches in plain words find more (semantic-grep's [docs/notes.md](https://github.com/makefunstuff/semantic-grep.nvim/blob/main/docs/notes.md)
has what they gain, per model). Two ways to have them:

- **Written while nothing is searched.** `"meaning": {"notes": true}` in the [config](config.md#meaning) turns on the
  profile's notes writer (the laptop's without a profile), or an entry over it, such as `{"model": "qwen3.5-9b"}`. It
  writes a few pieces at a time once nothing was searched for a while and stops at the next search. A writer that is
  not on this machine gets no code unless its entry says `"sendCode": true` (the `cloud` and `openrouter` profiles'
  do). Off by default.
- **From a coding agent.** semantic-grep's `semantic-grep-server notes pending` and `notes put` (or its Claude Code
  skill, which runs them for you) on Pair's index: give them `--data-dir ~/.local/state/pairing-buddy` (Pair's
  `dataDir`), and with `"index": "project"` also `--index project --project-dir .pair`. Its README's
  ["It learns"](https://github.com/makefunstuff/semantic-grep.nvim#it-learns) says how.

A note holds while its piece's code does not change. The ledger books each batch the writer wrote.

## The index

The index is semantic-grep's (SQLite: the words in FTS5 and a vector per piece, no copy of the code; worktrees of a
repository share it; a save embeds only what changed), built by Pair's daemon in the background once a project has a
session. Its words come first, then its vectors, on two cores (`meaning.threads`) at low priority for EmbeddingGemma;
Neovim shows how far as a progress message. It lives in Pair's data folder, `index/<repository>-<hash>.sqlite`, by
default; with `"meaning": {"index": "project"}` in the [config](config.md#meaning) it is `.pair/index.sqlite` in the
repository's main worktree instead, with `.pair/` in `.git/info/exclude`. EmbeddingGemma's helper stops after three
minutes with nothing to embed and gives its memory back (about 320 to 490 MB while it runs).

On this repository (550 files, on a Ryzen 5 9600X) with EmbeddingGemma 2: words for 6,639 pieces in 1.1 s, a word
search in 1 to 4 ms; the first vectors in 9 minutes on two cores (83 ms a piece); 13.5 MB on disk; meaning in 28 to
46 ms once the embedder runs.

## Another embedding model

A code embedding model of your own, served by llama.cpp's `llama-server --embeddings`, Ollama, LM Studio, vLLM or a
cloud API, goes in the config as `embedding`, next to the [models](config.md#model-entries):

```jsonc
"embedding": {"api": "openai", "baseUrl": "http://127.0.0.1:8080/v1", "model": "jina-embeddings-v2-base-code"}
```

Search by meaning is then on at once, with no download, and EmbeddingGemma is not used. Its key goes as a model's
(`apiKeyFile`, `apiKeyEnv`, `auth` or `apiKey`), or the output of an `apiKeyCommand`. The prompts known models were
trained with, `queryPrefix`, `documentPrefix`, `queryBody`, `documentBody`, `band`, `pickNear` and `dimensions` are
semantic-grep's `embedding` entry's (its README's "Configuration"). For a model it measured, a
[profile](#model-profiles) sets them all. Vectors are kept per model, so switching
embeds the project again. `pair doctor` embeds one word to check it answers; if it fails, the picker and `/find` say
why and the words still rank.

## The search trail

When you hunt for something in your pickers and it is not there under your words, Pair's [search
trail](neovim.md#the-search-trail) remark already gets what ripgrep finds for each of your searches. With search by
meaning on, it also gets the two pieces closest to what each search means, as `by meaning: worker.go:30-58 …` lines:
where the thing is when the code calls it something else, while the embedder runs (the trail never waits for a model
to load). That changes what Pair knows when it speaks, not when it speaks: the speak gate, the talk budget and the
wait for your break are the same as for every trail.

## In the ledger

`:Pair today` lists each build of ten pieces or more (`indexed 6639 pieces by meaning in 551 s: 549 files, 6639 pieces,
13780 KB`; a save's few pieces get no line of their own), each piece you open from the picker (`searched by meaning
"method that removes user" in the picker: 1 result, first src/teams.js:42`), each `/find` and `search` tool search (`⏎`
shows the ranking), each rerank (`⏎` shows the order before and after, with the model's probability or the
cross-encoder's score for each, when its answer was used, even if nothing moved; when it was not (too slow, flat, failed,
busy with another rerank or resting after a failure), the search's order it kept), each lookup for the search trail,
`:Pair index rebuild` and `:SemanticGrep rebuild`, the notes the writer wrote, LiteRT-LM's install, the model's
download, and `:Pair find off` deleting them. The words you type on the way are not booked.

## Why this model and runtime

- **EmbeddingGemma 2, text, 270M.** Apache-2.0, multilingual and good at code (MTEB code 78.7 at 768 numbers, 76.2
  at the 256 Pair keeps), and small: a 165 MB file. It is the model lfm-pixel uses for its notes, measured there
  first, and the default when no `embedding` model is set.
- **LiteRT-LM, natively, in a Python helper.** The same runtime and model file lfm-pixel measured, with its native CPU
  kernels. ONNX Runtime Web took 2.5 s a piece where LiteRT-LM takes 0.13 s; `onnxruntime-node` downloads CUDA
  libraries on every `npm install`; LiteRT-LM's npm package is for the browser. A helper installed when you turn it on
  costs nothing for everyone who never does.
- **The download.** The pinned revision `9be6e8b9` of
  [litert-community/embeddinggemma-2-text-270m-litert-lm](https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm),
  file `embeddinggemma-2-text-270m.litertlm`, 164,626,432 bytes, written to a `.part` file while its SHA-256 is taken
  and kept only if it is `2d079ee2…ab286fb`. It is never committed or shipped with Pair.

### Turn EmbeddingGemma on

`:Pair find on` asks nothing more: turning it on is the yes. It says once, up front, what it fetches and how big, then
shows how far as it goes:

1. **LiteRT-LM** 0.19.0, unless the Python Pair would run already has that version: a venv in Pair's data folder,
   `~/.local/state/pairing-buddy/meaning/venv`, made with the first Python 3.10 or later, and the one wheel for your
   machine from PyPI (17 to 33 MB), kept only if its SHA-256 is the one in `src/meaning-runtime.txt`, installed by pip
   from that file: no index, `--require-hashes`, nothing built from source. Voice's LFM3-Omni shares this venv.
2. **EmbeddingGemma 2**, 165 MB from Hugging Face, once, checked by its SHA-256.

Then Pair embeds the open projects in the background. LiteRT-LM has wheels for Linux (x86-64 and ARM64, glibc 2.27 or
later) and macOS on Apple silicon; when Python or a wheel is missing, `:Pair find on` says so in one line, leaves
nothing behind, and the word search works as before. Any other Python with `litert-lm-api` works too: set
`"meaning": {"python": "/path/to/python"}` in the [config](config.md#meaning); Pair installs nothing into it and never
deletes it. To install by hand, make the same venv and `:Pair find on` uses it as it is:

```sh
python3 -m venv ~/.local/state/pairing-buddy/meaning/venv
~/.local/state/pairing-buddy/meaning/venv/bin/pip install --require-hashes --no-deps --only-binary=:all: -r <Pair's folder>/src/meaning-runtime.txt
```

`pair doctor` says what is missing and what turning it on fetches, and how big and how old each index is:

```
✓ meaning  EmbeddingGemma 2 (text, 270M) (revision 9be6e8b, SHA-256 checked) on LiteRT-LM 0.19.0 in ~/.local/state/pairing-buddy/meaning/venv/bin/python (the venv Pair made) answers (900 ms with loading); pairing-buddy: 549 files, 6639 pieces, 13.5 MB, updated 4 min ago, 83 ms a piece
```

## Turn it off

`:Pair find off` stops the embedder and deletes EmbeddingGemma, every index (in Pair's data folder, and the open
projects' `.pair/index.sqlite`) and the venv with LiteRT-LM if Pair made it (never a venv you made, nor
`meaning.python`, nor while voice's LFM3-Omni needs it); a download or install under way stops and leaves nothing. The
word index is made again, in seconds, at the next search. With an `embedding` model, it is not asked again until
`:Pair find on` (a note, `off`, in Pair's data folder keeps it so). `"meaning": false` in the
[config](config.md#meaning) turns it all off for good: nothing is downloaded or indexed.
