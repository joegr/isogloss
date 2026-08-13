"""Audio ingest.

The browser sends 16-bit PCM WAV at 16 kHz, encoded in the page itself from a
WebAudio graph. That is a deliberate choice: taking raw PCM instead of
MediaRecorder's Opus means no ffmpeg, no codec dependency, and no lossy
compression sitting between the speaker and a formant tracker.

Uploaded files may be anything WAV-shaped, so this also handles 8/24/32-bit,
stereo, and arbitrary sample rates.
"""

from __future__ import annotations

import io
import wave

import numpy as np
from scipy.signal import resample_poly

TARGET_SR = 16000
MAX_SECONDS = 60.0


class AudioError(ValueError):
    pass


def read_wav(data: bytes) -> tuple[np.ndarray, int]:
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            channels = w.getnchannels()
            width = w.getsampwidth()
            sr = w.getframerate()
            raw = w.readframes(w.getnframes())
    except wave.Error as exc:
        raise AudioError(f"Not a readable WAV file: {exc}") from exc

    if width == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif width == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = (b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16))
        v = np.where(v & 0x800000, v - 0x1000000, v)
        x = v.astype(np.float64) / 8388608.0
    elif width == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    else:
        raise AudioError(f"Unsupported sample width: {width * 8} bit")

    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    return x, sr


def prepare(data: bytes) -> tuple[np.ndarray, int]:
    """Decode, downmix, resample to 16 kHz, trim, and DC-block."""
    x, sr = read_wav(data)
    if x.size == 0:
        raise AudioError("Empty audio")

    if sr != TARGET_SR:
        g = np.gcd(int(sr), TARGET_SR)
        x = resample_poly(x, TARGET_SR // g, sr // g)
        sr = TARGET_SR

    x = x[: int(MAX_SECONDS * sr)]
    x = x - float(np.mean(x))

    if float(np.max(np.abs(x))) < 1e-4:
        raise AudioError("Audio is silent")
    if len(x) < int(0.4 * sr):
        raise AudioError("Need at least 0.4 s of audio")
    return x, sr
