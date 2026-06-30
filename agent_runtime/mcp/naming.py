from __future__ import annotations

import hashlib
import re
from dataclasses import replace
from typing import Iterable

from .models import McpToolInfo


_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_-]+")
_DELIMITER = "__"
_PREFIX = "mcp__"
_MAX_MODEL_TOOL_NAME_BYTES = 64
_HASH_LEN = 10


def sanitize_tool_name_part(value: str, *, fallback: str = "tool") -> str:
    text = _SAFE_NAME_RE.sub("_", str(value or "").strip())
    text = re.sub(r"_+", "_", text).strip("_")
    return text or fallback


def _sha_suffix(raw_identity: str) -> str:
    digest = hashlib.sha1(str(raw_identity or "").encode("utf-8")).hexdigest()
    return "_" + digest[:_HASH_LEN]


def _fit_bytes(value: str, max_bytes: int) -> str:
    if len(value.encode("utf-8")) <= max_bytes:
        return value
    chars: list[str] = []
    used = 0
    for char in value:
        size = len(char.encode("utf-8"))
        if used + size > max_bytes:
            break
        chars.append(char)
        used += size
    return "".join(chars).rstrip("_-")


def _fit_with_hash(value: str, raw_identity: str) -> str:
    if len(value.encode("utf-8")) <= _MAX_MODEL_TOOL_NAME_BYTES:
        return value
    suffix = _sha_suffix(raw_identity)
    budget = max(1, _MAX_MODEL_TOOL_NAME_BYTES - len(suffix.encode("utf-8")))
    return _fit_bytes(value, budget).rstrip("_-") + suffix


def flat_model_tool_name(namespace: str, tool_name: str, raw_identity: str) -> str:
    namespace_part = sanitize_tool_name_part(namespace, fallback="mcp")
    tool_part = sanitize_tool_name_part(tool_name, fallback="tool")
    return _fit_with_hash(f"{_PREFIX}{namespace_part}{_DELIMITER}{tool_part}", raw_identity)


def normalize_mcp_tools(tools: Iterable[McpToolInfo]) -> list[McpToolInfo]:
    candidates: list[McpToolInfo] = []
    for tool in tools:
        raw_identity = f"{tool.server_name}\0{tool.connector_id}\0{tool.raw_tool_name}"
        namespace = sanitize_tool_name_part(tool.callable_namespace, fallback=tool.server_name or "mcp")
        callable_name = sanitize_tool_name_part(tool.callable_name, fallback=tool.raw_tool_name or "tool")
        model_name = flat_model_tool_name(namespace, callable_name, raw_identity)
        candidates.append(
            replace(
                tool,
                callable_namespace=namespace,
                callable_name=callable_name,
                model_name=model_name,
            )
        )

    used: dict[str, int] = {}
    normalized: list[McpToolInfo] = []
    for tool in sorted(candidates, key=lambda item: (item.model_name, item.server_name, item.raw_tool_name)):
        raw_identity = f"{tool.server_name}\0{tool.connector_id}\0{tool.raw_tool_name}"
        model_name = tool.model_name
        if model_name in used:
            suffix = _sha_suffix(raw_identity)
            budget = _MAX_MODEL_TOOL_NAME_BYTES - len(suffix.encode("utf-8"))
            model_name = _fit_bytes(model_name, budget).rstrip("_-") + suffix
        used[model_name] = used.get(model_name, 0) + 1
        normalized.append(replace(tool, model_name=model_name))
    return normalized


__all__ = ["flat_model_tool_name", "normalize_mcp_tools", "sanitize_tool_name_part"]
