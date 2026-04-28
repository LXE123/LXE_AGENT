from __future__ import annotations

import websockets


_DEFAULT_CONNECT_KWARGS = {
    "proxy": None,
    "ping_interval": 60,
    "ping_timeout": None,
    "open_timeout": 30,
    "close_timeout": 10,
}


def websocket_connect_defaults() -> dict[str, object]:
    return dict(_DEFAULT_CONNECT_KWARGS)


def connect_websocket(uri: str, **kwargs):
    options = websocket_connect_defaults()
    options.update(kwargs)
    return websockets.connect(uri, **options)


__all__ = ["connect_websocket", "websocket_connect_defaults"]
