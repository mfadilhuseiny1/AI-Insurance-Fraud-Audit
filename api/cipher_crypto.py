"""Cipher's cryptography (no platform imports: also used by transforms in the code runner, bellaso_python_lib).

Algorithms of a Cipher Channel:
  AES_GCM_SIV  probabilistic encryption (a random 12-byte nonce per value): the same input gives different outputs
  AES_SIV      deterministic encryption (AES-256-SIV, 64-byte key): joins and group-bys on encrypted values work
  SHA256 / SHA512  hashing with a pepper (HMAC): deterministic, cannot be reversed
  VISUAL       image scrambling (code_media.py: AES-CTR over the pixels of polygons), keyed by the channel's seed

Encrypted values use Cipher's format: CIPHER::<channel rid>::<base64url ciphertext>::CIPHER (the channel rid is also
the associated data, so a value cannot be passed off as another channel's).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
from typing import Callable, Optional

ALGORITHMS = ("AES_GCM_SIV", "AES_SIV", "SHA256", "SHA512", "VISUAL")
ENCRYPTION = ("AES_GCM_SIV", "AES_SIV")
HASHING = ("SHA256", "SHA512")
KEY_BYTES = {"AES_GCM_SIV": 32, "AES_SIV": 64, "VISUAL": 32}
CHANNEL_RID = "ri.bellaso.main.cipher-channel."
VALUE = re.compile(r"^CIPHER::(ri\.bellaso\.main\.cipher-channel\.[A-Za-z0-9-]+)::([A-Za-z0-9_\-=]+)::CIPHER$")


def derive_key(algorithm: str, secret: str, channel_id: str) -> bytes:
    """Stretching key derivation (scrypt) of a secret: the key of an encryption or visual channel."""
    return hashlib.scrypt(secret.encode(), salt=f"bluesandai-cipher:{channel_id}".encode(), n=2**14, r=8, p=1, dklen=KEY_BYTES[algorithm])


def single_key(algorithm: str, b64: str) -> bytes:
    """A key given as base64 (AES_SIV: 64 bytes, AES_GCM_SIV: 32 bytes)."""
    try:
        key = base64.b64decode(b64.strip(), validate=True)
    except ValueError:
        raise ValueError("the key is not base64") from None
    if len(key) != KEY_BYTES[algorithm]:
        raise ValueError(f"an {algorithm} key is {KEY_BYTES[algorithm]} bytes ({KEY_BYTES[algorithm] * 4 // 3 + 2}-character base64); this one is {len(key)} bytes")
    return key


def generate_secret(algorithm: str) -> str:
    if algorithm == "VISUAL":
        return str(int.from_bytes(os.urandom(16), "big"))
    return base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")


def visual_key(seed: str) -> bytes:
    return hashlib.sha256(f"bluesandai-visual:{seed}".encode()).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def is_encrypted(value: object) -> bool:
    return isinstance(value, str) and bool(VALUE.match(value))


def channel_of(value: str) -> Optional[str]:
    m = VALUE.match(value or "")
    return m.group(1) if m else None


def encrypt(algorithm: str, key: bytes, channel_rid: str, plaintext: Optional[str]) -> Optional[str]:
    if plaintext is None:
        return None
    from cryptography.hazmat.primitives.ciphers.aead import AESGCMSIV, AESSIV

    data = str(plaintext).encode()
    ad = channel_rid.encode()
    if algorithm == "AES_SIV":
        ct = AESSIV(key).encrypt(data, [ad])
    elif algorithm == "AES_GCM_SIV":
        nonce = os.urandom(12)
        ct = nonce + AESGCMSIV(key).encrypt(nonce, data, ad)
    else:
        raise ValueError(f"{algorithm} channels do not encrypt")
    return f"CIPHER::{channel_rid}::{_b64(ct)}::CIPHER"


def decrypt(algorithm: str, key: bytes, channel_rid: str, value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCMSIV, AESSIV

    m = VALUE.match(str(value))
    if not m:
        raise ValueError("not a Cipher-encrypted value (CIPHER::<channel>::<value>::CIPHER)")
    if m.group(1) != channel_rid:
        raise ValueError("the value was encrypted with another Cipher Channel")
    ct = _unb64(m.group(2))
    ad = channel_rid.encode()
    try:
        if algorithm == "AES_SIV":
            return AESSIV(key).decrypt(ct, [ad]).decode()
        if algorithm == "AES_GCM_SIV":
            return AESGCMSIV(key).decrypt(ct[:12], ct[12:], ad).decode()
    except InvalidTag:
        raise ValueError("the value does not decrypt with this channel's key (it was altered, or the key changed)") from None
    raise ValueError(f"{algorithm} channels do not decrypt")


def hash_value(algorithm: str, pepper: bytes, plaintext: Optional[str]) -> Optional[str]:
    if plaintext is None:
        return None
    digest = hashlib.sha256 if algorithm == "SHA256" else hashlib.sha512
    return hmac.new(pepper, str(plaintext).encode(), digest).hexdigest()


def all_matches(text: Optional[str], regex: str, fn: Callable[[str], Optional[str]]) -> Optional[str]:
    """Replace every match of a regex in a text by fn(match) (encrypt_all_matches / hash_all_matches)."""
    if text is None:
        return None
    return re.sub(regex, lambda m: fn(m.group(0)) or "", str(text))


class Operator:
    """encrypt / decrypt / hash for one channel, given its key material ({algorithm, channel_rid, key | pepper})."""

    def __init__(self, material: dict) -> None:
        self.algorithm = material["algorithm"]
        self.channel_rid = material["channel_rid"]
        self.key = base64.b64decode(material["key"])

    def encrypt(self, v: Optional[str]) -> Optional[str]:
        if self.algorithm in HASHING:
            return hash_value(self.algorithm, self.key, v)
        return encrypt(self.algorithm, self.key, self.channel_rid, v)

    def decrypt(self, v: Optional[str]) -> Optional[str]:
        return decrypt(self.algorithm, self.key, self.channel_rid, v)

    def hash(self, v: Optional[str]) -> Optional[str]:
        if self.algorithm not in HASHING:
            raise ValueError(f"{self.algorithm} is not a hashing channel")
        return hash_value(self.algorithm, self.key, v)
