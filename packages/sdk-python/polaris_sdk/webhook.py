"""polaris-email webhook verifier (HMAC v1/v2).

Single-file. Python 3.10+. No external dependencies.
"""
from __future__ import annotations
import hashlib
import hmac
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Iterable, Literal, Mapping, Optional


Direction = Literal["polaris-api.v1", "polaris-webhook.v1"]


@dataclass
class VerifyResult:
    ok: bool
    code: str = ""
    message: str = ""
    algorithm: str = ""
    ts: int = 0
    nonce: str = ""


@dataclass
class VerifyInput:
    direction: Direction = "polaris-webhook.v1"
    method: str = "POST"
    path: str = "/"
    query: str = ""
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes = b""
    secret: bytes = b""
    allowed_algorithms: Iterable[str] = ("v1", "v2")
    skew_seconds: int = 300
    now_ms: Optional[int] = None


def _pick(headers: Mapping[str, str], name: str) -> Optional[str]:
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v
    return None


def _no_crlf(s: str) -> bool:
    if not s:
        return False
    for c in s:
        o = ord(c)
        if o in (0, 9, 10, 13, 32) or o > 0x7E:
            return False
    return True


def _canonical_query(raw: str) -> str:
    if not raw:
        return ""
    if raw.startswith("?"):
        raw = raw[1:]
    if not raw:
        return ""
    pairs = urllib.parse.parse_qsl(raw, keep_blank_values=True)
    pairs.sort(key=lambda kv: (kv[0].lower(), kv[1]))
    return "&".join(
        f"{urllib.parse.quote(k.lower(), safe='')}={urllib.parse.quote(v, safe='')}"
        for k, v in pairs
    )


def verify_webhook(inp: VerifyInput) -> VerifyResult:
    """Verify an HMAC-signed inbound webhook (or API) request.

    Defaults to accepting both ``v1=`` and ``v2=`` algorithm tags so subscribers
    can verify legacy deliveries during the v2 rollout. Restrict the allowlist
    via ``inp.allowed_algorithms`` once you've fully migrated.
    """
    ts_raw = _pick(inp.headers, "x-polaris-ts")
    nonce = _pick(inp.headers, "x-polaris-nonce")
    sig = _pick(inp.headers, "x-polaris-sig")
    if ts_raw is None:
        return VerifyResult(False, "missing_header", "X-Polaris-Ts")
    if nonce is None:
        return VerifyResult(False, "missing_header", "X-Polaris-Nonce")
    if sig is None:
        return VerifyResult(False, "missing_header", "X-Polaris-Sig")
    if not _no_crlf(ts_raw) or not _no_crlf(nonce) or not _no_crlf(sig):
        return VerifyResult(False, "header_invalid", "whitespace/CRLF")
    eq = sig.find("=")
    if eq <= 0:
        return VerifyResult(False, "header_invalid", "sig format")
    prefix = sig[:eq]
    hex_part = sig[eq + 1 :]
    if not all(c in "0123456789abcdef" for c in hex_part):
        return VerifyResult(False, "header_invalid", "sig hex")
    if prefix not in set(inp.allowed_algorithms):
        return VerifyResult(False, "algorithm_rejected", prefix)
    try:
        ts = int(ts_raw)
    except ValueError:
        return VerifyResult(False, "header_invalid", "ts not integer")
    if str(ts) != ts_raw:
        return VerifyResult(False, "header_invalid", "ts canonical")
    now_ms = inp.now_ms if inp.now_ms is not None else int(time.time() * 1000)
    if abs(now_ms - ts) > inp.skew_seconds * 1000:
        return VerifyResult(False, "clock_skew", "ts skew")
    if not 16 <= len(nonce) <= 128:
        return VerifyResult(False, "header_invalid", "nonce length")
    method = inp.method.upper()
    if not method or not all(c.isalpha() and c.isupper() for c in method):
        return VerifyResult(False, "header_invalid", "method")
    if not inp.path.startswith("/"):
        return VerifyResult(False, "header_invalid", "path")
    body_hash = hashlib.sha256(inp.body).hexdigest()
    canonical = "\n".join(
        [
            inp.direction,
            method,
            inp.path,
            _canonical_query(inp.query),
            ts_raw,
            nonce,
            body_hash,
        ]
    ).encode("utf-8")
    expected = hmac.new(inp.secret, canonical, hashlib.sha256).digest()
    try:
        provided = bytes.fromhex(hex_part)
    except ValueError:
        return VerifyResult(False, "header_invalid", "sig hex")
    if len(expected) != len(provided) or not hmac.compare_digest(expected, provided):
        return VerifyResult(False, "bad_signature", "hmac mismatch")
    return VerifyResult(True, algorithm=prefix, ts=ts, nonce=nonce)
