from __future__ import annotations

import json

import pytest

from services.agent_cli._shared.json_cli import JsonArgumentParser, exception_text, write_json


def test_json_argument_parser_raises_value_error_on_parse_error() -> None:
    parser = JsonArgumentParser(prog="test-cli")

    with pytest.raises(ValueError) as exc_info:
        parser.parse_args(["--unknown"])

    assert "--unknown" in str(exc_info.value)


def test_write_json_outputs_single_utf8_json_line(capsys) -> None:
    payload = {"success": True, "message": "中文"}

    write_json(payload)

    output = capsys.readouterr().out
    assert output.count("\n") == 1
    assert "中文" in output
    assert json.loads(output) == payload


def test_exception_text_uses_class_name_when_message_is_empty() -> None:
    class EmptyCliError(Exception):
        pass

    assert exception_text(ValueError("  参数错误  ")) == "参数错误"
    assert exception_text(EmptyCliError()) == "EmptyCliError"
