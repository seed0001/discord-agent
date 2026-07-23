"""Speech-to-text via an OpenAI-compatible transcription endpoint.

Works with OpenAI Whisper (api.openai.com), Groq (api.groq.com/openai/v1),
or any other /audio/transcriptions-compatible service — set
TRANSCRIPTION_API_URL / TRANSCRIPTION_API_KEY / TRANSCRIPTION_MODEL.
"""
import io
import logging
import wave

import httpx

import config

log = logging.getLogger("transcription")

SAMPLE_RATE = 48000  # Discord voice PCM: 48kHz, 16-bit, stereo
CHANNELS = 2
SAMPLE_WIDTH = 2

# Whisper tends to hallucinate these on silence/noise-only clips
JUNK = {
    "you", "bye", "thank you", "thanks", "thank you for watching",
    "thanks for watching", "subscribe", ".", "the",
}


def available() -> bool:
    return bool(config.TRANSCRIPTION_API_KEY)


def pcm_to_wav(pcm: bytes) -> bytes:
    """Wrap raw Discord voice PCM in a WAV container."""
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(CHANNELS)
        wav.setsampwidth(SAMPLE_WIDTH)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return out.getvalue()


async def transcribe_pcm(pcm: bytes) -> str:
    """Transcribe one utterance of raw PCM. Returns "" for silence/junk/errors."""
    if not available() or not pcm:
        return ""
    url = config.TRANSCRIPTION_API_URL.rstrip("/") + "/audio/transcriptions"
    headers = {"Authorization": f"Bearer {config.TRANSCRIPTION_API_KEY}"}
    files = {"file": ("utterance.wav", pcm_to_wav(pcm), "audio/wav")}
    data = {"model": config.TRANSCRIPTION_MODEL, "response_format": "json"}
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, headers=headers, files=files, data=data)
        if resp.status_code != 200:
            log.warning("Transcription API %s: %s", resp.status_code, resp.text[:200])
            return ""
        text = (resp.json().get("text") or "").strip()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("Transcription failed: %s", exc)
        return ""
    if text.rstrip(".!?, ").lower() in JUNK:
        return ""
    return text
