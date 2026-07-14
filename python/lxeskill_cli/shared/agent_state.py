from __future__ import annotations

from typing import Any
from uuid import uuid4


RUNTIME_KEY = "runtime"
CONTEXT_KEY = "context"
MESSAGES_KEY = "messages"
RUNTIME_ALLOWED_KEYS = {
    "session_activity_at",
}


def _clean_inline_content_blocks(value: Any) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for raw_block in list(value or []):
        block = dict(raw_block or {})
        block_type = str(block.get("type") or "").strip()
        if block_type == "text":
            blocks.append({"type": "text", "text": str(block.get("text") or "")})
            continue
        if block_type == "image":
            source = dict(block.get("source") or {})
            blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": str(source.get("media_type") or source.get("mimeType") or "").strip(),
                        "data": str(source.get("data") or ""),
                    },
                }
            )
    return blocks


def _clean_assistant_content_blocks(
    value: Any,
    *,
    allow_tool_use_alias: bool = False,
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for raw_block in list(value or []):
        block = dict(raw_block or {})
        block_type = str(block.get("type") or "").strip()
        if block_type == "thinking":
            thinking = str(block.get("thinking") or "")
            signature = str(block.get("signature") or "").strip()
            if thinking or signature:
                blocks.append(
                    {
                        "type": "thinking",
                        "thinking": thinking,
                        "signature": signature,
                    }
                )
            continue
        if block_type == "redacted_thinking":
            blocks.append(
                {
                    "type": "redacted_thinking",
                    "data": str(block.get("data") or ""),
                }
            )
            continue
        if block_type == "text":
            blocks.append({"type": "text", "text": str(block.get("text") or "")})
            continue
        if block_type == "tool_call":
            arguments = dict(block.get("arguments") or {})
        elif block_type == "tool_use" and allow_tool_use_alias:
            arguments = dict(block.get("input") or {})
        else:
            continue
        name = str(block.get("name") or "").strip()
        if not name:
            continue
        blocks.append(
            {
                "type": "tool_call",
                "id": str(block.get("id") or uuid4().hex).strip(),
                "name": name,
                "arguments": arguments,
            }
        )
    return blocks


def _clean_canonical_message(value: dict[str, Any] | None) -> dict[str, Any] | None:
    message = dict(value or {})
    role = str(message.get("role") or "").strip()
    if role not in {"user", "assistant", "tool", "system"}:
        return None

    if role == "system":
        return {"role": role, "content": str(message.get("content") or "")}

    if role == "user":
        content = message.get("content")
        if isinstance(content, list):
            return {"role": "user", "content": _clean_inline_content_blocks(content)}
        return {"role": "user", "content": str(content or "")}

    if role == "assistant":
        content = message.get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": str(content or "")}]
        return {"role": "assistant", "content": _clean_assistant_content_blocks(content)}

    blocks = []
    for raw_block in list(message.get("content") or []):
        block = dict(raw_block or {})
        if str(block.get("type") or "").strip() != "tool_result":
            continue
        tool_call_id = str(block.get("tool_call_id") or "").strip()
        if not tool_call_id:
            tool_call_id = uuid4().hex
        block_content = block.get("content")
        cleaned_block: dict[str, Any] = {
            "type": "tool_result",
            "tool_call_id": tool_call_id,
            "content": (
                _clean_inline_content_blocks(block_content)
                if isinstance(block_content, list)
                else str(block_content or "")
            ),
        }
        if bool(block.get("is_error")):
            cleaned_block["is_error"] = True
        blocks.append(cleaned_block)
    return {"role": "tool", "content": blocks}


def _clean_context_messages(value: Any) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for raw_message in list(value or []):
        cleaned = _clean_canonical_message(raw_message if isinstance(raw_message, dict) else {})
        if cleaned is not None:
            messages.append(cleaned)
    return messages


def ensure_agent_state(state_data: dict[str, Any] | None) -> dict[str, Any]:
    state = dict(state_data or {})
    runtime = dict(state.get(RUNTIME_KEY) or {})
    context = dict(state.get(CONTEXT_KEY) or {})
    context[MESSAGES_KEY] = _clean_context_messages(context.get(MESSAGES_KEY))
    return {
        RUNTIME_KEY: runtime,
        CONTEXT_KEY: context,
    }


def _validate_runtime_keys(runtime: dict[str, Any] | None, *, context: str) -> dict[str, Any]:
    runtime_values = dict(runtime or {})
    invalid_keys = sorted(key for key in runtime_values if key not in RUNTIME_ALLOWED_KEYS)
    if invalid_keys:
        raise RuntimeError(
            f"invalid runtime {context}: non-control keys are not allowed: "
            + ", ".join(invalid_keys)
        )
    return runtime_values


def runtime_state(state_data: dict[str, Any] | None) -> dict[str, Any]:
    return dict(ensure_agent_state(state_data).get(RUNTIME_KEY) or {})


def runtime_patch(runtime_values: dict[str, Any] | None) -> dict[str, Any]:
    return {
        RUNTIME_KEY: _validate_runtime_keys(runtime_values, context="patch"),
    }


def runtime_patch_from_state(state_data: dict[str, Any] | None) -> dict[str, Any]:
    runtime = runtime_state(state_data)
    return runtime_patch(runtime)


def merge_agent_state(
    base_state: dict[str, Any] | None,
    patch_state: dict[str, Any] | None,
) -> dict[str, Any]:
    merged = ensure_agent_state(base_state)
    patch = dict(patch_state or {})

    runtime = dict(merged.get(RUNTIME_KEY) or {})
    patch_runtime = dict(patch.get(RUNTIME_KEY) or {}) if isinstance(patch.get(RUNTIME_KEY), dict) else {}
    runtime = _validate_runtime_keys(runtime, context="merge base")
    runtime.update(_validate_runtime_keys(patch_runtime, context="merge patch"))
    runtime = _validate_runtime_keys(runtime, context="merged state")

    context = dict(merged.get(CONTEXT_KEY) or {})
    if isinstance(patch.get(CONTEXT_KEY), dict):
        patch_context = dict(patch.get(CONTEXT_KEY) or {})
        if MESSAGES_KEY in patch_context:
            context[MESSAGES_KEY] = _clean_context_messages(patch_context.get(MESSAGES_KEY))

    return {
        RUNTIME_KEY: runtime,
        CONTEXT_KEY: context,
    }


__all__ = [
    "ensure_agent_state",
    "merge_agent_state",
    "runtime_patch_from_state",
]
