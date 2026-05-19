import json
import wave
from pathlib import Path

PROFILE_PATH = Path("auto_speech_data/profiles/default/profile.json")
REFERENCE_DIR = Path("auto_speech_data/profiles/default/reference")
REFERENCE_PROMPT = "这是我的声音样本，用来帮助软件生成自然清晰的中文旁白。"


def trim_wav(input_path: Path, output_path: Path, seconds: int = 8) -> None:
    with wave.open(str(input_path), "rb") as reader:
        params = reader.getparams()
        frame_count = min(reader.getnframes(), int(reader.getframerate() * seconds))
        frames = reader.readframes(frame_count)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output_path), "wb") as writer:
        writer.setparams(params)
        writer.writeframes(frames)


def main() -> None:
    profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8-sig"))
    REFERENCE_DIR.mkdir(parents=True, exist_ok=True)

    for sample in profile.get("samples", []):
        source = sample.get("normalizedPath") or sample.get("path")
        if not source:
            continue

        output_path = REFERENCE_DIR / f"{sample['id']}-ref.wav"
        trim_wav(Path(source), output_path)
        sample["referencePath"] = str(output_path.resolve())
        sample["referencePromptText"] = REFERENCE_PROMPT

    PROFILE_PATH.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(profile.get("samples", [])[-1], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
