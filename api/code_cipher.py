"""bellaso-python-lib for Python transforms (Cipher, Admin licenses): EncrypterInput, DecrypterInput and HasherInput.

    from bellaso_python_lib.encryption.encrypter_input import EncrypterInput
    @transform(encrypter=EncrypterInput("/path/to/cipher/license"), ...)
    def compute(input_dataset, output, encrypter):
        df = input_dataset.dataframe().withColumn("name", encrypter.dataframe().encrypt_column(col("name")))

A license input is a transform parameter (code_pyapi.Param) whose value is a TransformsEncrypter / Decrypter /
Hasher: it asks the API for the channel's key material once (POST /api/cipher/material, with the build's job token,
as the user who started the build — the license must be an Admin license they can view) and runs cipher_crypto
locally. Column methods take a PySpark Column (a UDF), a pandas Series or a polars Expr; the string methods take
one value. encrypt_all_matches_* / hash_all_matches_* replace each regex match. obfuscate_image /
deobfuscate_image scramble polygons of a PNG (visual obfuscation channels, code_media.py). The deprecated names
(encrypt, decrypt, hash, encrypt_all_matches, hash_all_matches, encrypt_image, decrypt_image) still work.
"""

from __future__ import annotations

import json
import os
import sys
import types
import urllib.error
import urllib.request
from typing import Any, Optional

import cipher_crypto as cc


def _material(license_ref: str, operation: str) -> dict:
    url = os.environ.get("BLUESANDAI_API_URL", "http://127.0.0.1:8000").rstrip("/")
    req = urllib.request.Request(f"{url}/api/cipher/material", data=json.dumps({"license": str(license_ref), "operation": operation}).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('BLUESANDAI_API_TOKEN', '')}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail")
        except ValueError:
            detail = e.reason
        raise PermissionError(f"Cipher license {license_ref}: {detail}") from None


def _apply(fn, column: Any) -> Any:
    """fn over a PySpark Column (UDF), a pandas Series or a polars Expr / Series."""
    mod = type(column).__module__
    if mod.startswith("pyspark"):
        from pyspark.sql import functions as F
        from pyspark.sql.types import StringType

        return F.udf(lambda v: fn(None if v is None else str(v)), StringType())(column)
    if mod.startswith("polars"):
        import polars as pl

        return column.map_elements(lambda v: fn(None if v is None else str(v)), return_dtype=pl.Utf8)
    if hasattr(column, "map"):
        return column.map(lambda v: fn(None if v is None or (isinstance(v, float) and v != v) else str(v)))
    raise TypeError(f"Cipher column methods take a PySpark Column, a pandas Series or a polars expression, not {type(column).__name__}")


class _Operator:
    operation = "encrypt"

    def __init__(self, license_ref: str) -> None:
        self.license = license_ref
        self._op: Optional[cc.Operator] = None

    def _get(self) -> cc.Operator:
        if self._op is None:
            self._op = cc.Operator(_material(self.license, self.operation))
        return self._op

    def dataframe(self) -> "_Operator":
        return self

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.license!r})"


class TransformsEncrypter(_Operator):
    operation = "encrypt"

    def encrypt_string(self, plaintext: Optional[str]) -> Optional[str]:
        return self._get().encrypt(plaintext)

    def encrypt_all_matches_string(self, plaintext: Optional[str], regex: str) -> Optional[str]:
        return cc.all_matches(plaintext, regex, self._get().encrypt)

    def encrypt_column(self, column: Any) -> Any:
        op = self._get()
        return _apply(op.encrypt, column)

    def encrypt_all_matches_column(self, column: Any, regex: str) -> Any:
        op = self._get()
        return _apply(lambda v: cc.all_matches(v, regex, op.encrypt), column)

    def obfuscate_image(self, image: bytes, polygons: list, ctx: Any = None) -> bytes:
        import code_media

        return code_media._cipher_image("encrypt", image, polygons, self.license)

    # deprecated names
    encrypt = encrypt_column
    encrypt_all_matches = encrypt_all_matches_column
    encrypt_image = obfuscate_image


class TransformsDecrypter(_Operator):
    operation = "decrypt"

    def decrypt_string(self, ciphertext: Optional[str]) -> Optional[str]:
        return self._get().decrypt(ciphertext)

    def decrypt_column(self, column: Any) -> Any:
        op = self._get()
        return _apply(op.decrypt, column)

    def deobfuscate_image(self, image: bytes, polygons: list, ctx: Any = None) -> bytes:
        import code_media

        return code_media._cipher_image("decrypt", image, polygons, self.license)

    decrypt = decrypt_column
    decrypt_image = deobfuscate_image


class TransformsHasher(_Operator):
    operation = "encrypt"

    def hash_string(self, plaintext: Optional[str]) -> Optional[str]:
        return self._get().hash(plaintext)

    def hash_all_matches_string(self, plaintext: Optional[str], regex: str) -> Optional[str]:
        return cc.all_matches(plaintext, regex, self._get().hash)

    def hash_column(self, column: Any) -> Any:
        op = self._get()
        return _apply(op.hash, column)

    def hash_all_matches_column(self, column: Any, regex: str) -> Any:
        op = self._get()
        return _apply(lambda v: cc.all_matches(v, regex, op.hash), column)

    hash = hash_column
    hash_all_matches = hash_all_matches_column


def _input_class(name: str, maker: type) -> type:
    import code_pyapi

    class _LicenseInput(code_pyapi.Param):
        type = "cipher-license"

        def __init__(self, license_ref: str, **_: Any) -> None:
            super().__init__(license_ref)

        def make_value(self, raw: Any) -> Any:
            return maker(raw if raw is not None else self.default)

    _LicenseInput.__name__ = _LicenseInput.__qualname__ = name
    return _LicenseInput


def install() -> None:
    EncrypterInput = _input_class("EncrypterInput", TransformsEncrypter)
    DecrypterInput = _input_class("DecrypterInput", TransformsDecrypter)
    HasherInput = _input_class("HasherInput", TransformsHasher)
    import code_media

    mods: dict[str, types.ModuleType] = {}
    for name in ("bellaso_python_lib", "bellaso_python_lib.encryption", "bellaso_python_lib.decryption", "bellaso_python_lib.encryption.encrypter_input",
                 "bellaso_python_lib.encryption.hasher_input", "bellaso_python_lib.decryption.decrypter_input", "bellaso_python_lib.types"):
        m = types.ModuleType(name)
        if name.count(".") < 2 and name != "bellaso_python_lib.types":
            m.__path__ = []  # type: ignore[attr-defined]
        mods[name] = m
    mods["bellaso_python_lib.encryption.encrypter_input"].EncrypterInput = EncrypterInput  # type: ignore[attr-defined]
    mods["bellaso_python_lib.encryption.encrypter_input"].TransformsEncrypter = TransformsEncrypter  # type: ignore[attr-defined]
    mods["bellaso_python_lib.encryption.hasher_input"].HasherInput = HasherInput  # type: ignore[attr-defined]
    mods["bellaso_python_lib.encryption.hasher_input"].TransformsHasher = TransformsHasher  # type: ignore[attr-defined]
    mods["bellaso_python_lib.decryption.decrypter_input"].DecrypterInput = DecrypterInput  # type: ignore[attr-defined]
    mods["bellaso_python_lib.decryption.decrypter_input"].TransformsDecrypter = TransformsDecrypter  # type: ignore[attr-defined]
    mods["bellaso_python_lib.types"].Coordinate = code_media.Coordinate  # type: ignore[attr-defined]
    mods["bellaso_python_lib"].encryption = mods["bellaso_python_lib.encryption"]  # type: ignore[attr-defined]
    mods["bellaso_python_lib"].decryption = mods["bellaso_python_lib.decryption"]  # type: ignore[attr-defined]
    mods["bellaso_python_lib"].types = mods["bellaso_python_lib.types"]  # type: ignore[attr-defined]
    mods["bellaso_python_lib.encryption"].encrypter_input = mods["bellaso_python_lib.encryption.encrypter_input"]  # type: ignore[attr-defined]
    mods["bellaso_python_lib.encryption"].hasher_input = mods["bellaso_python_lib.encryption.hasher_input"]  # type: ignore[attr-defined]
    mods["bellaso_python_lib.decryption"].decrypter_input = mods["bellaso_python_lib.decryption.decrypter_input"]  # type: ignore[attr-defined]
    sys.modules.update(mods)
