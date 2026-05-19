from __future__ import annotations

import math
import wave
from pathlib import Path

from .base import GeneratedClip, TtsAdapter


class PlaceholderTtsAdapter(TtsAdapter):
    name = "placeholder"

    def __init__(self) -> None:
        self.loaded = False

    def load(self) -> None:
        self.loaded = True

    def unload(self) -> None:
        self.loaded = False

    def generate_sentence(self, text: str, output_path: Path) -> GeneratedClip:
        if not self.loaded:
            self.load()

        sample_rate = 24000
        duration_seconds = max(1.0, min(8.0, len(text) * 0.12))
        frame_count = int(sample_rate * duration_seconds)
        frequency = 220 + (len(text) % 12) * 18
        amplitude = 9000

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(output_path), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)

            frames = bytearray()
            for index in range(frame_count):
                envelope = min(1.0, index / 1600, (frame_count - index) / 1600)
                value = int(amplitude * envelope * math.sin(2 * math.pi * frequency * index / sample_rate))
                frames.extend(value.to_bytes(2, byteorder="little", signed=True))
            wav_file.writeframes(bytes(frames))

        return GeneratedClip(path=output_path, duration_ms=int(duration_seconds * 1000))
