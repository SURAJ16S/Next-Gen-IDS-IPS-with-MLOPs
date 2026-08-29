"""
redis_reputation.py
--------------------
Python-side client for the Tier-2 reputation store and the per-IP rolling
feature store described in the master plan, section 2.2.

Key schema (mirrors the Node.js side in backend-additions/redisSecurityClient.js
— keep both in sync if you change either):

DB 0 — reputation:
    rep:ip:{ip}            HASH   score, last_seen, category_history (json), source
    rep:feed:{feed_name}   SET    known-bad IPs from that feed

DB 1 — rolling per-IP counters (sliding window via ZSET):
    roll:conn:{ip}         ZSET   member=conn_id, score=unix_ts
    roll:failedlogin:{ip}  ZSET   member=attempt_id, score=unix_ts
    roll:ports:{ip}        SET    distinct dest ports touched (TTL refreshed)

DB 2 — CAPTCHA / rate gate (see captcha.middleware.js for the Node side of this):
    gate:reqrate:{ip}      STRING counter, short TTL
    gate:blocked:{ip}      STRING "1", TTL = block duration
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass

import redis

REDIS_HOST = os.getenv("REDIS_SECURITY_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_SECURITY_PORT", "6379"))

REP_DB = 0
ROLLING_DB = 1
GATE_DB = 2

_rep_client: redis.Redis | None = None
_roll_client: redis.Redis | None = None
_gate_client: redis.Redis | None = None


def _client(db: int) -> redis.Redis:
    return redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=db, decode_responses=True)


def get_rep_client() -> redis.Redis:
    global _rep_client
    if _rep_client is None:
        _rep_client = _client(REP_DB)
    return _rep_client


def get_roll_client() -> redis.Redis:
    global _roll_client
    if _roll_client is None:
        _roll_client = _client(ROLLING_DB)
    return _roll_client


def get_gate_client() -> redis.Redis:
    global _gate_client
    if _gate_client is None:
        _gate_client = _client(GATE_DB)
    return _gate_client


@dataclass
class ReputationResult:
    ip: str
    score: int
    known_bad: bool
    source: str | None
    found: bool


def lookup_reputation(ip: str) -> ReputationResult:
    """Fast Tier-2 lookup. Call this BEFORE running Tier-3 ML scoring —
    if score is already high, there's no need to spend ML compute on it."""
    c = get_rep_client()
    data = c.hgetall(f"rep:ip:{ip}")
    if not data:
        return ReputationResult(ip=ip, score=0, known_bad=False, source=None, found=False)
    score = int(data.get("score", 0))
    return ReputationResult(
        ip=ip, score=score, known_bad=score >= 80,
        source=data.get("source"), found=True,
    )


def bump_reputation(ip: str, delta: int, reason: str, max_score: int = 100) -> int:
    """Increase (or, with a negative delta, decay) an IP's reputation score.
    Call this whenever Tier 1/2/3 produces a new detection for that IP."""
    c = get_rep_client()
    key = f"rep:ip:{ip}"
    current = int(c.hget(key, "score") or 0)
    new_score = max(0, min(max_score, current + delta))
    c.hset(key, mapping={
        "score": new_score,
        "last_seen": int(time.time()),
        "source": "local",
    })
    # keep a small rolling history of *why* this IP's score changed —
    # bounded so it can't grow unbounded (keep last 20 reasons)
    history_key = f"rep:ip:{ip}:history"
    c.lpush(history_key, json.dumps({"ts": int(time.time()), "delta": delta, "reason": reason}))
    c.ltrim(history_key, 0, 19)
    return new_score


def is_known_bad_feed_ip(ip: str, feed_names: list[str] | None = None) -> str | None:
    """Checks membership across configured threat-intel feed sets
    (see master plan section 2.3, task 3, for how these sets get populated).
    Returns the feed name that matched, or None."""
    c = get_rep_client()
    feed_names = feed_names or ["abuseipdb", "spamhaus_drop", "firehol", "cins_army"]
    for feed in feed_names:
        if c.sismember(f"rep:feed:{feed}", ip):
            return feed
    return None


# ---------------------------------------------------------------------------
# Rolling per-IP behavioral counters — sliding window pattern
# ---------------------------------------------------------------------------

def record_event(ip: str, event_type: str, event_id: str, window_seconds: int = 600) -> int:
    """Adds one event (a connection, a failed login, etc.) to the sliding
    window for that IP+event_type, trims anything older than the window, and
    returns the current count within the window.

    event_type is a free string used as part of the redis key, e.g.
    "conn" or "failedlogin" — matches the roll:{event_type}:{ip} schema.
    """
    c = get_roll_client()
    key = f"roll:{event_type}:{ip}"
    now = time.time()
    c.zadd(key, {event_id: now})
    c.zremrangebyscore(key, "-inf", now - window_seconds)
    c.expire(key, window_seconds * 2)  # safety TTL in case the key stops being touched
    return c.zcard(key)


def get_rolling_count(ip: str, event_type: str, window_seconds: int = 600) -> int:
    c = get_roll_client()
    key = f"roll:{event_type}:{ip}"
    now = time.time()
    c.zremrangebyscore(key, "-inf", now - window_seconds)
    return c.zcard(key)


def record_port_touch(ip: str, port: int, ttl_seconds: int = 3600) -> int:
    c = get_roll_client()
    key = f"roll:ports:{ip}"
    c.sadd(key, str(port))
    c.expire(key, ttl_seconds)
    return c.scard(key)


def build_behavioral_features(ip: str) -> dict:
    """Assembles the per-IP rolling features the ML feature encoder should
    fold in alongside PayloadStats/FlowRecord (see master plan section
    "missing: no cross-flow, per-IP historical features"). This is the
    bridge between Redis's rolling counters and the model's numeric input."""
    return {
        "recent_conn_count_10m": get_rolling_count(ip, "conn", window_seconds=600),
        "recent_failed_login_count_10m": get_rolling_count(ip, "failedlogin", window_seconds=600),
        "distinct_ports_touched_1h": get_roll_client().scard(f"roll:ports:{ip}"),
    }


# ---------------------------------------------------------------------------
# Block cache (fast-path read; Mongo/BlockedEntity remains the source of truth
# — see master plan section 2.3 "golden rule")
# ---------------------------------------------------------------------------

def cache_block(ip: str, ttl_seconds: int | None) -> None:
    c = get_gate_client()
    key = f"gate:blocked:{ip}"
    if ttl_seconds:
        c.set(key, "1", ex=ttl_seconds)
    else:
        c.set(key, "1")  # indefinite; explicit DEL required to remove


def is_blocked(ip: str) -> bool:
    return get_gate_client().exists(f"gate:blocked:{ip}") == 1


def clear_block(ip: str) -> None:
    get_gate_client().delete(f"gate:blocked:{ip}")


if __name__ == "__main__":
    # Smoke test against a local Redis (redis-server must be running).
    # This will raise a clear connection error if Redis isn't up yet —
    # that's expected until you complete Phase A's docker-compose setup.
    test_ip = "203.0.113.10"
    print("Reputation before:", lookup_reputation(test_ip))
    new_score = bump_reputation(test_ip, delta=25, reason="test sqli detection")
    print("Reputation after bump:", new_score)
    print("Rolling conn count:", record_event(test_ip, "conn", "conn-test-1"))
    print("Behavioral features:", build_behavioral_features(test_ip))
