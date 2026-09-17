from __future__ import annotations

import logging
import traceback

import requests

from services.yacang.client import YacangClient
from services.yacang.errors import YacangError, safe_remote_detail
from services.yacang.production import MemoryCooldownStore, MemoryRequestGate, YacangProductionGuard
from services.yacang.reporting import failed_export, summarize_exports


class FailingSession:
    def __init__(self) -> None:
        self.calls = 0

    def request(self, *_args: object, **_kwargs: object) -> object:
        self.calls += 1
        raise requests.Timeout("token=do-not-leak mobile=13800138000")


def _guard() -> YacangProductionGuard:
    return YacangProductionGuard(
        enabled=True,
        cooldown=MemoryCooldownStore(),
        request_gate=MemoryRequestGate(),
    )


def test_traceback_does_not_retain_request_exception_secret() -> None:
    client = YacangClient(FailingSession(), production_guard=_guard(), sleep=lambda _seconds: None)
    try:
        client.list_downloads()
    except YacangError as exc:
        rendered = "".join(traceback.format_exception(exc))
    else:
        raise AssertionError("expected queue failure")

    assert "do-not-leak" not in rendered
    assert "13800138000" not in rendered
    assert "YACANG_NETWORK_ERROR" not in rendered  # codes are structured, not traceback payloads


def test_structured_log_has_context_but_no_secret(caplog) -> None:
    caplog.set_level(logging.INFO, logger="services.yacang.export")
    failed_export(
        {
            "business_type": "inventory-sales",
            "warehouse": "MY8801",
            "start_date": "2026-09-01",
            "end_date": "2026-09-13",
        },
        YacangError(
            "下载 XLSX",
            safe_remote_detail("Authorization: Bearer hidden-token https://example.invalid/a.xlsx"),
            code="XLSX_DOWNLOAD_HTTP_ERROR",
            http_status=500,
        ),
    )

    rendered = caplog.text
    for expected in (
        "inventory-sales", "MY8801", "2026-09-01", "2026-09-13",
        "下载 XLSX", "500", "XLSX_DOWNLOAD_HTTP_ERROR", "failed",
    ):
        assert expected in rendered
    assert "hidden-token" not in rendered
    assert "example.invalid" not in rendered


def test_legacy_summary_success_boolean_is_false_for_partial_success() -> None:
    summary = summarize_exports([
        {"status": "success", "xlsx_path": "success.xlsx"},
        {"status": "failed", "error_code": "FIXTURE_FAILURE"},
    ])

    assert summary["overall_status"] == "partial_success"
    assert summary["success"] is False
