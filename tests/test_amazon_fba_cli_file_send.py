from __future__ import annotations

from pathlib import Path

from agent_runtime.emit_bus import reset_emit_handlers
from services.agent_cli.browser.amazon_fba import _shared as fba_shared


def _payload(file_path: list[dict[str, str]], *, notice: str = "base notice") -> dict:
    return {
        "params_ready": True,
        "finished": True,
        "exception": "",
        "notice": notice,
        "file_path": file_path,
        "context": {},
    }


def test_send_selected_result_files_preserves_file_path_when_emit_handler_missing(monkeypatch, tmp_path: Path):
    consignment = tmp_path / "consignment.xlsx"
    filled = tmp_path / "filled.xlsx"
    consignment.write_bytes(b"consignment")
    filled.write_bytes(b"filled")
    entries = [
        {"key": "consignment_excel", "value": str(consignment)},
        {"key": "filled_template", "value": str(filled)},
    ]

    reset_emit_handlers()
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-1")
    monkeypatch.setenv("LXE_RESPONSE_ROUTE_ID", "route-1")
    try:
        result = fba_shared.send_selected_result_files(
            _payload(entries),
            allowed_keys=("consignment_excel", "filled_template"),
        )
    finally:
        reset_emit_handlers()

    assert result["file_path"] == entries
    assert "base notice" in result["notice"]
    assert "runtime emit handler not configured" in result["notice"]
    assert str(consignment) in result["notice"]
    assert str(filled) in result["notice"]


def test_send_selected_result_files_preserves_file_path_without_session(monkeypatch):
    entries = [
        {"key": "filled_template", "value": r"D:\tmp\filled.xlsx"},
    ]

    async def fail_send_file(*_args, **_kwargs):
        raise AssertionError("send_file_to_current_session should not be called")

    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    monkeypatch.setattr(fba_shared, "send_file_to_current_session", fail_send_file)

    result = fba_shared.send_selected_result_files(
        _payload(entries),
        allowed_keys=("filled_template",),
    )

    assert result["file_path"] == entries
    assert result["notice"] == "base notice"


def test_send_selected_result_files_sends_only_allowed_keys_and_keeps_all_entries(monkeypatch):
    entries = [
        {"key": "consignment_excel", "value": r"D:\tmp\consignment.xls"},
        {"key": "amazon_template", "value": r"D:\tmp\template.xlsx"},
        {"key": "filled_template", "value": r"D:\tmp\filled.xlsx"},
    ]
    calls: list[tuple[str, str, str]] = []

    async def fake_send_file(session_id: str, path: str, *, response_route_id: str = "") -> None:
        calls.append((session_id, path, response_route_id))

    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-1")
    monkeypatch.setenv("LXE_RESPONSE_ROUTE_ID", "route-1")
    monkeypatch.setattr(fba_shared, "send_file_to_current_session", fake_send_file)

    result = fba_shared.send_selected_result_files(
        _payload(entries, notice="ok"),
        allowed_keys=("consignment_excel", "filled_template"),
    )

    assert calls == [
        ("session-1", r"D:\tmp\consignment.xls", "route-1"),
        ("session-1", r"D:\tmp\filled.xlsx", "route-1"),
    ]
    assert result["file_path"] == entries
    assert result["notice"] == "ok"
