from __future__ import annotations

import asyncio
from typing import Any

from shared.platform.adapter import ChannelAdapter
from shared.logging import logger


class ChannelRegistry:
    def __init__(self) -> None:
        self._adapters: dict[str, ChannelAdapter] = {}

    @staticmethod
    def _adapter_key(adapter: ChannelAdapter) -> str:
        return str(adapter.platform or "").strip()

    def register(self, adapter: ChannelAdapter) -> None:
        key = self._adapter_key(adapter)
        if key in self._adapters:
            raise RuntimeError(f"duplicate channel adapter: {key}")
        self._adapters[key] = adapter

    def list(self) -> list[ChannelAdapter]:
        return list(self._adapters.values())

    def adapter_keys(self) -> list[str]:
        return list(self._adapters.keys())

    def get(self, platform: str) -> ChannelAdapter:
        key = str(platform or "").strip()
        try:
            return self._adapters[key]
        except KeyError as error:
            raise RuntimeError(f"unknown channel adapter: {key}") from error

    async def start_all(self) -> None:
        for adapter in self.list():
            await adapter.start()

    async def stop_all(self, *, timeout_s: float = 5.0) -> None:
        for adapter in reversed(self.list()):
            try:
                await asyncio.wait_for(adapter.stop(), timeout=max(0.1, float(timeout_s)))
            except asyncio.TimeoutError:
                logger.warning(
                    "[ChannelRegistry] adapter stop timed out: platform=%s timeout=%.1fs",
                    getattr(adapter, "platform", ""),
                    float(timeout_s),
                )
            except BaseException as exc:
                logger.warning(
                    "[ChannelRegistry] adapter stop failed: platform=%s error=%s",
                    getattr(adapter, "platform", ""),
                    exc,
                )
                continue

    async def health_snapshot(self) -> dict[str, dict[str, Any]]:
        snapshot: dict[str, dict[str, Any]] = {}
        for adapter in self.list():
            key = self._adapter_key(adapter)
            health = adapter.health()
            snapshot[key] = dict(health or {})
        return snapshot
