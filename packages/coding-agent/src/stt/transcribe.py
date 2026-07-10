"""Transcribe a WAV file using mlx-whisper (Apple Silicon optimized).

Reads WAV directly via Python's wave module.
Resamples to 16kHz mono float32 and passes to mlx_whisper.transcribe().

Usage: python transcribe.py <audio.wav> <model_name> <language>
Prints transcribed text to stdout.
"""

import sys
import wave
import re

import numpy as np
import mlx_whisper


def load_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as wf:
        rate = wf.getframerate()
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if width == 2:
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 1:
        audio = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 4:
        audio = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported sample width: {width}")

    # Mix to mono
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    # Resample to 16 kHz
    if rate != 16000:
        target_len = int(len(audio) * 16000 / rate)
        audio = np.interp(
            np.linspace(0, len(audio) - 1, target_len),
            np.arange(len(audio)),
            audio,
        ).astype(np.float32)

    return audio


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python transcribe.py <audio.wav> [model_name] [language]", file=sys.stderr)
        sys.exit(1)
    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "mlx-community/whisper-large-v3-turbo"
    language = sys.argv[3] if len(sys.argv) > 3 else "en"
    if not re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z]{2})?", language):
        print(f"Invalid language code: {language}", file=sys.stderr)
        sys.exit(1)

    audio = load_wav(audio_path)
    result = mlx_whisper.transcribe(audio, path_or_hf_repo=model_name, language=language)
    print(result["text"].strip())


if __name__ == "__main__":
    main()
