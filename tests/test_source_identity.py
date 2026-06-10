from __future__ import annotations

from shared.source_identity import extract_source_bot_identity


def test_extract_source_bot_identity_reads_feishu_extra() -> None:
    identity = extract_source_bot_identity(
        {
            "platform": "feishu",
            "extra": {
                "bot_app_id": "cli_app",
                "bot_id": "ou_bot",
                "bot_name": "FBA业务助手",
            },
        }
    )

    assert identity == {
        "bot_app_id": "cli_app",
        "bot_id": "ou_bot",
        "bot_name": "FBA业务助手",
        "bot_display_name": "FBA业务助手",
    }


def test_extract_source_bot_identity_falls_back_display_name() -> None:
    assert extract_source_bot_identity(
        {
            "platform": "feishu",
            "extra": {"bot_app_id": "cli_app", "bot_id": "ou_bot"},
        }
    )["bot_display_name"] == "ou_bot"
    assert extract_source_bot_identity(
        {
            "platform": "feishu",
            "extra": {"bot_app_id": "cli_app"},
        }
    )["bot_display_name"] == "cli_app"


def test_extract_source_bot_identity_ignores_unknown_platform() -> None:
    assert extract_source_bot_identity(
        {
            "platform": "api_server",
            "extra": {"bot_app_id": "cli_app", "bot_id": "ou_bot", "bot_name": "bot"},
        }
    ) == {
        "bot_app_id": "",
        "bot_id": "",
        "bot_name": "",
        "bot_display_name": "",
    }
