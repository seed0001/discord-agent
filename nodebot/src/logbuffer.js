// In-memory ring buffer of recent log lines, served to the dashboard's Logs
// tab. Ported from logbuffer.py.
//
// The Python version attached a logging.Handler to the root logger, which
// caught everything including uvicorn and the piped-in sidecar output. Node
// has no logging framework here — the bot logs through console — so this
// wraps the console methods instead. Output still reaches stdout/stderr
// normally (and therefore Railway's log view); this only tees a copy.
//
// Keeps the last MAX_LINES entries and survives nothing: it's a live view,
// not an archive.
import { redact } from './introspect.js';

const MAX_LINES = 1000;

const buffer = [];
let counter = 0;
let installed = false;

// Dashboard pollers would otherwise flood the buffer with their own
// request lines.
const NOISE = ['/api/logs', '/transcripts', '/internal/voice-config'];

const LEVELS = [
  ['log', 'INFO'],
  ['info', 'INFO'],
  ['warn', 'WARNING'],
  ['error', 'ERROR'],
  ['debug', 'DEBUG'],
];

/** Best-effort logger name from a "[tag] message" prefix, matching how the
 * bot's own console calls are written. */
function loggerName(message) {
  const match = message.match(/^\[([a-z0-9_-]+)\]/i);
  return match ? match[1] : 'bot';
}

function record(level, parts) {
  let message;
  try {
    message = parts.map((p) => {
      if (typeof p === 'string') return p;
      if (p instanceof Error) return p.stack || p.message;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    }).join(' ');
  } catch {
    return;
  }
  if (NOISE.some((n) => message.includes(n))) return;
  counter += 1;
  buffer.push({
    id: counter,
    ts: Date.now() / 1000,
    level,
    logger: loggerName(message),
    // Belt-and-suspenders: a log line must never leak a token to the
    // dashboard, even if something logged a raw header by mistake.
    message: redact(message),
  });
  while (buffer.length > MAX_LINES) buffer.shift();
}

/** Tee console output into the buffer. Idempotent. */
export function install() {
  if (installed) return;
  installed = true;
  for (const [method, level] of LEVELS) {
    const original = console[method].bind(console);
    console[method] = (...parts) => {
      record(level, parts);
      original(...parts);
    };
  }
}

/** Entries newer than after_id, most recent `limit` of them. */
export function since(afterId = 0, limit = 500) {
  const entries = buffer.filter((e) => e.id > afterId);
  return entries.slice(-limit);
}

/** Test seam: empty the buffer and reset ids. */
export function _resetForTests() {
  buffer.length = 0;
  counter = 0;
}
