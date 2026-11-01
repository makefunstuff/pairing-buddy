"""Search by meaning's embedder: EmbeddingGemma 2 on LiteRT-LM, for Pair's daemon (see src/embedder.mjs).

    python3 -I embed-helper.py MODEL.litertlm THREADS MAX_TOKENS

One JSON line in per batch, {"id": 1, "texts": ["title: ... | text: ...", ...]}; one JSON line out per batch,
{"id": 1, "vectors": ["<base64 of 256 little-endian float32>", ...]} or {"id": 1, "error": "..."}. The first line out
says the model is loaded ({"ready": true, ...}) or why not ({"fatal": "..."}). Reads nothing else, writes nothing
else, never touches the network. Needs `pip install litert-lm-api==0.19.0` in the Python that runs it.
"""
import array
import base64
import json
import os
import sys
import time

DIMENSIONS = 256  # Matryoshka: the first 256 of 768 numbers, normalized again by the engine


def say(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    model, threads, max_tokens = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    try:
        os.nice(10)  # background work: the editor and the models come first
    except OSError:
        pass
    try:
        import litert_lm
        from importlib.metadata import version
        from litert_lm.embedding_engine import EmbeddingOptions, InputOverflowStrategy

        litert_lm.set_min_log_severity(litert_lm.LogSeverity.ERROR)
        started = time.perf_counter()
        engine = litert_lm.EmbeddingEngine(model, backend=litert_lm.Backend.CPU(thread_count=threads), max_input_length=max_tokens)
        engine.__enter__()
        options = EmbeddingOptions(normalize=True, output_size=DIMENSIONS, input_overflow_strategy=InputOverflowStrategy.TRUNCATE)
    except Exception as error:  # a missing package, a broken model file: the daemon says which
        say({"fatal": f"{type(error).__name__}: {error}"})
        return 1
    say({"ready": True, "runtime": version("litert-lm-api"), "loadMs": round(1000 * (time.perf_counter() - started))})
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            vectors = []
            for text in request["texts"]:
                embedding = array.array("f", engine.compute_embedding([text], options).embedding)
                if sys.byteorder != "little":
                    embedding.byteswap()
                vectors.append(base64.b64encode(embedding.tobytes()).decode("ascii"))
            say({"id": request["id"], "vectors": vectors})
        except Exception as error:
            say({"id": request["id"], "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
