"""Public FBA pricing database interface for candidate and rule reads."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial

from shared.db.postgresql.fba_pricing_state import client as _sync_client

_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="fba_pricing_db")


async def ensure_schema(include_indexes: bool = True) -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        _EXECUTOR,
        partial(_sync_client.ensure_schema, include_indexes),
    )


async def load_candidates(transport_mode: str):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _EXECUTOR,
        partial(_sync_client.load_candidates, transport_mode),
    )


async def load_surcharge_rules(channel_ids):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _EXECUTOR,
        partial(_sync_client.load_surcharge_rules, channel_ids),
    )


def dispose() -> None:
    try:
        _sync_client.dispose()
    finally:
        _EXECUTOR.shutdown(wait=False, cancel_futures=True)


# Pricing workflow reads should stay behind this small surface.
__all__ = ["dispose", "ensure_schema", "load_candidates", "load_surcharge_rules"]
