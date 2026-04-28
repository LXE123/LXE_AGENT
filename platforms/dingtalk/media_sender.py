from __future__ import annotations

import os
from uuid import uuid4

import shared.dingtalk.api as dingtalk_api
from shared.dingtalk.credentials import normalize_bot_name
from shared.logging import logger
from shared.platform.markdown_card import build_markdown_card


class DingTalkMediaSender:
    async def send_file(self, ctx, path: str) -> bool:
        file_path = str(path or "").strip()
        if not file_path or not os.path.exists(file_path):
            return False

        bot_name = normalize_bot_name(ctx.connector_key or dict(ctx.extra_data or {}).get("bot_name"))
        try:
            media_id = await dingtalk_api.upload_media(file_path, bot_name=bot_name)
            if not media_id:
                return False

            is_group = str(ctx.conversation_type or "") == "2"
            if dingtalk_api.is_image_file(file_path):
                if is_group:
                    await dingtalk_api.send_group_image_message(ctx.conversation_id, media_id, bot_name=bot_name)
                else:
                    await dingtalk_api.send_p2p_image_message(ctx.owner_user_id, media_id, bot_name=bot_name)
            else:
                if is_group:
                    await dingtalk_api.send_group_file_message(ctx.conversation_id, media_id, file_path, bot_name=bot_name)
                else:
                    await dingtalk_api.send_p2p_file_message(ctx.owner_user_id, media_id, file_path, bot_name=bot_name)
            return True
        except Exception as error:
            logger.error("[DingTalkMedia] send_file failed: %s", error, exc_info=True)
            return False

    async def send_markdown_card(self, ctx, markdown: str, *, title: str = "") -> bool:
        safe_markdown = str(markdown or "").strip()
        if not safe_markdown:
            return False

        raw_data = {
            "conversationId": str(ctx.conversation_id or "").strip(),
            "conversationType": str(ctx.conversation_type or "").strip(),
            "senderStaffId": str(ctx.owner_user_id or "").strip(),
            "senderId": str(ctx.owner_user_id or "").strip(),
            "userId": str(ctx.owner_user_id or "").strip(),
            "_bot_name": normalize_bot_name(ctx.connector_key or dict(ctx.extra_data or {}).get("bot_name")),
            "robotCode": str(dict(ctx.extra_data or {}).get("robot_code") or "").strip(),
        }
        try:
            await dingtalk_api.send_general_card(
                raw_data=raw_data,
                out_track_id=uuid4().hex,
                card_params=build_markdown_card(safe_markdown, title=str(title or "").strip()),
            )
            return True
        except Exception as error:
            logger.error("[DingTalkMedia] send_markdown_card failed: %s", error, exc_info=True)
            return False
