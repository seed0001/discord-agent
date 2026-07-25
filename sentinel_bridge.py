"""GuddaLM-inspired Discord event anomaly sentinel.

Adapts NetworkSentinel pattern (FlowEncoder + adaptive baseline MAP accumulator
with exponential decay) to Discord server events — member joins/leaves, message
bursts, mention storms, and channel hops.

Usage:

    from sentinel_bridge import DiscordSentinel

    sentinel = DiscordSentinel()
    report = sentinel.observe("MESSAGE_BURST", channel_id="123", rate="0.8",
                              window_seconds="10")
    if report["verdict"] == "QUARANTINE":
        ...  # take action
"""

import math

from gudda_bridge import HDVector

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEFAULT_DIM = 10000
ALPHA = 0.98               # exponential decay factor  (lower = faster adaptation)
ANOMALY_WARN = 0.15        # similarity deficit → log a warning
ANOMALY_QUARANTINE = 0.35  # similarity deficit → take automated action

# Which role names each event-type uses  (dynamic, not hard-enforced by encoder)
EVENT_FIELDS = {
    "MEMBER_JOIN":     ("user_id", "role_count"),
    "MEMBER_LEAVE":    ("user_id", "presence_seconds"),
    "MESSAGE_BURST":   ("channel_id", "rate", "window_seconds"),
    "MENTION_STORM":   ("target_user_id", "mention_count", "source_count"),
    "CHANNEL_HOP":     ("user_id", "from_channel", "to_channel", "interval_seconds"),
}

# All role names known to the encoder (pre-generates role vectors at init)
_ALL_ROLES = sorted({
    r for fields in EVENT_FIELDS.values() for r in fields
} | {"event_type"})


# ---------------------------------------------------------------------------
# Encoder
# ---------------------------------------------------------------------------
class DiscordEventEncoder:
    """Encodes Discord server events into MAP (±1) hypervectors.

    Each event is a conjunction (element-wise product / bind) of role-filler
    pairs::

        event = role(user_id)⊗filler("42")
              ⊗ role(rate)⊗filler("0.8")
              ⊗ role(event_type)⊗filler("MESSAGE_BURST")
    """

    def __init__(self, dim: int = DEFAULT_DIM):
        self.dim = dim
        self._role_vecs: dict[str, HDVector] = {
            name: HDVector.from_key(f"role:{name}", dim)
            for name in _ALL_ROLES
        }

    def encode(self, event_type: str, **fields: str) -> tuple:
        """Encode a Discord event.

        Args:
            event_type: one of the EVENT_FIELDS keys (e.g. "MESSAGE_BURST").
            **fields: field-name → string-value pairs matching the event type.

        Returns:
            (conjunctive_vector, disjunctive_vector, bound_attributes_dict)

            The conjunctive (product) is the full event fingerprint for anomaly
            scoring.  The disjunctive (sum) and per-attribute bound vectors
            support diagnostic queries about which specific attribute triggered
            the anomaly.
        """
        # Inject event_type as a discriminator field
        all_fields = dict(fields, event_type=event_type)

        bound: dict[str, HDVector] = {}
        for name, value in all_fields.items():
            rv = self._role_vecs.get(name)
            if rv is None:
                continue
            fv = HDVector.from_key(f"filler:{str(value)}", self.dim)
            bound[name] = rv.bind(fv)

        if not bound:
            # Should not happen for well-formed calls
            return HDVector.zeros(self.dim), HDVector.zeros(self.dim), {}

        vecs = list(bound.values())

        # Conjunctive: bind (product) of all role-filler pairs
        conj = vecs[0]
        for v in vecs[1:]:
            conj = conj.bind(v)

        # Disjunctive: bundle (sum) for attribute-level diagnostics
        disj = vecs[0]
        for v in vecs[1:]:
            disj = disj.bundle(v)

        return conj, disj, bound


# ---------------------------------------------------------------------------
# Sentinel
# ---------------------------------------------------------------------------
class DiscordSentinel:
    """Adaptive baseline anomaly detector for Discord server events.

    Maintains a real-valued MAP accumulator with exponential decay:

        S_{t+1} = α · S_t + (1 - α) · event_vector      α = 0.98

    On each ``observe()`` call the incoming event's cosine similarity against
    the current baseline is computed.  The *anomaly score* is

        anomaly = max(0, 1 - similarity)

    and is compared against two thresholds:

        < 0.15  →  ALLOW
        0.15–0.35 →  WARN  (log / notify)
        ≥ 0.35  →  QUARANTINE  (automated action)
    """

    __slots__ = (
        "dim", "_alpha", "_warn_threshold", "_quarantine_threshold",
        "encoder", "_baseline", "initialized", "event_count",
    )

    def __init__(
        self,
        dim: int = DEFAULT_DIM,
        alpha: float = ALPHA,
        warn_threshold: float = ANOMALY_WARN,
        quarantine_threshold: float = ANOMALY_QUARANTINE,
    ):
        self.dim = dim
        self._alpha = alpha
        self._warn_threshold = warn_threshold
        self._quarantine_threshold = quarantine_threshold
        self.encoder = DiscordEventEncoder(dim)
        self._baseline: HDVector | None = None
        self.initialized = False
        self.event_count = 0

    # -- properties ----------------------------------------------------------

    @property
    def alpha(self) -> float:
        return self._alpha

    @alpha.setter
    def alpha(self, val: float) -> None:
        self._alpha = val

    @property
    def warn_threshold(self) -> float:
        return self._warn_threshold

    @warn_threshold.setter
    def warn_threshold(self, val: float) -> None:
        self._warn_threshold = val

    @property
    def quarantine_threshold(self) -> float:
        return self._quarantine_threshold

    @quarantine_threshold.setter
    def quarantine_threshold(self, val: float) -> None:
        self._quarantine_threshold = val

    # -- core ----------------------------------------------------------------

    def observe(self, event_type: str, **fields) -> dict:
        """Process an event, compute anomaly, update baseline.

        Args:
            event_type: e.g. "MESSAGE_BURST", "MENTION_STORM", "MEMBER_JOIN".
            **fields: field → str values, passed to ``DiscordEventEncoder.encode``.

        Returns:
            Report dict with keys:
                event_type, similarity (float), anomaly_score (float),
                verdict (str), message (str)
        """
        self.event_count += 1
        conj, _disj, _attrs = self.encoder.encode(event_type, **fields)

        if not self.initialized:
            self._baseline = conj
            self.initialized = True
            return {
                "event_type": event_type,
                "similarity": 1.0,
                "anomaly_score": 0.0,
                "verdict": "INIT",
                "message": f"Baseline seeded with first {event_type} event.",
            }

        # Similarity & anomaly
        similarity = conj.cosine_similarity(self._baseline)
        anomaly_score = max(0.0, 1.0 - max(-1.0, min(1.0, similarity)))

        # Verdict
        if anomaly_score >= self._quarantine_threshold:
            verdict = "QUARANTINE"
            message = (
                f"Severe anomaly ({event_type}): "
                f"score={anomaly_score:.3f}, sim={similarity:.3f}"
            )
        elif anomaly_score >= self._warn_threshold:
            verdict = "WARN"
            message = (
                f"Anomalous event ({event_type}): "
                f"score={anomaly_score:.3f}, sim={similarity:.3f}"
            )
        else:
            verdict = "ALLOW"
            message = f"Normal ({event_type}) — score={anomaly_score:.3f}"

        # Adaptive baseline update: S = α·S + (1-α)·event
        a, om_a = self._alpha, 1.0 - self._alpha
        self._baseline = HDVector(
            self.dim,
            [a * s + om_a * e for s, e in zip(self._baseline.data, conj.data)],
        )

        return {
            "event_type": event_type,
            "similarity": similarity,
            "anomaly_score": anomaly_score,
            "verdict": verdict,
            "message": message,
        }

    def reset(self) -> None:
        """Clear baseline (e.g. after a verified raid resolves)."""
        self._baseline = None
        self.initialized = False
        self.event_count = 0

    # -- diagnostics ---------------------------------------------------------

    @property
    def baseline(self) -> HDVector | None:
        return self._baseline
