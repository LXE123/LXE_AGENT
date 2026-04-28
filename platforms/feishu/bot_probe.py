from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from shared.infra.net import HttpSessionPurpose, get_aiohttp_session

from .auth import token_manager
from .config import FEISHU_API_HOST, FEISHU_APP_ID


_BOT_PING_PATH = "/bot/v1/openclaw_bot/ping"


@dataclass(slots=True)
class FeishuBotProbeResult:
    ok: bool
    app_id: str = ""
    bot_name: str = ""
    bot_open_id: str = ""
    error: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


async def probe_feishu_bot_identity() -> FeishuBotProbeResult:
    app_id = str(FEISHU_APP_ID or "").strip()
    if not app_id:
        return FeishuBotProbeResult(
            ok=False,
            error="missing credentials (appId, appSecret)",
            app_id=app_id,
        )

    try:
        token = await token_manager.get_token()
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        response = await session.post(
            f"{FEISHU_API_HOST}{_BOT_PING_PATH}",
            json={"needBotInfo": True},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
        )
        payload = dict(await response.json(content_type=None) or {})
    except Exception as error:
        return FeishuBotProbeResult(ok=False, app_id=app_id, error=str(error))

    raw_code = payload.get("code", -1)
    code = int(-1 if raw_code is None else raw_code)
    if code != 0:
        message = str(payload.get("msg") or payload.get("message") or f"code={code}").strip()
        return FeishuBotProbeResult(
            ok=False,
            app_id=app_id,
            error=message or f"code={code}",
            raw=payload,
        )

    ping_info = dict((payload.get("data") or {}).get("pingBotInfo") or {})
    bot_open_id = str(ping_info.get("botID") or "").strip()
    bot_name = str(ping_info.get("botName") or "").strip()
    if not bot_open_id:
        return FeishuBotProbeResult(
            ok=False,
            app_id=app_id,
            error="missing botID in pingBotInfo",
            raw=payload,
        )

    return FeishuBotProbeResult(
        ok=True,
        app_id=app_id,
        bot_name=bot_name,
        bot_open_id=bot_open_id,
        raw=payload,
    )


__all__ = ["FeishuBotProbeResult", "probe_feishu_bot_identity"]
