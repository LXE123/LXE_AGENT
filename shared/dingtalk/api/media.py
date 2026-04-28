import os
import json
import aiohttp
from typing import Optional
from shared.config import config
from shared.dingtalk.credentials import normalize_bot_name, robot_code_for_bot
from shared.dingtalk.core.auth import TokenManager
from shared.dingtalk.core.transport import send_api_request
from shared.infra.net import dingtalk_http_session
from shared.logging import logger


_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp"}


def is_image_file(file_path: str) -> bool:
    suffix = os.path.splitext(str(file_path or "").strip())[1].lower()
    return suffix in _IMAGE_EXTENSIONS


def _dingtalk_file_type(file_path: str) -> str:
    suffix = os.path.splitext(str(file_path or "").strip())[1].lower().lstrip(".")
    if suffix:
        return suffix
    return "file"


async def upload_media(file_path: str, *, bot_name: str = "workflow") -> Optional[str]:
    """
    [异步] 上传媒体文件到钉?
    """
    if not os.path.exists(file_path):
        logger.error(f"?文件不存? {file_path}")
        return None

    safe_bot = normalize_bot_name(bot_name)
    token = await TokenManager.get_token(bot_name=safe_bot) # 🟢 await
    media_type = "image" if is_image_file(file_path) else "file"
    url = f"https://oapi.dingtalk.com/media/upload?access_token={token}"
    
    try:
        # 在请求生命周期内持有文件句柄，结束后立即关闭，避免长期运行时句柄累积?
        with open(file_path, "rb") as media_file:
            data = aiohttp.FormData()
            data.add_field("media", media_file, filename=os.path.basename(file_path))
            data.add_field("type", media_type)

            async with dingtalk_http_session.post(url, data=data) as resp:
                if resp.status == 200:
                    res_json = await resp.json()
                    if res_json.get("errcode") == 0:
                        return res_json.get("media_id")
                    else:
                        logger.error(f"上传失败: {res_json}")
                else:
                    logger.error(f"上传 HTTP 异常: {resp.status}")
    except Exception as e:
        logger.error(f"上传异常: {e}")
    
    return None

async def send_group_file_message(
    conversation_id: str,
    media_id: str,
    file_path: str,
    *,
    bot_name: str = "workflow",
):
    """[异步] 发群文件"""
    file_name = os.path.basename(file_path)
    msg_param = {"mediaId": media_id, "fileName": file_name, "fileType": _dingtalk_file_type(file_path)}

    payload = {
        "msgParam": json.dumps(msg_param),
        "msgKey": "sampleFile",
        "openConversationId": str(conversation_id),
        "robotCode": robot_code_for_bot(bot_name),
    }

    # 🟢 await
    await send_api_request(
        "POST",
        "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
        payload,
        log_prefix="📎 发群文件",
        bot_name=normalize_bot_name(bot_name),
    )

async def send_p2p_file_message(
    user_id: str,
    media_id: str,
    file_path: str,
    *,
    bot_name: str = "workflow",
):
    """[异步] 发单聊文件"""
    file_name = os.path.basename(file_path)
    msg_param = {"mediaId": media_id, "fileName": file_name, "fileType": _dingtalk_file_type(file_path)}

    payload = {
        "robotCode": robot_code_for_bot(bot_name),
        "userIds": [str(user_id)],
        "msgKey": "sampleFile",
        "msgParam": json.dumps(msg_param)
    }

    # 🟢 await
    await send_api_request(
        "POST",
        "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
        payload,
        log_prefix=f"📎 发单聊文件({user_id})",
        bot_name=normalize_bot_name(bot_name),
    )


async def send_group_image_message(
    conversation_id: str,
    media_id: str,
    *,
    bot_name: str = "workflow",
):
    """[异步] 发群图片"""
    payload = {
        "msgParam": json.dumps({"photoURL": str(media_id)}),
        "msgKey": "sampleImageMsg",
        "openConversationId": str(conversation_id),
        "robotCode": robot_code_for_bot(bot_name),
    }
    await send_api_request(
        "POST",
        "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
        payload,
        log_prefix="🖼️ 发群图片",
        bot_name=normalize_bot_name(bot_name),
    )


async def send_p2p_image_message(
    user_id: str,
    media_id: str,
    *,
    bot_name: str = "workflow",
):
    """[异步] 发单聊图片"""
    payload = {
        "robotCode": robot_code_for_bot(bot_name),
        "userIds": [str(user_id)],
        "msgKey": "sampleImageMsg",
        "msgParam": json.dumps({"photoURL": str(media_id)}),
    }
    await send_api_request(
        "POST",
        "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
        payload,
        log_prefix=f"🖼️ 发单聊图片({user_id})",
        bot_name=normalize_bot_name(bot_name),
    )
