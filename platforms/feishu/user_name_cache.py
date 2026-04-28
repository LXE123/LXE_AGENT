from __future__ import annotations

import time


_DEFAULT_MAX_SIZE = 500
_DEFAULT_TTL_SECONDS = 30 * 60


class UserNameCache:
    def __init__(self, *, max_size: int = _DEFAULT_MAX_SIZE, ttl_seconds: int = _DEFAULT_TTL_SECONDS) -> None:
        self._max_size = int(max_size)
        self._ttl_seconds = int(ttl_seconds)
        self._entries: dict[str, tuple[str, float]] = {}
        self._order: list[str] = []

    def has(self, open_id: str) -> bool:
        return self.get(open_id) is not None

    def get(self, open_id: str) -> str | None:
        key = str(open_id or "").strip()
        if not key:
            return None
        entry = self._entries.get(key)
        if entry is None:
            return None
        name, expire_at = entry
        if expire_at <= time.time():
            self._entries.pop(key, None)
            self._remove_from_order(key)
            return None
        self._touch(key)
        return name

    def set(self, open_id: str, name: str) -> None:
        key = str(open_id or "").strip()
        if not key:
            return
        self._entries[key] = (str(name or "").strip(), time.time() + self._ttl_seconds)
        self._touch(key)
        self._evict()

    def set_many(self, entries: dict[str, str]) -> None:
        for open_id, name in dict(entries or {}).items():
            self.set(open_id, name)

    def filter_missing(self, open_ids: list[str]) -> list[str]:
        return [open_id for open_id in list(open_ids or []) if self.get(open_id) is None]

    def clear(self) -> None:
        self._entries.clear()
        self._order.clear()

    def _touch(self, key: str) -> None:
        self._remove_from_order(key)
        self._order.append(key)

    def _remove_from_order(self, key: str) -> None:
        try:
            self._order.remove(key)
        except ValueError:
            return

    def _evict(self) -> None:
        while len(self._order) > self._max_size:
            oldest = self._order.pop(0)
            self._entries.pop(oldest, None)


_REGISTRY: dict[str, UserNameCache] = {}


def get_user_name_cache(scope: str = "default") -> UserNameCache:
    key = str(scope or "default").strip() or "default"
    cache = _REGISTRY.get(key)
    if cache is None:
        cache = UserNameCache()
        _REGISTRY[key] = cache
    return cache


__all__ = ["UserNameCache", "get_user_name_cache"]
