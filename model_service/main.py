from __future__ import annotations

import argparse
import audioop
import json
import re
import subprocess
import sys
import threading
import time
import wave
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from adapters import CosyVoiceAdapter, PlaceholderTtsAdapter, TtsAdapter


STATE_STOPPED = "stopped"
STATE_LOADING = "loading_model"
STATE_READY = "ready"
STATE_UNLOADING = "unloading"
STATE_ERROR = "error"
STATE_GENERATING = "generating"


class RuntimeState:
    def __init__(self) -> None:
        self.state = STATE_STOPPED
        self.error: str | None = None
        self.gpu: dict[str, Any] | None = None
        self.model_loaded = False
        self.lock = threading.Lock()

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "state": self.state,
                "serviceUrl": "",
                "gpu": self.gpu,
                "error": self.error,
            }

    def set_state(self, state: str, error: str | None = None) -> None:
        with self.lock:
            self.state = state
            self.error = error

    def set_gpu(self, gpu: dict[str, Any] | None) -> None:
        with self.lock:
            self.gpu = gpu


runtime = RuntimeState()
server_ref: ThreadingHTTPServer | None = None
PROJECT_ROOT = Path(__file__).resolve().parents[1]
GENERATED_DIR = PROJECT_ROOT / "auto_speech_data" / "projects" / "default" / "generated"
TARGET_MODEL_CHUNK_CHARS = 60
MAX_MODEL_CHUNK_CHARS = 120
SENTENCE_ENDINGS = "。！？!?."
SOFT_BREAKS = "，,；;、\n"


def load_model_config() -> dict[str, Any]:
    config_path = PROJECT_ROOT / "model_service" / "model_config.json"
    if not config_path.exists():
        return {"activeAdapter": "placeholder"}
    return json.loads(config_path.read_text(encoding="utf-8-sig"))


def create_adapter() -> TtsAdapter:
    config = load_model_config()
    active_adapter = config.get("activeAdapter", "placeholder")
    if active_adapter == "cosyvoice":
        return CosyVoiceAdapter(PROJECT_ROOT, config.get("cosyVoice", {}))
    return PlaceholderTtsAdapter()


tts_adapter: TtsAdapter = create_adapter()


def detect_gpu() -> dict[str, Any] | None:
    command = [
        "nvidia-smi",
        "--query-gpu=name,memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits",
    ]

    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=5)
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None

    first_line = result.stdout.strip().splitlines()[0]
    name, total_mb, used_mb, free_mb = [part.strip() for part in first_line.split(",")]
    return {
        "name": name,
        "totalMb": int(total_mb),
        "usedMb": int(used_mb),
        "freeMb": int(free_mb),
    }


def load_model() -> None:
    runtime.set_state(STATE_LOADING)
    tts_adapter.load()
    runtime.model_loaded = True
    runtime.set_gpu(detect_gpu())
    runtime.set_state(STATE_READY)


def unload_model() -> None:
    runtime.set_state(STATE_UNLOADING)
    tts_adapter.unload()
    runtime.model_loaded = False
    runtime.set_gpu(detect_gpu())
    runtime.set_state(STATE_STOPPED)


def split_sentences(text: str) -> list[str]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    matches = re.findall(r"[^。！？!?\.\n]+[。！？!?\.]?", normalized)
    sentences = [part.strip() for part in matches if part.strip()]
    return sentences or [text.strip()]


def find_last_break_index(text: str, break_chars: str) -> int:
    indexes = [text.rfind(char) for char in break_chars]
    index = max(indexes) if indexes else -1
    return index + 1 if index >= 0 else -1


def choose_chunk_end(text: str, target_chars: int = TARGET_MODEL_CHUNK_CHARS, max_chars: int = MAX_MODEL_CHUNK_CHARS) -> int:
    if len(text) <= target_chars:
        return len(text)

    target_window = text[: min(target_chars, len(text))]
    target_sentence_end = find_last_break_index(target_window, SENTENCE_ENDINGS)
    if target_sentence_end > 0:
        return target_sentence_end

    hard_window = text[: min(max_chars, len(text))]
    hard_sentence_end = find_last_break_index(hard_window, SENTENCE_ENDINGS)
    if hard_sentence_end > 0:
        return hard_sentence_end

    target_soft_break = find_last_break_index(target_window, SOFT_BREAKS)
    if target_soft_break > 0:
        return target_soft_break

    hard_soft_break = find_last_break_index(hard_window, SOFT_BREAKS)
    if hard_soft_break > 0:
        return hard_soft_break

    return min(target_chars, len(text))


def chunk_text_for_generation(
    text: str,
    target_chars: int = TARGET_MODEL_CHUNK_CHARS,
    max_chars: int = MAX_MODEL_CHUNK_CHARS,
) -> list[str]:
    remaining = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    chunks: list[str] = []

    while remaining:
        end = choose_chunk_end(remaining, target_chars=target_chars, max_chars=max_chars)
        chunk = remaining[:end].strip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[end:].strip()

    return chunks or [text.strip()]


def read_wav_frames(path: Path) -> tuple[bytes, int, int, int]:
    with wave.open(str(path), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())
    return frames, channels, sample_width, sample_rate


def merge_wavs(paths: list[Path], output_path: Path, pause_ms: int = 500) -> int:
    if not paths:
        raise ValueError("No audio files to merge.")

    first_frames, channels, sample_width, sample_rate = read_wav_frames(paths[0])
    silence_frame_count = int(sample_rate * pause_ms / 1000)
    silence = b"\x00" * silence_frame_count * channels * sample_width
    total_frames = len(first_frames) // (channels * sample_width)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output_path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(sample_width)
        output.setframerate(sample_rate)
        output.writeframes(first_frames)

        for path in paths[1:]:
            frames, path_channels, path_sample_width, path_sample_rate = read_wav_frames(path)
            if (path_channels, path_sample_width, path_sample_rate) != (channels, sample_width, sample_rate):
                raise ValueError("Generated audio format mismatch.")
            output.writeframes(silence)
            output.writeframes(frames)
            total_frames += silence_frame_count + len(frames) // (channels * sample_width)

    return int(total_frames / sample_rate * 1000)


def ensure_model_loaded() -> None:
    if not runtime.model_loaded:
        load_model()


def generated_url(port: int, filename: str) -> str:
    return f"http://127.0.0.1:{port}/generated/{filename}"


def clip_payload(index: int, text: str, path: Path, duration_ms: int, port: int) -> dict[str, Any]:
    return {
        "index": index,
        "text": text,
        "path": str(path),
        "url": generated_url(port, path.name),
        "durationMs": duration_ms,
    }


def normalize_wav_peak(path: Path, target_peak: float = 0.92) -> None:
    with wave.open(str(path), "rb") as source:
        params = source.getparams()
        frames = source.readframes(source.getnframes())

    if not frames or params.sampwidth not in (1, 2, 3, 4):
        return

    peak = audioop.max(frames, params.sampwidth)
    if peak <= 0:
        return

    max_value = float((1 << (8 * params.sampwidth - 1)) - 1)
    gain = min(max(target_peak * max_value / peak, 0.05), 8.0)
    normalized_frames = audioop.mul(frames, params.sampwidth, gain)

    with wave.open(str(path), "wb") as target:
        target.setparams(params)
        target.writeframes(normalized_frames)


def generate_audio(text: str, port: int, pause_ms: int = 500, split: bool = False, max_single_chars: int = 300) -> dict[str, Any]:
    ensure_model_loaded()
    runtime.set_state(STATE_GENERATING)
    timestamp = int(time.time())
    items: list[dict[str, Any]] = []
    output_paths: list[Path] = []

    if not split:
        if len(text) > max_single_chars:
            raise ValueError(f"整段生成最多 {max_single_chars} 个字，请缩短文案或切换到分句模式。")
        chunks = chunk_text_for_generation(text)
        for index, chunk in enumerate(chunks, start=1):
            filename = f"single-chunk-{timestamp}-{index:02d}.wav"
            output_path = GENERATED_DIR / filename
            clip = tts_adapter.generate_text(chunk, output_path)
            normalize_wav_peak(output_path)
            output_paths.append(output_path)

        full_filename = f"full-{timestamp}.wav"
        full_path = GENERATED_DIR / full_filename
        full_duration_ms = merge_wavs(output_paths, full_path, pause_ms=pause_ms)
        for path in output_paths:
            path.unlink(missing_ok=True)
        normalize_wav_peak(full_path)
        item = clip_payload(0, text, full_path, full_duration_ms, port)
        runtime.set_gpu(detect_gpu())
        runtime.set_state(STATE_READY)
        return {"items": [], "merged": item}

    sentences = split_sentences(text)
    for index, sentence in enumerate(sentences, start=1):
        filename = f"sentence-{timestamp}-{index:02d}.wav"
        output_path = GENERATED_DIR / filename
        clip = tts_adapter.generate_sentence(sentence, output_path)
        normalize_wav_peak(output_path)
        output_paths.append(output_path)
        items.append(clip_payload(index, sentence, output_path, clip.duration_ms, port))

    full_filename = f"full-{timestamp}.wav"
    full_path = GENERATED_DIR / full_filename
    full_duration_ms = merge_wavs(output_paths, full_path, pause_ms=pause_ms)
    normalize_wav_peak(full_path)

    runtime.set_gpu(detect_gpu())
    runtime.set_state(STATE_READY)
    return {
        "items": items,
        "merged": clip_payload(0, text, full_path, full_duration_ms, port),
    }


def generate_sentence_audio(text: str, index: int, port: int) -> dict[str, Any]:
    ensure_model_loaded()
    runtime.set_state(STATE_GENERATING)
    safe_index = max(1, index)
    timestamp = int(time.time())
    filename = f"sentence-{timestamp}-{safe_index:02d}.wav"
    output_path = GENERATED_DIR / filename
    clip = tts_adapter.generate_sentence(text, output_path)
    normalize_wav_peak(output_path)
    runtime.set_gpu(detect_gpu())
    runtime.set_state(STATE_READY)
    return {"item": clip_payload(safe_index, text, output_path, clip.duration_ms, port)}


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.write_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self.write_json({"ok": True})
            return

        if path == "/status":
            runtime.set_gpu(detect_gpu())
            status = runtime.snapshot()
            status["serviceUrl"] = f"http://127.0.0.1:{self.server.server_port}"
            self.write_json(status)
            return

        if path.startswith("/generated/"):
            filename = path.removeprefix("/generated/")
            self.write_generated_file(filename)
            return

        self.write_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/load":
            try:
                load_model()
                self.write_json({"ok": True})
            except Exception as error:
                runtime.set_state(STATE_ERROR, str(error))
                self.write_json({"error": str(error)}, status=500)
            return

        if path == "/unload":
            try:
                unload_model()
                self.write_json({"ok": True})
            except Exception as error:
                runtime.set_state(STATE_ERROR, str(error))
                self.write_json({"error": str(error)}, status=500)
            return

        if path == "/generate":
            payload = self.read_json()
            text = str(payload.get("text", "")).strip()
            pause_ms = int(payload.get("pauseMs", 500) or 500)
            split = bool(payload.get("split", False))
            if not text:
                self.write_json({"error": "Text is required."}, status=400)
                return

            try:
                self.write_json(generate_audio(text, self.server.server_port, pause_ms=pause_ms, split=split))
            except Exception as error:
                runtime.set_state(STATE_ERROR, str(error))
                self.write_json({"error": str(error)}, status=500)
            return

        if path == "/generate-sentence":
            payload = self.read_json()
            text = str(payload.get("text", "")).strip()
            index = int(payload.get("index", 1) or 1)
            if not text:
                self.write_json({"error": "Text is required."}, status=400)
                return

            try:
                self.write_json(generate_sentence_audio(text, index, self.server.server_port))
            except Exception as error:
                runtime.set_state(STATE_ERROR, str(error))
                self.write_json({"error": str(error)}, status=500)
            return

        if path == "/shutdown":
            run_background(shutdown_server)
            self.write_json({"ok": True})
            return

        self.write_json({"error": "Not found"}, status=404)

    def read_json(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length == 0:
            return {}
        body = self.rfile.read(content_length)
        return json.loads(body.decode("utf-8"))

    def write_generated_file(self, filename: str) -> None:
        safe_name = Path(unquote(filename)).name
        file_path = GENERATED_DIR / safe_name
        if not file_path.exists():
            self.write_json({"error": "Audio file not found."}, status=404)
            return

        file_size = file_path.stat().st_size
        range_header = self.headers.get("Range")
        start = 0
        end = file_size - 1
        status = HTTPStatus.OK

        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if not match:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            start_text, end_text = match.groups()
            start = int(start_text) if start_text else 0
            end = int(end_text) if end_text else file_size - 1
            if start >= file_size or end < start:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            end = min(end, file_size - 1)
            status = HTTPStatus.PARTIAL_CONTENT

        content_length = end - start + 1
        self.send_response(status)
        self.write_cors_headers()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(content_length))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()

        with file_path.open("rb") as audio_file:
            audio_file.seek(start)
            self.wfile.write(audio_file.read(content_length))

    def write_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.write_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")

    def log_message(self, format: str, *args: Any) -> None:
        sys.stdout.write(f"[http] {format % args}\n")


def run_background(target: Any) -> None:
    thread = threading.Thread(target=target, daemon=True)
    thread.start()


def shutdown_server() -> None:
    unload_model()
    if server_ref is not None:
        server_ref.shutdown()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    args = parser.parse_args()

    runtime.set_gpu(detect_gpu())
    runtime.set_state(STATE_STOPPED)

    global server_ref
    server_ref = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Model service listening on http://{args.host}:{args.port}", flush=True)
    server_ref.serve_forever()


if __name__ == "__main__":
    main()
