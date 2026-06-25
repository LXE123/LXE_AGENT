from __future__ import annotations

from agent_runtime.context_pipeline import (
    estimate_tokens,
    sanitize_messages_for_provider,
    trim_step_tool_result_blocks,
    validate_tool_call_closure,
)


def test_sanitize_messages_for_provider_injects_missing_tool_result_stub() -> None:
    messages = [
        {"role": "user", "content": "run"},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_call",
                    "id": "toolu-1",
                    "name": "exec",
                    "arguments": {"cmd": "date"},
                }
            ],
        },
    ]

    repaired, changed = sanitize_messages_for_provider(messages)

    assert changed is True
    assert repaired[-1]["role"] == "tool"
    assert repaired[-1]["content"][0]["tool_call_id"] == "toolu-1"
    assert repaired[-1]["content"][0]["content"] == "[Result unavailable — see context summary above]"
    validate_tool_call_closure(repaired)


def test_sanitize_messages_for_provider_drops_orphan_tool_result() -> None:
    messages = [
        {"role": "user", "content": "hi"},
        {
            "role": "tool",
            "content": [
                {
                    "type": "tool_result",
                    "tool_call_id": "missing",
                    "content": "orphan",
                }
            ],
        },
    ]

    repaired, changed = sanitize_messages_for_provider(messages)

    assert changed is True
    assert repaired == [{"role": "user", "content": "hi"}]


def test_trim_step_tool_result_blocks_uses_utf8_safe_token_budget() -> None:
    text = "开头🙂" + ("中" * 50000) + "结尾🙂"
    blocks, changed = trim_step_tool_result_blocks(
        [
            {
                "type": "tool_result",
                "tool_call_id": "toolu-1",
                "content": text,
            }
        ],
        max_tokens=1000,
    )

    content = blocks[0]["content"]
    assert changed is True
    assert "tokens truncated" in content
    assert content.startswith("开头🙂")
    assert content.endswith("结尾🙂")
    assert estimate_tokens(content) <= 1000
