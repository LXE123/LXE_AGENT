from __future__ import annotations

from typing import Any
from uuid import uuid4


RUNTIME_KEY = "runtime"
CONTEXT_KEY = "context"
MESSAGES_KEY = "messages"
RUNTIME_ALLOWED_KEYS = {
    "active_turn_id",
    "active_card_id",
    "active_turn_started_at",
    "stop_turn_id",
    "stop_requested_at",
    "session_activity_at",
}
_COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary: "


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
        blocks: list[dict[str, Any]] = []
        for raw_block in list(content or []):
            block = dict(raw_block or {})
            block_type = str(block.get("type") or "").strip()
            if block_type == "text":
                blocks.append({"type": "text", "text": str(block.get("text") or "")})
                continue
            if block_type != "tool_call":
                continue
            name = str(block.get("name") or "").strip()
            if not name:
                continue
            blocks.append(
                {
                    "type": "tool_call",
                    "id": str(block.get("id") or uuid4().hex).strip(),
                    "name": name,
                    "arguments": dict(block.get("arguments") or {}),
                }
            )
        return {"role": "assistant", "content": blocks}

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


def _legacy_history_message_to_canonical(value: dict[str, Any] | None) -> dict[str, Any] | None:
    message = dict(value or {})
    role = str(message.get("role") or "").strip()
    content = message.get("content")

    if role in {"user", "system"}:
        return {"role": role, "content": str(content or "")}

    if role == "assistant":
        if isinstance(content, list):
            blocks: list[dict[str, Any]] = []
            for raw_block in list(content or []):
                block = dict(raw_block or {})
                block_type = str(block.get("type") or "").strip()
                if block_type == "text":
                    blocks.append({"type": "text", "text": str(block.get("text") or "")})
                    continue
                if block_type != "tool_use":
                    continue
                name = str(block.get("name") or "").strip()
                if not name:
                    continue
                blocks.append(
                    {
                        "type": "tool_call",
                        "id": str(block.get("id") or uuid4().hex).strip(),
                        "name": name,
                        "arguments": dict(block.get("input") or {}),
                    }
                )
            return {"role": "assistant", "content": blocks}
        return {"role": "assistant", "content": [{"type": "text", "text": str(content or "")}]}

    if role == "toolResult":
        blocks: list[dict[str, Any]] = []
        if isinstance(content, list):
            for raw_block in list(content or []):
                block = dict(raw_block or {})
                if str(block.get("type") or "").strip() != "tool_result":
                    continue
                block_content = block.get("content")
                cleaned_block: dict[str, Any] = {
                    "type": "tool_result",
                    "tool_call_id": str(block.get("tool_call_id") or block.get("tool_use_id") or uuid4().hex).strip(),
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

    return None


def migrate_legacy_context_data(value: dict[str, Any] | None) -> dict[str, Any]:
    raw = dict(value or {})
    if isinstance(raw.get(MESSAGES_KEY), list):
        return {MESSAGES_KEY: _clean_context_messages(raw.get(MESSAGES_KEY))}

    messages: list[dict[str, Any]] = []
    session_memory = dict(raw.get("session_memory") or {})
    summary = str(session_memory.get("history_summary") or "").strip()
    if summary:
        messages.append({"role": "user", "content": _COMPACTION_SUMMARY_PREFIX + summary})

    for raw_turn in list(raw.get("history_turns") or []):
        turn = dict(raw_turn or {})
        for raw_message in list(turn.get("messages") or []):
            cleaned = _legacy_history_message_to_canonical(raw_message if isinstance(raw_message, dict) else {})
            if cleaned is not None:
                messages.append(cleaned)

    return {MESSAGES_KEY: _clean_context_messages(messages)}


def empty_context_state() -> dict[str, Any]:
    return {
        MESSAGES_KEY: [],
    }


def empty_runtime_state() -> dict[str, Any]:
    return {}


def is_nested_agent_state(state_data: dict[str, Any] | None) -> bool:
    state = dict(state_data or {})
    return isinstance(state.get(RUNTIME_KEY), dict) and isinstance(state.get(CONTEXT_KEY), dict)


def ensure_agent_state(state_data: dict[str, Any] | None) -> dict[str, Any]:
    state = dict(state_data or {})
    runtime = dict(state.get(RUNTIME_KEY) or {})
    context = dict(state.get(CONTEXT_KEY) or {})
    context[MESSAGES_KEY] = _clean_context_messages(context.get(MESSAGES_KEY))
    return {
        RUNTIME_KEY: runtime,
        CONTEXT_KEY: context,
    }


def _legacy_clean_runtime(runtime: dict[str, Any] | None) -> dict[str, Any]:
    runtime_values = dict(runtime or {})
    return {
        key: runtime_values[key]
        for key in RUNTIME_ALLOWED_KEYS
        if key in runtime_values
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


def split_agent_state_for_storage(
    full_state: dict[str, Any] | None,
    *,
    allow_legacy_runtime: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    state = ensure_agent_state(full_state)
    runtime = (
        _legacy_clean_runtime(state.get(RUNTIME_KEY))
        if allow_legacy_runtime
        else _validate_runtime_keys(state.get(RUNTIME_KEY), context="storage state")
    )
    return (
        {
            RUNTIME_KEY: runtime,
        },
        dict(state.get(CONTEXT_KEY) or {}),
    )


def compose_agent_state(
    session_runtime_state: dict[str, Any] | None,
    context_data: dict[str, Any] | None,
) -> dict[str, Any]:
    raw_runtime = dict(session_runtime_state or {})
    runtime = raw_runtime.get(RUNTIME_KEY) if isinstance(raw_runtime.get(RUNTIME_KEY), dict) else raw_runtime
    return ensure_agent_state(
        {
            RUNTIME_KEY: dict(runtime or {}),
            CONTEXT_KEY: dict(context_data or {}),
        }
    )


def runtime_state(state_data: dict[str, Any] | None) -> dict[str, Any]:
    return dict(ensure_agent_state(state_data).get(RUNTIME_KEY) or {})


def context_state(state_data: dict[str, Any] | None) -> dict[str, Any]:
    return dict(ensure_agent_state(state_data).get(CONTEXT_KEY) or {})


def runtime_patch(runtime_values: dict[str, Any] | None) -> dict[str, Any]:
    return {
        RUNTIME_KEY: _validate_runtime_keys(runtime_values, context="patch"),
    }


def runtime_patch_from_state(state_data: dict[str, Any] | None) -> dict[str, Any]:
    runtime = runtime_state(state_data)
    return runtime_patch(runtime)


def context_patch(context_values: dict[str, Any] | None) -> dict[str, Any]:
    return {
        CONTEXT_KEY: dict(context_values or {}),
    }


def replace_runtime_state(
    state_data: dict[str, Any] | None,
    runtime_patch: dict[str, Any] | None,
) -> dict[str, Any]:
    state = ensure_agent_state(state_data)
    runtime = _validate_runtime_keys(runtime_patch, context="replacement")
    state[RUNTIME_KEY] = runtime
    return state


def replace_context_state(
    state_data: dict[str, Any] | None,
    context_patch: dict[str, Any] | None,
) -> dict[str, Any]:
    state = ensure_agent_state(state_data)
    context = empty_context_state()
    context[MESSAGES_KEY] = _clean_context_messages(dict(context_patch or {}).get(MESSAGES_KEY))
    state[CONTEXT_KEY] = context
    return state


def update_runtime_state(
    state_data: dict[str, Any] | None,
    runtime_patch: dict[str, Any] | None,
) -> dict[str, Any]:
    state = ensure_agent_state(state_data)
    runtime = dict(state.get(RUNTIME_KEY) or {})
    runtime.update(_validate_runtime_keys(runtime_patch, context="patch"))
    runtime = _validate_runtime_keys(runtime, context="merged state")
    state[RUNTIME_KEY] = runtime
    return state


def update_context_state(
    state_data: dict[str, Any] | None,
    context_patch: dict[str, Any] | None,
) -> dict[str, Any]:
    state = ensure_agent_state(state_data)
    context = dict(state.get(CONTEXT_KEY) or {})
    raw_patch = dict(context_patch or {})
    if MESSAGES_KEY in raw_patch:
        context[MESSAGES_KEY] = _clean_context_messages(raw_patch.get(MESSAGES_KEY))
    state[CONTEXT_KEY] = context
    return state


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


def build_initial_agent_state(
    *,
    entry_text: str = "",
) -> dict[str, Any]:
    runtime = empty_runtime_state()
    _ = entry_text
    context = empty_context_state()
    return {
        RUNTIME_KEY: runtime,
        CONTEXT_KEY: context,
    }


def reset_context_only(
    state_data: dict[str, Any] | None,
    *,
    keep_runtime_keys: set[str] | None = None,
) -> dict[str, Any]:
    state = ensure_agent_state(state_data)
    runtime = dict(state.get(RUNTIME_KEY) or {})
    if keep_runtime_keys is not None:
        runtime = {key: value for key, value in runtime.items() if key in keep_runtime_keys}
    runtime = _legacy_clean_runtime(runtime)
    return {
        RUNTIME_KEY: runtime,
        CONTEXT_KEY: empty_context_state(),
    }


__all__ = [
    "CONTEXT_KEY",
    "MESSAGES_KEY",
    "RUNTIME_KEY",
    "RUNTIME_ALLOWED_KEYS",
    "build_initial_agent_state",
    "compose_agent_state",
    "context_patch",
    "context_state",
    "empty_context_state",
    "empty_runtime_state",
    "ensure_agent_state",
    "is_nested_agent_state",
    "merge_agent_state",
    "migrate_legacy_context_data",
    "replace_context_state",
    "replace_runtime_state",
    "reset_context_only",
    "runtime_patch",
    "runtime_patch_from_state",
    "runtime_state",
    "split_agent_state_for_storage",
    "update_context_state",
    "update_runtime_state",
]
