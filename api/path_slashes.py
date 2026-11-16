"""Primary keys with a slash in a URL path segment (OSM ids such as way/1047782367).

A client sends such a key URL-encoded (way%2F1047782367), but Starlette routes on the decoded path, where the key
becomes two segments and `/object-views/{type_id}/{pk}` (and every other `{pk}` route) answers 404. The middleware
routes on the path with each encoded slash kept as a placeholder character (U+2215 DIVISION SLASH), and the string
path-parameter convertor turns the placeholder back into "/", so the endpoints receive the real key while routes with
a suffix (…/{pk}/comments, …/{pk}/links) still match. Nothing else uses U+2215 in a path.
"""

from __future__ import annotations

from urllib.parse import unquote

from starlette import convertors

PLACEHOLDER = "∕"


class EncodedSlashes:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            raw = scope.get("raw_path") or b""
            if b"%2f" in raw.lower():
                path = raw.split(b"?", 1)[0].decode("latin-1")
                path = path.replace("%2F", PLACEHOLDER).replace("%2f", PLACEHOLDER)
                scope = {**scope, "path": unquote(path)}
        await self.app(scope, receive, send)


_convert = convertors.StringConvertor.convert


def _convert_back(self, value: str) -> str:
    return _convert(self, value).replace(PLACEHOLDER, "/")


convertors.StringConvertor.convert = _convert_back  # type: ignore[method-assign]
convertors.PathConvertor.convert = lambda self, value: str(value).replace(PLACEHOLDER, "/")  # type: ignore[method-assign]
