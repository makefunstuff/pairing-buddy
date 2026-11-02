"""Voice's model: LFM3-Omni-2B on LiteRT, for Pair's daemon (see src/omni.mjs). It hears and it speaks, offline, on the CPU.

    python3 -I omni-helper.py MODEL_DIR THREADS CACHE_DIR

MODEL_DIR holds the pinned files of litert-community/LFM3-Omni-2B-LiteRT (src/omni.mjs downloads and checks them).
Hearing is the .litertlm on LiteRT-LM (`litert-lm-api`), as the model card's examples/run_omni.py does it. Speech is
the same file's decoder with the graphs in speech/ on LiteRT (`ai-edge-litert`), driven by the model repository's own
runner/*.py (loaded by path from MODEL_DIR; their SHA-256 is pinned like the weights). CACHE_DIR keeps XNNPACK's
packed weights, so a second start maps them instead of unpacking 17 GB into memory.

One JSON line in per request, one or more out:
    {"id": 1, "op": "hear", "pcm": "<base64 16 kHz mono s16le>", "language": "English"}
        -> {"id": 1, "text": "...", "ms": 1200}
    {"id": 2, "op": "speak", "texts": ["First sentence.", "Second."], "voice": "female"}
        -> {"id": 2, "part": 0, "wav": "<base64 WAV, 24 kHz>", "seconds": 2.1, "ms": 2600} for each text, as it is
           ready, then {"id": 2, "done": true}
    {"id": 2, "op": "cancel"} -> the speech of request 2 stops at its next frame: {"id": 2, "done": true, "cancelled": true}
Any request can answer {"id": ..., "error": "..."}. The first line out is {"ready": true, ...} or {"fatal": "..."}.
Reads nothing else, writes only CACHE_DIR, never touches the network.
"""
import base64
import importlib.util
import io
import json
import os
import pathlib
import queue
import sys
import threading
import time
import wave

GRAPHS = ("depth_step", "frame_embed", "codec_decoder_f12")
ASR_SYSTEM = "Perform ASR in {language}."
TTS_SYSTEM = "Perform TTS in American English using a {voice} voice."
MAX_FRAMES = 1024  # 80 ms a frame: a sentence of at most ~80 s


class Cancelled(Exception):
    pass


def say(message, lock=threading.Lock()):
    with lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def wav_bytes(pcm, rate):
    out = io.BytesIO()
    with wave.open(out, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(pcm)
    return out.getvalue()


class Omni:
    def __init__(self, root, threads, cache):
        self.root, self.threads, self.cache = pathlib.Path(root), threads, cache
        self.speaker = None
        import litert_lm
        litert_lm.set_min_log_severity(litert_lm.LogSeverity.ERROR)
        self.litert_lm = litert_lm
        self.model = str(self.root / "LFM3-Omni-2B_int8.litertlm")

    def hear(self, pcm, language):
        """A fresh engine per recording (LiteRT-LM issue #3165: LFM3's state leaks between conversations)."""
        lm = self.litert_lm
        cpu = lm.Backend.CPU(thread_count=self.threads)
        with lm.Engine(self.model, backend=cpu, audio_backend=lm.Backend.CPU(thread_count=self.threads),
                       max_num_tokens=1024, cache_dir=self.cache) as engine:
            sampler = lm.SamplerConfig(top_k=1, top_p=1.0, temperature=0.0)
            conv = engine.create_conversation(sampler_config=sampler, max_output_tokens=400,
                                              messages=[{"role": "system", "content": ASR_SYSTEM.format(language=language)}])
            try:
                reply = conv.send_message(lm.Message.user(lm.Contents.of(lm.Content.AudioBytes(wav_bytes(pcm, 16000)))))
            finally:
                conv.close()
        return str(reply.contents).strip()

    def load_speaker(self):
        if self.speaker:
            return self.speaker
        import numpy as np
        from ai_edge_litert.compiled_model import CompiledModel
        from ai_edge_litert.hardware_accelerator import HardwareAccelerator
        from ai_edge_litert.options import CpuOptions, Options

        def runner(name):
            spec = importlib.util.spec_from_file_location(f"pair_omni_{name}", self.root / "runner" / f"{name}.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module

        speech, lm_graph, prompt = runner("speech"), runner("lm_graph"), runner("prompt")
        names = iter(("decoder", "embedder", *GRAPHS))

        def compile_model(source, accel="cpu", threads=self.threads, enforce_f32=False):
            # As runner/lm_graph.py's, with XNNPACK's weight cache in CACHE_DIR: one file per graph, in load order.
            cache = os.path.join(self.cache, f"speech-{next(names)}.xnnpack_cache")
            options = Options(hardware_accelerators=HardwareAccelerator.CPU,
                              cpu_options=CpuOptions(num_threads=threads, xnnpack_weight_cache_path=cache))
            if isinstance(source, (bytes, bytearray, memoryview)):
                return CompiledModel.from_buffer(bytes(source), options=options)
            return CompiledModel.from_file(str(source), options=options)

        lm_graph.compile_model = compile_model
        contract = speech.load_contract(self.root / "runner" / "contract.json")
        lm = lm_graph.lm_from_paths(self.model, accel="cpu", threads=self.threads,
                                    build_json=self.root / "runner" / "bundle_sections.json")
        graphs = [lm_graph.Graph(self.root / contract["graphs"][key]["file"], contract["graphs"][key]["signature"], "cpu",
                                 self.threads) for key in GRAPHS]
        self.speaker = {
            "np": np, "speech": speech, "contract": contract, "lm": lm,
            "generator": speech.SpeechGenerator(lm, graphs[0], graphs[1], contract),
            "codec": graphs[2], "window": np.load(self.root / contract["codec"]["window_file"]),
            "prompt": prompt.PromptBuilder(self.root / "tokenizer.json"),
        }
        return self.speaker

    def speak(self, text, voice, cancelled, seed=0):
        """`text` as 16-bit PCM at the codec's rate; `cancelled()` is asked at every frame."""
        s = self.load_speaker()
        np, contract, tokens = s["np"], s["contract"], s["contract"]["tokens"]
        ids = s["prompt"].ids(TTS_SYSTEM.format(voice=voice), [("text", text)]) + [tokens["audio_start"]]

        def frame(*_args, **_kwargs):
            if cancelled():
                raise Cancelled()

        s["lm"].reset()
        out = s["generator"].generate(prompt_ids=ids, max_new_tokens=min(MAX_FRAMES, s["lm"].cache_length - len(ids)),
                                      rng=np.random.default_rng(seed), mode="audio", on_frame=frame,
                                      profile=contract["sampling_default_profile"])
        if not len(out["frames"]):
            return b""
        decoder = s["speech"].CodecDecoder(s["codec"], 12, s["window"], contract)
        samples = np.concatenate([decoder.push(out["frames"]), decoder.finish()])
        return np.rint(np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def main():
    root, threads, cache = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    try:
        from importlib.metadata import version
        for package in ("ai-edge-litert", "numpy", "tokenizers"):
            version(package)
        os.makedirs(cache, mode=0o700, exist_ok=True)  # LiteRT-LM writes its caches only into a folder that is there
        omni = Omni(root, threads, cache)
        runtime = {"runtime": version("litert-lm-api"), "litert": version("ai-edge-litert")}
    except Exception as error:  # a missing package: the daemon says which, with the line to install it
        say({"fatal": f"{type(error).__name__}: {error}"})
        return 1
    say({"ready": True, **runtime})

    # Requests are read on their own thread, so a cancel reaches speech that is being made.
    requests, cancelled = queue.Queue(), set()

    def read():
        for line in sys.stdin:
            if not line.strip():
                continue
            request = json.loads(line)
            if request.get("op") == "cancel":
                cancelled.add(request["id"])
            else:
                requests.put(request)
        requests.put(None)

    threading.Thread(target=read, daemon=True).start()
    while (request := requests.get()) is not None:
        rid = request["id"]
        try:
            if request["op"] == "hear":
                started = time.perf_counter()
                text = omni.hear(base64.b64decode(request["pcm"]), request.get("language") or "English")
                say({"id": rid, "text": text, "ms": round(1000 * (time.perf_counter() - started))})
            elif request["op"] == "speak":
                rate = None
                for part, text in enumerate(request["texts"]):
                    if rid in cancelled:
                        break
                    started = time.perf_counter()
                    pcm = omni.speak(text, request.get("voice") or "female", lambda: rid in cancelled)
                    rate = rate or omni.speaker["contract"]["codec"]["sample_rate"]
                    if pcm:
                        say({"id": rid, "part": part, "wav": base64.b64encode(wav_bytes(pcm, rate)).decode("ascii"),
                             "seconds": round(len(pcm) / 2 / rate, 2), "ms": round(1000 * (time.perf_counter() - started))})
                say({"id": rid, "done": True, **({"cancelled": True} if rid in cancelled else {})})
            else:
                say({"id": rid, "error": f"unknown op {request['op']}"})
        except Cancelled:
            say({"id": rid, "done": True, "cancelled": True})
        except Exception as error:
            say({"id": rid, "error": f"{type(error).__name__}: {error}"})
        cancelled.discard(rid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
