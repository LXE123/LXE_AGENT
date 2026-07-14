from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _repo_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_unverified_ziniao_cli_session_wrapper_is_not_present() -> None:
    removed_paths = [
        "services/browser/store/ziniao_cli_client.py",
        "tests/test_ziniao_cli_client.py",
        "tests/test_ziniao_store_session_cli_backend.py",
    ]

    for relative_path in removed_paths:
        assert not (ROOT / relative_path).exists(), f"{relative_path} should not exist"


def test_store_session_service_does_not_depend_on_ziniao_cli_backend() -> None:
    text = _repo_text("services/browser/store/store_session_service.py")

    forbidden = [
        "ZiniaoCliClient",
        "ZINIAO_BACKEND",
        "_start_cli_store_session",
        "_record_from_cli_open",
        "store open did not return reusable Selenium session fields",
    ]
    for marker in forbidden:
        assert marker not in text


def test_ziniao_config_only_controls_legacy_planner_tool_visibility() -> None:
    text = _repo_text("services/browser/store/ziniao_config.py")

    assert "ZINIAO_REGISTER_PLANNER_TOOLS" in text
    assert "ZINIAO_BACKEND" not in text
    assert "ZINIAO_CLI_BIN" not in text
    assert "shutil.which" not in text


def test_temporary_ziniao_cli_direct_skill_is_removed() -> None:
    assert not (ROOT / "skills/ziniao-cli-direct").exists()
