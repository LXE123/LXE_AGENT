"""Feishu tenant_access_token manager with auto-refresh."""
from __future__ import annotations

import asyncio
import time

from shared.infra.net import HttpSessionPurpose, get_aiohttp_session
from shared.logging import logger

from .config import FEISHU_API_HOST, FEISHU_APP_ID, FEISHU_APP_SECRET


class FeishuTokenManager:
    def __init__(self) -> None:
        self._token: str = ""
        self._expires_at: float = 0.0
        self._lock = asyncio.Lock()

    async def get_token(self) -> str:
        if time.time() < self._expires_at - 300:
            return self._token

        async with self._lock:
            if time.time() < self._expires_at - 300:
                return self._token

            session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
            response = await session.post(
                f"{FEISHU_API_HOST}/auth/v3/tenant_access_token/internal",
                json={"app_id": FEISHU_APP_ID, "app_secret": FEISHU_APP_SECRET},
            )
            data = await response.json()
            code = data.get("code", -1)
            if code != 0:
                raise RuntimeError(f"Feishu token error: code={code} msg={data.get('msg')}")

            self._token = str(data.get("tenant_access_token") or "").strip()
            self._expires_at = time.time() + int(data.get("expire", 7200) or 7200)
            logger.info("[Feishu] tenant_access_token refreshed, expires_in=%ss", data.get("expire"))
            return self._token


token_manager = FeishuTokenManager()
