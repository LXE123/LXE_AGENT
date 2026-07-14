from __future__ import annotations

from services.agent_cli._shared.json_cli import exception_text


def test_exception_text_uses_class_name_when_message_is_empty() -> None:
    class EmptyCliError(Exception):
        pass

    assert exception_text(ValueError("  参数错误  ")) == "参数错误"
    assert exception_text(EmptyCliError()) == "EmptyCliError"
