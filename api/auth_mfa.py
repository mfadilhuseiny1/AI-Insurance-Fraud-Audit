"""Two-factor authentication with an authenticator app (TOTP, RFC 6238: 6 digits, 30 seconds, SHA-1 — what Google
Authenticator, Microsoft Authenticator, 1Password and Authy use), and one-time recovery codes.

The secret is stored sealed (secretbox.py, the key in data/secrets) and only shown while setting it up; recovery
codes are stored as SHA-256 hashes and each works once. A code is accepted within one 30-second step either side,
and never twice in the same step (replays are refused).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from typing import Optional
from urllib.parse import quote

DIGITS = 6
STEP = 30
ISSUER = "BluesandAI"


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _key(secret: str) -> bytes:
    s = secret.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def code_at(secret: str, counter: int) -> str:
    digest = hmac.new(_key(secret), struct.pack(">Q", counter), hashlib.sha1).digest()
    o = digest[-1] & 0x0F
    n = (struct.unpack(">I", digest[o:o + 4])[0] & 0x7FFFFFFF) % 10**DIGITS
    return str(n).zfill(DIGITS)


def verify(secret: str, code: str, last_counter: Optional[int] = None, now: Optional[float] = None, window: int = 1) -> Optional[int]:
    """The time step the code matches (within ±window steps), or None. A step at or before last_counter is refused."""
    code = "".join(c for c in (code or "") if c.isdigit())
    if len(code) != DIGITS:
        return None
    t = int((now if now is not None else time.time()) // STEP)
    for c in range(t - window, t + window + 1):
        if hmac.compare_digest(code_at(secret, c), code):
            if last_counter is not None and c <= last_counter:
                return None
            return c
    return None


def otpauth_uri(secret: str, account: str) -> str:
    label = quote(f"{ISSUER}:{account}")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(ISSUER)}&algorithm=SHA1&digits={DIGITS}&period={STEP}"


def qr_svg(text: str) -> Optional[str]:
    """An SVG QR code of the text (the `qrcode` package); None when it is not installed (the key is shown instead)."""
    try:
        import io

        import qrcode
        import qrcode.image.svg
    except ImportError:
        return None
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode()


def recovery_codes(n: int = 10) -> list[str]:
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return ["-".join("".join(secrets.choice(alphabet) for _ in range(5)) for _ in range(2)) for _ in range(n)]


def hash_recovery(code: str) -> str:
    return hashlib.sha256(code.strip().lower().replace(" ", "").encode()).hexdigest()
