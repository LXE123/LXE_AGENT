import asyncio
import time

from shared.config import config
from shared.dingtalk.credentials import credentials_for_bot, normalize_bot_name
from shared.infra.net import dingtalk_http_session
from shared.logging import logger


class TokenManager:
    """Manage DingTalk access-token lifecycle."""

    _tokens: dict[str, str] = {}
    _expire_times: dict[str, float] = {}
    _locks: dict[str, asyncio.Lock] = {}
    _guard = asyncio.Lock()

    @classmethod
    async def _lock_for(cls, bot_name: str) -> asyncio.Lock:
        async with cls._guard:
            lock = cls._locks.get(bot_name)
            if lock is None:
                lock = asyncio.Lock()
                cls._locks[bot_name] = lock
            return lock

    @classmethod
    async def get_token(cls, bot_name: str = "workflow"):
        safe_bot = normalize_bot_name(bot_name)
        cached_token = cls._tokens.get(safe_bot)
        cached_expire_time = float(cls._expire_times.get(safe_bot, 0.0) or 0.0)
        if cached_token and time.time() < cached_expire_time:
            return cached_token

        lock = await cls._lock_for(safe_bot)
        async with lock:
            cached_token = cls._tokens.get(safe_bot)
            cached_expire_time = float(cls._expire_times.get(safe_bot, 0.0) or 0.0)
            if cached_token and time.time() < cached_expire_time:
                return cached_token

            app_key, app_secret = credentials_for_bot(safe_bot)
            if not app_key or not app_secret:
                logger.error("获取 Token 异常: missing credentials for bot=%s", safe_bot)
                return None

            try:
                async with dingtalk_http_session.post(
                    "https://api.dingtalk.com/v1.0/oauth2/accessToken",
                    json={
                        "appKey": app_key,
                        "appSecret": app_secret,
                    },
                ) as response:
                    if response.status != 200:
                        logger.error("Token 刷新失败 Status: %s bot=%s", response.status, safe_bot)
                        return None

                    data = await response.json()
                    cls._tokens[safe_bot] = data.get("accessToken")
                    cls._expire_times[safe_bot] = time.time() + int(data.get("expireIn", 7200)) - 200
                    return cls._tokens[safe_bot]
            except Exception as error:
                logger.error("获取 Token 异常: %s bot=%s", error, safe_bot)
                return None
