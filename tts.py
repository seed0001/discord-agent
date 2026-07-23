"""TTS synthesis for voice replies: Fish Audio (when FISH_API_KEY is set)
with edge-tts as the free fallback.

Fish Audio setup (env vars):
  FISH_API_KEY   — api key from fish.audio
  FISH_TTS_MODEL — model header: "s1" (parenthesis emotion tags), "s2-pro", ...
  FISH_VOICE_ID  — reference_id of the voice model to speak with

With the S1 model, emotion/tone tags like "(excited)" or "(whispering)" can
be embedded at the start of sentences — the AI is prompted to include them
(see bot/cogs/voice.py); strip_voice_tags() removes them for text display.
"""
import logging
import re

import httpx

import config

log = logging.getLogger("tts")

FISH_URL = "https://api.fish.audio/v1/tts"

# S1's fixed tag vocabulary (emotions, tones, effects) — used both to tell
# the model what it may use and to strip tags from text shown in chat.
S1_TAGS = {
    # emotions
    "angry", "sad", "disdainful", "excited", "surprised", "satisfied",
    "unhappy", "anxious", "hysterical", "delighted", "scared", "worried",
    "indifferent", "upset", "impatient", "nervous", "guilty", "scornful",
    "frustrated", "depressed", "panicked", "furious", "empathetic",
    "embarrassed", "reluctant", "disgusted", "keen", "moved", "proud",
    "relaxed", "grateful", "confident", "interested", "curious", "confused",
    "joyful", "disapproving", "negative", "denying", "astonished", "serious",
    "sarcastic", "conciliative", "comforting", "sincere", "sneering",
    "hesitating", "yielding", "painful", "awkward", "amused",
    # tones
    "in a hurry tone", "shouting", "screaming", "whispering", "soft tone",
    # effects / pauses (includes S2 paralanguage cues, also parenthesized)
    "laughing", "chuckling", "sobbing", "crying loudly", "sighing",
    "panting", "groaning", "break", "long-break", "breath",
    "laugh", "cough", "sigh", "lip-smacking",
}

_TAG_RE = re.compile(
    r"\((?:" + "|".join(re.escape(t) for t in sorted(S1_TAGS, key=len, reverse=True)) + r")\)\s*",
    re.IGNORECASE,
)
# S2 models take free-form [bracketed] voice directions anywhere in the text
_S2_TAG_RE = re.compile(r"\[[^\[\]\n]{1,60}\]\s*")


def fish_enabled() -> bool:
    return bool(config.FISH_API_KEY)


def is_s2() -> bool:
    return config.FISH_TTS_MODEL.lower().startswith("s2")


def strip_voice_tags(text: str) -> str:
    """Remove voice tags for text display; the tagged version goes to TTS."""
    text = _TAG_RE.sub("", text)
    text = _S2_TAG_RE.sub("", text)
    return text.strip()


async def synthesize(text: str) -> bytes | None:
    """Return mp3 audio for text, or None if no TTS backend works."""
    if fish_enabled():
        audio = await _fish(text)
        if audio:
            return audio
    return await _edge(strip_voice_tags(text))


async def _fish(text: str) -> bytes | None:
    headers = {
        "Authorization": f"Bearer {config.FISH_API_KEY}",
        "Content-Type": "application/json",
        "model": config.FISH_TTS_MODEL,
    }
    payload = {"text": text[:2000], "format": "mp3", "latency": "normal"}
    if config.FISH_VOICE_ID:
        payload["reference_id"] = config.FISH_VOICE_ID
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(FISH_URL, headers=headers, json=payload)
        if resp.status_code != 200:
            log.warning("Fish Audio TTS %s: %s", resp.status_code, resp.text[:200])
            return None
        return resp.content or None
    except httpx.HTTPError as exc:
        log.warning("Fish Audio TTS failed: %s", exc)
        return None


async def _edge(text: str) -> bytes | None:
    try:
        import edge_tts

        buf = bytearray()
        async for chunk in edge_tts.Communicate(text[:800], voice="en-US-GuyNeural").stream():
            if chunk["type"] == "audio":
                buf += chunk["data"]
        return bytes(buf) or None
    except Exception as exc:
        log.info("edge-tts unavailable (%s)", exc)
        return None
