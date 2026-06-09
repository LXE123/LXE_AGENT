from __future__ import annotations

import json
from typing import Any

from shared.llm.errors import LLMProviderError

PROVIDER_NAME = "kimi_coding"
PROVIDER_LABEL = "Kimi Coding"


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


def _has(text: str, *needles: str) -> bool:
    return any(needle.lower() in text for needle in needles)


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


def _category_from_text(*, status_code: int, text: str) -> tuple[str, str, bool, bool]:
    if _context_overflow(text):
        return (
            "请求格式错误",
            f"{PROVIDER_LABEL} 上下文超过限制，已尝试压缩历史后仍无法发送，请缩短输入后重试。",
            False,
            True,
        )

    if _has(text, "context canceled"):
        return ("工具调用错误", f"{PROVIDER_LABEL} 工具调用被取消，请稍后重试。", True, False)

    if _has(
        text,
        "url2text",
        "spider checkurl failed",
        "invalid html",
        "image_url:moderation request error",
        "invalid_url",
        "provided url is invalid",
    ):
        return ("工具调用错误", f"{PROVIDER_LABEL} 工具调用输入无效，请检查 URL 或图片地址。", False, False)

    if _has(text, "security risk", "current url poses a security risk"):
        return ("工具调用错误", f"{PROVIDER_LABEL} 拒绝访问该 URL，当前 URL 被判定存在安全风险。", False, False)

    if _has(
        text,
        "api key appears to be invalid",
        "invalid authentication",
        "api key",
        "authentication",
    ) or status_code == 401:
        return ("认证错误", f"{PROVIDER_LABEL} 认证失败，请检查 API Key 是否无效或已过期。", False, False)

    if _has(text, "membership benefits") or status_code == 402:
        return ("会员权益异常", f"{PROVIDER_LABEL} 会员权益异常，请检查当前账号权益。", False, False)

    if _has(text, "not found the model", "method not found", "not found") or status_code == 404:
        return ("资源未找到", f"{PROVIDER_LABEL} 模型或接口未找到，请检查模型名称和账号权限。", False, False)

    if _has(text, "usage limit for this billing cycle", "access terminated"):
        return ("权限错误", f"{PROVIDER_LABEL} 当前账号权限或计费周期额度不可用，请检查账号状态。", False, False)

    if _has(text, "available for coding agents", "permission denied") or status_code == 403:
        return ("权限错误", f"{PROVIDER_LABEL} 权限不足，请确认账号已开通 Kimi For Coding。", False, False)

    if _has(
        text,
        "engine is currently overloaded",
        "receiving too many requests",
        "usage limit for this period",
        "kimi monthly usage limit",
        "rate limit",
        "too many requests",
    ) or status_code == 429:
        return ("限流与配额", f"{PROVIDER_LABEL} 当前限流或额度不足，请稍后重试。", True, False)

    if _has(
        text,
        "thinking is enabled but reasoning_content is missing",
        "unsupported image url",
        "function name",
        "is duplicated",
        "request was rejected",
        "high risk",
    ) or status_code == 400:
        return ("请求格式错误", f"{PROVIDER_LABEL} 请求格式错误，请检查消息、工具或图片输入。", False, False)

    if _has(
        text,
        "bot_id",
        "database=membership_",
        "terminating connection",
        "failed to evaluate rate limit script",
        "i/o timeout",
        "conn closed",
        "bad connection",
        "service unavailable",
        "gateway timeout",
        "bad gateway",
        "未找到该账号",
        "该账号已被禁用",
        "已被禁言",
    ) or status_code >= 500:
        return ("服务端内部错误", f"{PROVIDER_LABEL} 服务暂时异常，请稍后重试。", True, False)

    if status_code:
        retryable = status_code == 408 or status_code == 409 or status_code == 429 or status_code >= 500
        return (
            "服务端内部错误" if retryable else "请求失败",
            f"{PROVIDER_LABEL} 请求失败，请稍后重试。" if retryable else f"{PROVIDER_LABEL} 请求失败，请检查请求或账号状态。",
            retryable,
            False,
        )

    return ("请求失败", f"{PROVIDER_LABEL} 请求失败，请稍后重试。", True, False)


def classify_kimi_coding_error(
    *,
    status_code: int | str | None = 0,
    message: str = "",
    body: Any = None,
) -> LLMProviderError:
    safe_status_code = _status_code(status_code)
    raw_message = _combined_message(message=message, body=body)
    text = raw_message.lower()
    category, user_message, retryable, context_overflow = _category_from_text(
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
    "classify_kimi_coding_error",
]
