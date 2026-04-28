# robot_coze/dingding/apis/card.py
from typing import Optional, Dict, Any
from shared.logging import logger

from shared.dingtalk.card.runtime.card_builder import CardBuilder
from shared.dingtalk.credentials import bot_name_from_data, normalize_bot_name
from shared.dingtalk.core.transport import send_api_request


async def _send_card_payload(
    payload: Dict[str, Any],
    *,
    method: str,
    endpoint: str,
    log_prefix: str,
    bot_name: str,
) -> None:
    resp = await send_api_request(
        method=method,
        endpoint=endpoint,
        payload=payload,
        log_prefix=log_prefix,
        bot_name=bot_name,
    )
    if resp is None and payload.get("privateData"):
        logger.warning(f"{log_prefix} 失败，去掉 privateData 后重试")
        payload_retry = dict(payload)
        payload_retry.pop("privateData", None)
        await send_api_request(
            method=method,
            endpoint=endpoint,
            payload=payload_retry,
            log_prefix=f"{log_prefix}(降级重试)",
            bot_name=bot_name,
        )


async def send_general_card(
    *,
    raw_data: Dict[str, Any],
    card_params: Dict[str, Any],
    out_track_id: Optional[str] = None,
    card_template_id: Optional[str] = None,
    bot_name: Optional[str] = None,
) -> None:
    resolved_bot_name = bot_name_from_data(raw_data, default=normalize_bot_name(bot_name))
    payload = CardBuilder.create_general_card_send_payload(
        raw_data=raw_data,
        card_params=card_params,
        out_track_id=out_track_id,
        card_template_id=card_template_id,
    )
    logger.info(
        f"📤 发送卡片 [Tpl: {payload['cardTemplateId']}] (ID: {payload['outTrackId']})"
    )
    if payload.get("privateData"):
        logger.info(
            f"[CardDebug] create payload with privateData users={list(payload['privateData'].keys())}"
        )
    await _send_card_payload(
        payload,
        method="POST",
        endpoint="https://api.dingtalk.com/v1.0/card/instances/createAndDeliver",
        log_prefix="📤 发送卡片",
        bot_name=resolved_bot_name,
    )


async def update_general_card(
    *,
    out_track_id: str,
    card_params: Dict[str, Any],
    bot_name: str = "workflow",
) -> None:
    payload = CardBuilder.create_general_card_update_payload(
        out_track_id=out_track_id,
        card_params=card_params,
    )
    await _send_card_payload(
        payload,
        method="PUT",
        endpoint="https://api.dingtalk.com/v1.0/card/instances",
        log_prefix=f"🔄 更新通用卡片({out_track_id})",
        bot_name=normalize_bot_name(bot_name),
    )
