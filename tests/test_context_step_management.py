from __future__ import annotations

import asyncio
import logging

import agent_runtime.context_pipeline as context_pipeline
from agent_runtime.context_pipeline import (
    build_llm_messages,
    estimate_tokens,
    load_context_messages,
    maybe_compact_history,
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


def test_trim_step_tool_result_blocks_preserves_image_blocks() -> None:
    image_block = {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "A" * 70000,
        },
    }
    blocks, changed = trim_step_tool_result_blocks(
        [
            {
                "type": "tool_result",
                "tool_call_id": "toolu-1",
                "content": [
                    {"type": "text", "text": "screenshot"},
                    image_block,
                ],
            }
        ],
        max_tokens=1000,
    )

    content = blocks[0]["content"]
    assert changed is False
    assert isinstance(content, list)
    assert content[1] == image_block


def test_trim_step_tool_result_blocks_shares_budget_across_text_blocks() -> None:
    image_block = {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "A" * 70000,
        },
    }
    blocks, changed = trim_step_tool_result_blocks(
        [
            {
                "type": "tool_result",
                "tool_call_id": "toolu-1",
                "content": [
                    {"type": "text", "text": "开头🙂" + ("中" * 4000)},
                    image_block,
                    {"type": "text", "text": ("尾" * 4000) + "结尾🙂"},
                ],
            }
        ],
        max_tokens=1000,
    )

    content = blocks[0]["content"]
    text_blocks = [block for block in content if block.get("type") == "text"]
    image_blocks = [block for block in content if block.get("type") == "image"]
    text = text_blocks[0]["text"]
    assert changed is True
    assert len(text_blocks) == 1
    assert len(image_blocks) == 1
    assert image_blocks[0] == image_block
    assert "tokens truncated" in text
    assert text.startswith("开头🙂")
    assert text.endswith("结尾🙂")
    assert estimate_tokens(text) <= 1000


def test_estimate_tokens_counts_image_blocks_with_fixed_budget() -> None:
    image_block = {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "A" * 70000,
        },
    }

    assert estimate_tokens(image_block) == 1600
    assert estimate_tokens([image_block]) < 1700


def test_build_llm_messages_preserves_historical_tool_result_content() -> None:
    text = "START-" + ("x" * 60000) + "-END"
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "run"},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_call",
                            "id": "toolu-1",
                            "name": "exec",
                            "arguments": {"cmd": "large"},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "toolu-1",
                            "content": text,
                        }
                    ],
                },
            ],
        },
    }

    messages, _stats = build_llm_messages(
        state_data=state_data,
        current_turn_messages=[],
        system_prompt="",
    )

    assert messages[2]["content"][0]["content"] == text


def test_build_llm_messages_preserves_step_trimmed_tool_result() -> None:
    blocks, _changed = trim_step_tool_result_blocks(
        [
            {
                "type": "tool_result",
                "tool_call_id": "toolu-1",
                "content": "开头🙂" + ("中" * 50000) + "结尾🙂",
            }
        ],
        max_tokens=1000,
    )
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "run"},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_call",
                            "id": "toolu-1",
                            "name": "exec",
                            "arguments": {"cmd": "large"},
                        }
                    ],
                },
                {"role": "tool", "content": blocks},
            ],
        },
    }

    messages, _stats = build_llm_messages(
        state_data=state_data,
        current_turn_messages=[],
        system_prompt="",
    )

    content = messages[2]["content"][0]["content"]
    assert "[Old tool result content cleared]" not in content
    assert "tokens truncated" in content


def test_maybe_compact_history_single_span_does_not_age_tool_result(monkeypatch, caplog) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 22050)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "run"},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_call",
                            "id": "toolu-1",
                            "name": "exec",
                            "arguments": {"cmd": "large"},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "toolu-1",
                            "content": "START-" + ("x" * 90000) + "-END",
                        }
                    ],
                },
                {"role": "assistant", "content": [{"type": "text", "text": "recent"}]},
            ],
        },
    }

    result = asyncio.run(
        maybe_compact_history(
            state_data=state_data,
            session_id="s1",
            system_prompt="",
            trigger="pre_call",
        )
    )

    assert result.compacted is False
    assert result.state_data == state_data
    assert any("no summarizable history prefix" in record.getMessage() for record in caplog.records)


def test_maybe_compact_history_returns_original_state_when_summary_raises(monkeypatch, caplog) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        raise RuntimeError("summary provider unavailable")

    monkeypatch.setattr(context_pipeline, "_summarize_history", fake_summarize_history)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "old request"},
                {"role": "assistant", "content": [{"type": "text", "text": "old answer"}]},
                {"role": "user", "content": "recent " + ("x" * 90000)},
                {"role": "assistant", "content": [{"type": "text", "text": "recent answer"}]},
            ],
        },
    }

    result = asyncio.run(
        maybe_compact_history(
            state_data=state_data,
            session_id="s1",
            system_prompt="",
            trigger="overflow",
        )
    )

    assert result.compacted is False
    assert result.state_data == state_data
    assert any("summary failed" in record.getMessage() for record in caplog.records)


def test_maybe_compact_history_returns_original_state_when_summary_empty(monkeypatch, caplog) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        return "  \n"

    monkeypatch.setattr(context_pipeline, "_summarize_history", fake_summarize_history)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "old request"},
                {"role": "assistant", "content": [{"type": "text", "text": "old answer"}]},
                {"role": "user", "content": "recent " + ("x" * 90000)},
                {"role": "assistant", "content": [{"type": "text", "text": "recent answer"}]},
            ],
        },
    }

    result = asyncio.run(
        maybe_compact_history(
            state_data=state_data,
            session_id="s1",
            system_prompt="",
            trigger="overflow",
        )
    )

    assert result.compacted is False
    assert result.state_data == state_data
    assert any("summary returned empty" in record.getMessage() for record in caplog.records)


def test_maybe_compact_history_returns_original_state_when_summary_still_over_budget(
    monkeypatch,
    caplog,
) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 22050)

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        return "summary that cannot offset the retained oversized span"

    monkeypatch.setattr(context_pipeline, "_summarize_history", fake_summarize_history)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "old request"},
                {"role": "assistant", "content": [{"type": "text", "text": "old answer"}]},
                {"role": "user", "content": "recent " + ("x" * 90000)},
                {"role": "assistant", "content": [{"type": "text", "text": "recent answer"}]},
            ],
        },
    }

    result = asyncio.run(
        maybe_compact_history(
            state_data=state_data,
            session_id="s1",
            system_prompt="",
            trigger="pre_call",
        )
    )

    assert result.compacted is False
    assert result.state_data == state_data
    assert any("summary still over budget" in record.getMessage() for record in caplog.records)


def test_overflow_compaction_bypasses_local_estimate_gate_for_summary(monkeypatch) -> None:
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        assert messages == [
            {"role": "user", "content": "old request"},
            {"role": "assistant", "content": [{"type": "text", "text": "old answer"}]},
        ]
        return "summary from overflow"

    monkeypatch.setattr(context_pipeline, "_summarize_history", fake_summarize_history)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "old request"},
                {"role": "assistant", "content": [{"type": "text", "text": "old answer"}]},
                {"role": "user", "content": "recent " + ("x" * 90000)},
                {"role": "assistant", "content": [{"type": "text", "text": "recent answer"}]},
            ],
        },
    }

    result = asyncio.run(
        maybe_compact_history(
            state_data=state_data,
            session_id="s1",
            system_prompt="",
            trigger="overflow",
        )
    )

    messages = load_context_messages(result.state_data)
    assert result.compacted is True
    assert result.compacted_count == 2
    assert messages[0]["role"] == "user"
    assert "summary from overflow" in messages[0]["content"]
    assert messages[1]["content"].startswith("recent ")


def test_overflow_compaction_bypasses_local_estimate_gate_but_does_not_age_single_span(
    monkeypatch,
    caplog,
) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "run"},
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_call",
                            "id": "toolu-1",
                            "name": "exec",
                            "arguments": {"cmd": "large"},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "toolu-1",
                            "content": "START-" + ("x" * 90000) + "-END",
                        }
                    ],
                },
                {"role": "assistant", "content": [{"type": "text", "text": "recent"}]},
            ],
        },
    }

    result = asyncio.run(
        maybe_compact_history(
            state_data=state_data,
            session_id="s1",
            system_prompt="",
            trigger="overflow",
        )
    )

    messages = load_context_messages(result.state_data)
    assert result.compacted is False
    assert messages == state_data["context"]["messages"]
    assert any("no summarizable history prefix" in record.getMessage() for record in caplog.records)
    validate_tool_call_closure(messages)


def test_non_overflow_compaction_keeps_local_estimate_gate(monkeypatch) -> None:
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "run"},
                {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
            ],
        },
    }

    pre_call_result = asyncio.run(
        maybe_compact_history(
            state_data=state_data,
            session_id="s1",
            system_prompt="",
            trigger="pre_call",
        )
    )
    post_turn_result = asyncio.run(
        maybe_compact_history(
            state_data=state_data,
            session_id="s1",
            system_prompt="",
            trigger="post_turn",
        )
    )

    assert pre_call_result.compacted is False
    assert pre_call_result.state_data == state_data
    assert post_turn_result.compacted is False
    assert post_turn_result.state_data == state_data
