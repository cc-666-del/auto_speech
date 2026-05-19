from __future__ import annotations

import gc
import json
import logging
import sys
from pathlib import Path
from typing import Any

from .base import GeneratedClip, TtsAdapter


class CosyVoiceAdapter(TtsAdapter):
    name = "cosyvoice"
    prefer_single_request = False

    def __init__(self, project_root: Path, config: dict[str, Any]) -> None:
        self.project_root = project_root
        self.config = config
        self.model: Any | None = None
        self.sample_rate = 24000

    def load(self) -> None:
        if self.model is not None:
            return

        repo_dir = self.resolve_repo_dir()
        model_dir = self.resolve_model_dir()
        if not repo_dir.exists() or not (repo_dir / "cosyvoice").exists():
            raise RuntimeError(
                "CosyVoice is not installed. Run scripts/setup-cosyvoice.ps1 from a normal PowerShell terminal."
            )
        if not model_dir.exists():
            raise RuntimeError(
                "CosyVoice model weights are missing. Run scripts/setup-cosyvoice.ps1 to download CosyVoice2-0.5B."
            )

        repo_path = str(repo_dir)
        if repo_path not in sys.path:
            sys.path.insert(0, repo_path)
        matcha_path = str(repo_dir / "third_party" / "Matcha-TTS")
        if matcha_path not in sys.path:
            sys.path.insert(0, matcha_path)

        patch_cosyvoice_audio_loader()

        try:
            from cosyvoice.cli.cosyvoice import AutoModel
        except Exception as error:
            try:
                from cosyvoice.cli.cosyvoice import CosyVoice2
            except Exception as fallback_error:
                raise RuntimeError(
                    "CosyVoice Python dependencies are not available. Run scripts/setup-cosyvoice.ps1 first."
                ) from fallback_error

            self.model = CosyVoice2(
                str(model_dir),
                load_jit=bool(self.config.get("loadJit", False)),
                load_trt=bool(self.config.get("loadTrt", False)),
                fp16=bool(self.config.get("useFp16", True)),
            )
        else:
            self.model = AutoModel(
                model_dir=str(model_dir),
                load_jit=bool(self.config.get("loadJit", False)),
                load_trt=bool(self.config.get("loadTrt", False)),
                fp16=bool(self.config.get("useFp16", True)),
            )

        self.sample_rate = int(getattr(self.model, "sample_rate", 24000))

    def unload(self) -> None:
        self.model = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except Exception:
            pass

    def generate_sentence(self, text: str, output_path: Path) -> GeneratedClip:
        return self.generate_text(text, output_path)

    def generate_text(self, text: str, output_path: Path) -> GeneratedClip:
        if self.model is None:
            self.load()

        ref_audio_path, prompt_text = self.resolve_reference_audio()

        output_path.parent.mkdir(parents=True, exist_ok=True)
        chunks = list(
            self.model.inference_zero_shot(
                text,
                prompt_text,
                ref_audio_path,
                stream=False,
            )
        )
        if not chunks:
            raise RuntimeError("CosyVoice returned no audio.")

        speech = chunks[0]["tts_speech"]
        save_wav_with_soundfile(output_path, speech, self.sample_rate)
        return GeneratedClip(path=output_path, duration_ms=estimate_audio_duration_ms(output_path))

    def resolve_repo_dir(self) -> Path:
        return self.project_root / str(self.config.get("repoDir", "models/CosyVoice"))

    def resolve_model_dir(self) -> Path:
        return self.project_root / str(
            self.config.get("modelDir", "models/CosyVoice/pretrained_models/CosyVoice2-0.5B")
        )

    def resolve_reference_audio(self) -> tuple[str, str]:
        profile_path = self.project_root / "auto_speech_data" / "profiles" / "default" / "profile.json"
        if not profile_path.exists():
            raise RuntimeError("No voice profile found. Record or import a voice sample first.")

        profile = json.loads(profile_path.read_text(encoding="utf-8-sig"))
        samples = profile.get("samples", [])
        if not samples:
            raise RuntimeError("No voice samples found. Record or import a voice sample first.")

        active_sample_id = str(profile.get("activeSampleId") or "").strip()
        sample = next(
            (
                item
                for item in samples
                if str(item.get("id") or "") == active_sample_id
                and file_exists(item.get("normalizedPath") or item.get("referencePath") or item.get("path"))
            ),
            None,
        )
        if sample is None:
            sample = next(
                (
                    item
                    for item in reversed(samples)
                    if file_exists(item.get("normalizedPath") or item.get("referencePath") or item.get("path"))
                ),
                samples[-1],
            )
        ref_audio_path = sample.get("normalizedPath") or sample.get("referencePath") or sample.get("path")
        prompt_text = str(sample.get("promptText") or "").strip()
        if not ref_audio_path:
            raise RuntimeError("Selected voice sample has no audio path.")
        if not prompt_text:
            raise RuntimeError("Fill in the exact words spoken in the voice sample before generating.")

        return str(ref_audio_path), prompt_text


def file_exists(file_path: Any) -> bool:
    return bool(file_path) and Path(str(file_path)).exists()


def estimate_audio_duration_ms(path: Path) -> int:
    import wave

    with wave.open(str(path), "rb") as wav_file:
        return int(wav_file.getnframes() / wav_file.getframerate() * 1000)


def load_wav_with_soundfile(path: str, target_sample_rate: int) -> Any:
    logging.getLogger("numba").setLevel(logging.WARNING)

    import librosa
    import numpy as np
    import soundfile as sf
    import torch

    audio, sample_rate = sf.read(path, dtype="float32")
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    if sample_rate != target_sample_rate:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=target_sample_rate)
    return torch.from_numpy(audio).unsqueeze(0)


def save_wav_with_soundfile(path: Path, speech: Any, sample_rate: int) -> None:
    import numpy as np
    import soundfile as sf

    if hasattr(speech, "detach"):
        audio = speech.detach().cpu().float().numpy()
    else:
        audio = np.asarray(speech, dtype=np.float32)

    if audio.ndim == 2 and audio.shape[0] <= 8:
        audio = audio.T
    audio = np.squeeze(audio)
    sf.write(str(path), audio, sample_rate)


def patch_cosyvoice_audio_loader() -> None:
    try:
        import cosyvoice.cli.frontend as frontend
        import cosyvoice.utils.file_utils as file_utils
    except Exception:
        return

    file_utils.load_wav = load_wav_with_soundfile
    frontend.load_wav = load_wav_with_soundfile
