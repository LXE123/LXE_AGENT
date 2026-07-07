from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

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
from shared.llm.errors import LLMProviderError


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


def test_maybe_compact_history_single_span_uses_midturn_summary_not_tool_result_aging(monkeypatch) -> None:
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 22050)

    async def fake_summarize_midturn_history(
        *,
        messages: list[dict[str, object]],
        original_user_message: dict[str, object],
    ) -> str:
        assert original_user_message == {"role": "user", "content": "run"}
        assert messages[0]["role"] == "assistant"
        assert messages[1]["role"] == "tool"
        return "midturn summary"

    monkeypatch.setattr(context_pipeline, "_summarize_midturn_history", fake_summarize_midturn_history)
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

    messages = load_context_messages(result.state_data)
    assert result.compacted is True
    assert messages[0] == {"role": "user", "content": "run"}
    assert "midturn summary" in messages[1]["content"]
    assert "[tool result elided to save context]" not in str(messages)


def test_maybe_compact_history_midturn_compacts_after_old_turn_summary_still_over_budget(monkeypatch) -> None:
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 22050)

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        assert messages[0] == {"role": "user", "content": "old request"}
        return "old turn summary"

    async def fake_summarize_midturn_history(
        *,
        messages: list[dict[str, object]],
        original_user_message: dict[str, object],
    ) -> str:
        assert original_user_message == {"role": "user", "content": "run latest"}
        assert messages[0]["role"] == "assistant"
        assert messages[1]["role"] == "tool"
        return "latest turn checkpoint"

    monkeypatch.setattr(context_pipeline, "_summarize_history", fake_summarize_history)
    monkeypatch.setattr(context_pipeline, "_summarize_midturn_history", fake_summarize_midturn_history)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "old request"},
                {"role": "assistant", "content": [{"type": "text", "text": "old answer"}]},
                {"role": "user", "content": "run latest"},
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

    messages = load_context_messages(result.state_data)
    assert result.compacted is True
    assert result.compacted_count == 4
    assert "old turn summary" in messages[0]["content"]
    assert messages[1] == {"role": "user", "content": "run latest"}
    assert "latest turn checkpoint" in messages[2]["content"]
    assert messages[-1] == {"role": "assistant", "content": [{"type": "text", "text": "recent"}]}


def test_maybe_compact_history_keeps_improved_pre_call_summary_above_soft_trigger(
    monkeypatch,
) -> None:
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1000)
    monkeypatch.setattr(context_pipeline, "DEFAULT_RESERVE_TOKENS", 0)
    monkeypatch.setattr(context_pipeline, "RECENT_RAW_TURN_TOKEN_LIMIT", 100)

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        assert messages[0] == {"role": "user", "content": "old request"}
        return "old request summary"

    monkeypatch.setattr(context_pipeline, "_summarize_history", fake_summarize_history)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "old request"},
                {"role": "assistant", "content": [{"type": "text", "text": "old answer " + ("o" * 1200)}]},
                {"role": "user", "content": "recent " + ("x" * 3700)},
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

    messages = load_context_messages(result.state_data)
    assert result.compacted is True
    assert result.state_data != state_data
    assert "old request summary" in messages[0]["content"]
    assert messages[1]["content"].startswith("recent ")


def test_maybe_compact_history_keeps_improved_summary_when_midturn_fallback_empty(
    monkeypatch,
) -> None:
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1000)
    monkeypatch.setattr(context_pipeline, "DEFAULT_RESERVE_TOKENS", 0)
    monkeypatch.setattr(context_pipeline, "RECENT_RAW_TURN_TOKEN_LIMIT", 100)

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        assert messages[0] == {"role": "user", "content": "old request"}
        return "old request summary"

    async def fake_summarize_midturn_history(
        *,
        messages: list[dict[str, object]],
        original_user_message: dict[str, object],
    ) -> str:
        assert messages[0]["role"] == "assistant"
        assert original_user_message == {"role": "user", "content": "run"}
        return ""

    monkeypatch.setattr(context_pipeline, "_summarize_history", fake_summarize_history)
    monkeypatch.setattr(context_pipeline, "_summarize_midturn_history", fake_summarize_midturn_history)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "old request"},
                {"role": "assistant", "content": [{"type": "text", "text": "old answer " + ("o" * 1200)}]},
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
                            "content": "START-" + ("x" * 5000) + "-END",
                        }
                    ],
                },
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

    messages = load_context_messages(result.state_data)
    assert result.compacted is True
    assert result.state_data != state_data
    assert "old request summary" in messages[0]["content"]
    assert messages[1] == {"role": "user", "content": "run"}
    assert messages[-1]["role"] == "tool"


def test_maybe_compact_history_drops_summary_when_it_does_not_reduce_tokens(
    monkeypatch,
    caplog,
) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1000)
    monkeypatch.setattr(context_pipeline, "DEFAULT_RESERVE_TOKENS", 0)
    monkeypatch.setattr(context_pipeline, "RECENT_RAW_TURN_TOKEN_LIMIT", 100)

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        return "worse summary " + ("s" * 6000)

    monkeypatch.setattr(context_pipeline, "_summarize_history", fake_summarize_history)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "old request"},
                {"role": "assistant", "content": [{"type": "text", "text": "old answer"}]},
                {"role": "user", "content": "recent " + ("x" * 3700)},
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


def test_maybe_compact_history_keeps_improved_midturn_summary_above_soft_trigger(
    monkeypatch,
) -> None:
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1000)
    monkeypatch.setattr(context_pipeline, "DEFAULT_RESERVE_TOKENS", 0)
    monkeypatch.setattr(context_pipeline, "RECENT_RAW_TURN_TOKEN_LIMIT", 100)

    async def fake_summarize_midturn_history(
        *,
        messages: list[dict[str, object]],
        original_user_message: dict[str, object],
    ) -> str:
        assert original_user_message == {"role": "user", "content": "run"}
        assert messages[0]["role"] == "assistant"
        assert messages[1]["role"] == "tool"
        return "tool checkpoint"

    monkeypatch.setattr(context_pipeline, "_summarize_midturn_history", fake_summarize_midturn_history)
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
                            "content": "START-" + ("x" * 5000) + "-END",
                        }
                    ],
                },
                {"role": "assistant", "content": [{"type": "text", "text": "recent " + ("r" * 3300)}]},
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

    messages = load_context_messages(result.state_data)
    assert result.compacted is True
    assert "tool checkpoint" in messages[1]["content"]
    assert messages[-1]["content"][0]["text"].startswith("recent ")


def test_render_messages_for_summary_extracts_multiblock_user_text_without_repr() -> None:
    transcript = context_pipeline._render_messages_for_summary(
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "first"},
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": "A" * 100,
                        },
                    },
                    {"type": "text", "text": "second"},
                ],
            },
            {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
        ]
    )

    assert "User: first" in transcript
    assert "second" in transcript
    assert "[image omitted]" in transcript
    assert "{'type': 'text'" not in transcript
    assert "AAAAAAAA" not in transcript


def test_summarize_midturn_history_extracts_original_multiblock_request(monkeypatch) -> None:
    captured: dict[str, str] = {}

    async def fake_chat_with_tools(**kwargs: object) -> SimpleNamespace:
        messages = list(kwargs["messages"])  # type: ignore[index]
        captured["content"] = str(messages[0]["content"])
        return SimpleNamespace(text="summary")

    monkeypatch.setattr(context_pipeline, "chat_with_tools", fake_chat_with_tools)

    result = asyncio.run(
        context_pipeline._summarize_midturn_history(
            messages=[{"role": "assistant", "content": [{"type": "text", "text": "worked"}]}],
            original_user_message={
                "role": "user",
                "content": [
                    {"type": "text", "text": "inspect"},
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": "B" * 100,
                        },
                    },
                    {"type": "text", "text": "please"},
                ],
            },
        )
    )

    assert result == "summary"
    assert "inspect" in captured["content"]
    assert "please" in captured["content"]
    assert "[image omitted]" in captured["content"]
    assert "{'type': 'text'" not in captured["content"]
    assert "BBBBBBBB" not in captured["content"]


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


def test_maybe_compact_history_retries_summary_exception_once(monkeypatch, caplog) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)
    calls = {"count": 0}

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("temporary summary outage")
        return "summary after retry"

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
    assert calls["count"] == 2
    assert result.compacted is True
    assert "summary after retry" in messages[0]["content"]
    assert any("attempt=1/2" in record.getMessage() for record in caplog.records)


def test_maybe_compact_history_retries_empty_summary_once(monkeypatch, caplog) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)
    calls = {"count": 0}

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        calls["count"] += 1
        if calls["count"] == 1:
            return " \n "
        return "summary after empty retry"

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
    assert calls["count"] == 2
    assert result.compacted is True
    assert "summary after empty retry" in messages[0]["content"]
    assert any("reason=empty" in record.getMessage() for record in caplog.records)


def test_maybe_compact_history_returns_original_state_after_two_summary_exceptions(
    monkeypatch,
    caplog,
) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)
    calls = {"count": 0}

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        calls["count"] += 1
        raise RuntimeError("summary still unavailable")

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

    assert calls["count"] == 2
    assert result.compacted is False
    assert result.state_data == state_data
    assert sum("summary failed" in record.getMessage() for record in caplog.records) == 2


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


def test_maybe_compact_history_returns_original_state_after_two_empty_summaries(
    monkeypatch,
    caplog,
) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)
    calls = {"count": 0}

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        calls["count"] += 1
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

    assert calls["count"] == 2
    assert result.compacted is False
    assert result.state_data == state_data
    assert sum("summary returned empty" in record.getMessage() for record in caplog.records) == 2


def test_maybe_compact_history_does_not_retry_non_retryable_summary_error(
    monkeypatch,
    caplog,
) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)
    calls = {"count": 0}

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        calls["count"] += 1
        raise LLMProviderError(
            "bad request",
            provider="test",
            retryable=False,
        )

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

    assert calls["count"] == 1
    assert result.compacted is False
    assert result.state_data == state_data
    assert any("reason=non_retryable" in record.getMessage() for record in caplog.records)


def test_maybe_compact_history_does_not_retry_summary_context_overflow(
    monkeypatch,
    caplog,
) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)
    calls = {"count": 0}

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        calls["count"] += 1
        raise LLMProviderError(
            "summary prompt is too long",
            provider="test",
            retryable=True,
            context_overflow=True,
        )

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

    assert calls["count"] == 1
    assert result.compacted is False
    assert result.state_data == state_data
    assert any("reason=non_retryable" in record.getMessage() for record in caplog.records)


def test_maybe_compact_history_returns_original_state_when_summary_still_over_budget(
    monkeypatch,
    caplog,
) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 22050)
    calls = {"count": 0}

    async def fake_summarize_history(*, messages: list[dict[str, object]]) -> str:
        calls["count"] += 1
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

    assert calls["count"] == 1
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


def test_overflow_compaction_noops_when_single_turn_has_no_step_to_summarize(
    monkeypatch,
    caplog,
) -> None:
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "run " + ("x" * 90000)},
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


def test_overflow_compaction_summarizes_oversized_single_turn_at_step_boundary(
    monkeypatch,
) -> None:
    monkeypatch.setattr(context_pipeline, "_model_context_window_tokens", lambda: 1_000_000)
    summarized: dict[str, list[dict[str, object]]] = {}

    async def fake_summarize_midturn_history(
        *,
        messages: list[dict[str, object]],
        original_user_message: dict[str, object],
    ) -> str:
        summarized["messages"] = messages
        assert original_user_message == {"role": "user", "content": "run long task"}
        return "checkpoint summary with omitted tool result list"

    monkeypatch.setattr(context_pipeline, "_summarize_midturn_history", fake_summarize_midturn_history)
    old_tool_call = {
        "role": "assistant",
        "content": [
            {
                "type": "tool_call",
                "id": "toolu-old",
                "name": "exec",
                "arguments": {"cmd": "large"},
            }
        ],
    }
    old_tool_result = {
        "role": "tool",
        "content": [
            {
                "type": "tool_result",
                "tool_call_id": "toolu-old",
                "content": "START-" + ("x" * 90000) + "-END",
            }
        ],
    }
    recent_tool_call = {
        "role": "assistant",
        "content": [
            {
                "type": "tool_call",
                "id": "toolu-recent",
                "name": "exec",
                "arguments": {"cmd": "small"},
            }
        ],
    }
    recent_tool_result = {
        "role": "tool",
        "content": [
            {
                "type": "tool_result",
                "tool_call_id": "toolu-recent",
                "content": "recent result",
            }
        ],
    }
    state_data = {
        "context": {
            "messages": [
                {"role": "user", "content": "run long task"},
                old_tool_call,
                old_tool_result,
                recent_tool_call,
                recent_tool_result,
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
    assert summarized["messages"] == [old_tool_call, old_tool_result]
    assert messages[0] == {"role": "user", "content": "run long task"}
    assert "current task were compacted" in messages[1]["content"]
    assert "checkpoint summary with omitted tool result list" in messages[1]["content"]
    assert messages[2:] == [recent_tool_call, recent_tool_result, {"role": "assistant", "content": [{"type": "text", "text": "recent answer"}]}]
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
