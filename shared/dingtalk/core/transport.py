from .auth import TokenManager
from shared.infra.net import dingtalk_http_session
from shared.logging import logger


async def send_api_request(method, endpoint, payload, log_prefix="请求", bot_name: str = "workflow"):
    """Send a DingTalk API request with the shared access token."""

    token = await TokenManager.get_token(bot_name=bot_name)
    if not token:
        logger.error(f"?{log_prefix} 失败: 获取 Token 失败")
        return None

    try:
        headers = {"x-acs-dingtalk-access-token": token}
        async with dingtalk_http_session.request(
            method,
            endpoint,
            json=payload,
            headers=headers,
        ) as response:
            if response.status not in {200, 202}:
                text = await response.text()
                logger.warning(f"{log_prefix} 异常: {response.status} | {text[:200]}")
                return None

            try:
                return await response.json()
            except Exception:
                return True
    except Exception as error:
        logger.error(f"{log_prefix} 网络或解析失? {error}")
        return None
