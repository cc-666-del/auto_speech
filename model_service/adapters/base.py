from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class GeneratedClip:
    path: Path
    duration_ms: int


class TtsAdapter:
    name = "base"
    prefer_single_request = False

    def load(self) -> None:
        raise NotImplementedError

    def unload(self) -> None:
        raise NotImplementedError

    def generate_sentence(self, text: str, output_path: Path) -> GeneratedClip:
        raise NotImplementedError

    def generate_text(self, text: str, output_path: Path) -> GeneratedClip:
        return self.generate_sentence(text, output_path)
