"""Encryption for credentials kept in PostgreSQL (database connection passwords, tokens, keys).

Values are sealed with Fernet (AES-128-CBC + HMAC-SHA256). The key comes from
BLUESANDAI_SECRET_KEY (a Fernet key: `python -c "from cryptography.fernet import Fernet;
print(Fernet.generate_key().decode())"`), else from secrets/connections.key, which is created on
first use. Losing the key makes saved credentials unreadable: connections then ask for them again.

Nothing here logs or returns secret values.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Callable, Optional

from cryptography.fernet import Fernet, InvalidToken

KEY_FILE = Path(__file__).resolve().parent.parent / "secrets" / "connections.key"

_env: Callable[[str], str] = lambda key: os.environ.get(key, "")
_fernet: Optional[Fernet] = None
_lock = threading.Lock()


def configure(env: Callable[[str], str]) -> None:
    global _env, _fernet
    _env = env
    _fernet = None


def _box() -> Fernet:
    global _fernet
    with _lock:
        if _fernet is None:
            key = _env("BLUESANDAI_SECRET_KEY").strip()
            if not key:
                if not KEY_FILE.is_file():
                    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
                    KEY_FILE.write_bytes(Fernet.generate_key())
                    try:
                        os.chmod(KEY_FILE, 0o600)
                    except OSError:
                        pass
                key = KEY_FILE.read_text().strip()
            _fernet = Fernet(key.encode())
        return _fernet


def seal(values: dict[str, str]) -> bytes:
    """Encrypt a dict of secret values."""
    return _box().encrypt(json.dumps(values).encode())


def unseal(token: Optional[bytes]) -> dict[str, str]:
    """Decrypt what `seal` produced; empty when there is nothing or the key changed."""
    if not token:
        return {}
    try:
        return json.loads(_box().decrypt(bytes(token)))
    except (InvalidToken, ValueError):
        return {}
