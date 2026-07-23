"""In-memory ring buffer of recent log lines, served to the dashboard Logs tab.

Captures everything that goes through python logging (bot, cogs, uvicorn,
discord.py) plus the Node listener sidecar's output, which main.py pipes in
under the "listener" logger. Keeps the last MAX_LINES entries; survives
nothing — it's a live view, not an archive.
"""
import collections
import itertools
import logging
import threading

MAX_LINES = 1000

BUFFER: collections.deque = collections.deque(maxlen=MAX_LINES)
_counter = itertools.count(1)
_lock = threading.Lock()

# Dashboard pollers would flood the buffer with their own access-log lines
_NOISE = ("/api/logs", "/transcripts", "/internal/voice-config")


class BufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
        except Exception:
            return
        if record.name == "uvicorn.access" and any(n in message for n in _NOISE):
            return
        with _lock:
            BUFFER.append({
                "id": next(_counter),
                "ts": record.created,
                "level": record.levelname,
                "logger": record.name,
                "message": message,
            })


_installed = False


def install() -> None:
    global _installed
    if _installed:
        return
    _installed = True
    logging.getLogger().addHandler(BufferHandler())


def since(after_id: int = 0, limit: int = 500) -> list[dict]:
    with _lock:
        entries = [e for e in BUFFER if e["id"] > after_id]
    return entries[-limit:]
