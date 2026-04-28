"""Vision analysis helpers for the browser agent loop.

This module performs one-off screenshot analysis through the existing
kimicode multimodal endpoint and returns a short text summary. Images are
compressed and encoded only within the scope of a single function call.
"""
from __future__ import annotations

import asyncio
import base64
import io
import time
from pathlib import Path

from PIL import Image

from shared.infra.net import external_requests_session
from shared.llm.agent_planner import active_agent_planner_capabilities, effective_agent_planner_max_tokens
from shared.llm.long_conversation import long_conversation_provider_descriptor
from shared.logging import logger


_MAX_DIMENSION = 1024
_JPEG_QUALITY = 60
_MAX_FILE_BYTES = 2_000_000
_VISION_TIMEOUT_S = 15
_VISION_MAX_TOKENS = 300

_VISION_SYSTEM_PROMPT = (
    "你是一个页面视觉分析器。用户会给你一张浏览器截图和一个问题。\n"
    "请直接回答问题，用简单易懂的表达方式，不超过 1000 字。\n"
    "不要描述与问题无关的内容。不要用 markdown 格式。"
)


def _clip_log_text(value: str, *, limit: int = 300) -> str:
    text = " ".join(str(value or "").split()).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def compress_image_bytes(payload: bytes) -> tuple[bytes, str]:
    """Compress raw image bytes into JPEG bytes for one-shot multimodal input."""
    try:
        if not payload:
            return b"", ""
        image = Image.open(io.BytesIO(payload))
        if image.mode != "RGB":
            image = image.convert("RGB")

        width, height = image.size
        max_edge = max(width, height)
        if max_edge > _MAX_DIMENSION:
            scale = _MAX_DIMENSION / max_edge
            image = image.resize(
                (max(1, int(width * scale)), max(1, int(height * scale))),
                Image.LANCZOS,
            )

        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=_JPEG_QUALITY)
        return buffer.getvalue(), "image/jpeg"
    except Exception as exc:
        logger.warning(f"[Vision] image compression failed: {exc}")
        return b"", ""


def _compress_screenshot(path: str) -> tuple[str, str]:
    """Compress a screenshot into JPEG base64 for one-shot vision analysis."""
    try:
        file_path = Path(path)
        if not file_path.is_file():
            return "", ""
        if file_path.stat().st_size > _MAX_FILE_BYTES:
            return "", ""
        compressed_bytes, media_type = compress_image_bytes(file_path.read_bytes())
        if not compressed_bytes:
            return "", ""
        return base64.b64encode(compressed_bytes).decode("ascii"), media_type
    except Exception as exc:
        logger.warning(f"[Vision] screenshot compression failed: {exc}")
        return "", ""


def _sync_analyze(image_base64: str, media_type: str, query: str) -> str:
    """Call the multimodal messages endpoint synchronously."""
    descriptor = long_conversation_provider_descriptor()
    payload = {
        "model": descriptor.default_model,
        "max_tokens": effective_agent_planner_max_tokens(_VISION_MAX_TOKENS),
        "system": _VISION_SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_base64,
                        },
                    },
                    {
                        "type": "text",
                        "text": str(query or "").strip() or "描述当前页面的状态和主要内容。",
                    },
                ],
            }
        ],
    }

    headers = {
        "content-type": "application/json",
        "x-api-key": descriptor.api_key,
        "anthropic-version": "2023-06-01",
    }
    for key, value in dict(descriptor.default_headers or {}).items():
        safe_key = str(key or "").strip()
        safe_value = str(value or "").strip()
        if safe_key and safe_value:
            headers[safe_key] = safe_value

    response = external_requests_session.post(
        f"{str(descriptor.base_url or '').rstrip('/')}/v1/messages",
        headers=headers,
        json=payload,
        timeout=float(_VISION_TIMEOUT_S),
    )
    response.raise_for_status()
    blocks = list(dict(response.json() or {}).get("content") or [])
    return "\n".join(
        str(dict(block or {}).get("text") or "").strip()
        for block in blocks
        if str(dict(block or {}).get("type") or "").strip() == "text"
    ).strip()


async def analyze_screenshot(
    screenshot_path: str,
    query: str = "描述当前页面的状态和主要内容。",
) -> str:
    """Analyze one screenshot and return a short text summary."""
    if not str(screenshot_path or "").strip():
        return ""
    capabilities = active_agent_planner_capabilities()
    if not capabilities.supports_vision:
        logger.warning(
            "[Vision] skipped: current planner model does not support vision | provider=%s | model=%s",
            capabilities.provider,
            capabilities.model,
        )
        return ""

    image_base64, media_type = _compress_screenshot(screenshot_path)
    if not image_base64:
        return ""

    safe_query = str(query or "").strip() or "描述当前页面的状态和主要内容。"
    logger.info(
        "[Vision] request | screenshot=%s | media=%s | image_b64_chars=%d | system=%s | query=%s",
        str(screenshot_path or "").strip(),
        media_type,
        len(image_base64),
        _clip_log_text(_VISION_SYSTEM_PROMPT),
        _clip_log_text(safe_query),
    )

    started_at = time.perf_counter()
    try:
        summary = await asyncio.to_thread(_sync_analyze, image_base64, media_type, safe_query)
    except Exception as exc:
        logger.warning(f"[Vision] analysis failed: {exc}")
        return ""

    elapsed_ms = int((time.perf_counter() - started_at) * 1000)
    logger.info(f"[Vision] analysis completed in {elapsed_ms}ms: {summary[:80]}")
    return str(summary or "").strip()


__all__ = ["analyze_screenshot", "compress_image_bytes"]
