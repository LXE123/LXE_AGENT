from __future__ import annotations

import json
from typing import Any

from shared.llm.errors import LLMProviderError

PROVIDER_NAME = "deepseek"
PROVIDER_LABEL = "DeepSeek"


def _status_code(value: int | str | None) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _body_text(body: Any) -> str:
    if body is None:
        return ""
    if isinstance(body, str):
        return body.strip()
    if isinstance(body, bytes | bytearray):
        return body.decode("utf-8", errors="replace").strip()
    if hasattr(body, "model_dump"):
        try:
            body = body.model_dump(mode="json")
        except Exception:
            pass
    try:
        return json.dumps(body, ensure_ascii=False, default=str).strip()
    except Exception:
        return str(body or "").strip()


def _combined_message(*, message: str = "", body: Any = None) -> str:
    parts = [str(message or "").strip(), _body_text(body)]
    seen: set[str] = set()
    result: list[str] = []
    for part in parts:
        if not part or part in seen:
            continue
        seen.add(part)
        result.append(part)
    return " | ".join(result).strip()


def _context_overflow(text: str) -> bool:
    return (
        ("total message size" in text and "exceeds limit" in text)
        or "model token limit" in text
        or "exceeded model token limit" in text
        or "request exceeded" in text and "token limit" in text
        or "maximum context" in text
        or "context length" in text
        or "too many tokens" in text
        or "prompt is too long" in text
        or "input is too long" in text
    )


def _category_from_status(*, status_code: int, text: str) -> tuple[str, str, bool, bool]:
    if _context_overflow(text):
        return (
            "格式错误",
            f"{PROVIDER_LABEL} 上下文超过限制，已尝试压缩历史后仍无法发送，请缩短输入后重试。",
            False,
            True,
        )
    if status_code == 400:
        return ("格式错误", f"{PROVIDER_LABEL} 请求体格式错误，请根据错误信息修改请求体。", False, False)
    if status_code == 401:
        return ("认证失败", f"{PROVIDER_LABEL} 认证失败，请检查 API Key 是否正确。", False, False)
    if status_code == 402:
        return ("余额不足", f"{PROVIDER_LABEL} 账号余额不足，请确认账户余额。", False, False)
    if status_code == 422:
        return ("参数错误", f"{PROVIDER_LABEL} 请求参数错误，请根据错误信息修改相关参数。", False, False)
    if status_code == 429:
        return ("请求速率达到上限", f"{PROVIDER_LABEL} 请求速率达到上限，请稍后重试或降低请求频率。", True, False)
    if status_code == 500:
        return ("服务器故障", f"{PROVIDER_LABEL} 服务器内部故障，请稍后重试。", True, False)
    if status_code == 503:
        return ("服务器繁忙", f"{PROVIDER_LABEL} 服务器繁忙，请稍后重试。", True, False)
    if status_code >= 500:
        return ("服务端错误", f"{PROVIDER_LABEL} 服务暂时异常，请稍后重试。", True, False)
    if status_code:
        return ("请求失败", f"{PROVIDER_LABEL} 请求失败，请检查请求或账号状态。", False, False)
    return ("请求失败", f"{PROVIDER_LABEL} 请求失败，请稍后重试。", True, False)


def classify_deepseek_error(
    *,
    status_code: int | str | None = 0,
    message: str = "",
    body: Any = None,
) -> LLMProviderError:
    safe_status_code = _status_code(status_code)
    raw_message = _combined_message(message=message, body=body)
    text = raw_message.lower()
    category, user_message, retryable, context_overflow = _category_from_status(
        status_code=safe_status_code,
        text=text,
    )
    return LLMProviderError(
        raw_message or user_message,
        provider=PROVIDER_NAME,
        status_code=safe_status_code,
        category=category,
        user_message=user_message,
        retryable=retryable,
        context_overflow=context_overflow,
    )


__all__ = [
    "classify_deepseek_error",
]
