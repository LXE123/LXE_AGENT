from __future__ import annotations

import json
import os
from types import SimpleNamespace

import pytest

from services.browser.browser.selenium_runner import SeleniumRunner, SeleniumRunnerError
from services.browser.store import ziniao_client, ziniao_trace


def _read_trace_records(trace_dir):
    records = []
    for path in sorted(trace_dir.rglob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            records.append(json.loads(line))
    return records


def _trace_text(trace_dir) -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(trace_dir.rglob("*.jsonl")))


def test_default_trace_dir_uses_canonical_state_root(monkeypatch, tmp_path):
    monkeypatch.delenv("ZINIAO_DIAGNOSTIC_TRACE_DIR", raising=False)
    monkeypatch.setattr(ziniao_trace, "state_root", lambda: tmp_path)

    assert ziniao_trace._trace_dir() == tmp_path / "logs" / "ziniao_traces"


def test_trace_disabled_does_not_create_file(monkeypatch, tmp_path):
    trace_dir = tmp_path / "ziniao-traces"
    monkeypatch.setenv("ZINIAO_DIAGNOSTIC_TRACE_ENABLED", "0")
    monkeypatch.setenv("ZINIAO_DIAGNOSTIC_TRACE_DIR", str(trace_dir))

    ziniao_trace.trace_event("client.request", action="startBrowser", store_id="secret-store")
    with ziniao_trace.trace_context("ziniao_browser.open_store", store_id="secret-store"):
        ziniao_trace.trace_event("client.response", status_code=0)

    assert not trace_dir.exists()


def test_start_browser_trace_writes_allowlist_and_redacts_sensitive_values(monkeypatch, tmp_path):
    trace_dir = tmp_path / "ziniao-traces"
    monkeypatch.setenv("ZINIAO_DIAGNOSTIC_TRACE_ENABLED", "1")
    monkeypatch.setenv("ZINIAO_DIAGNOSTIC_TRACE_DIR", str(trace_dir))

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "statusCode": 0,
                "err": "",
                "browserOauth": "secret-store-oauth-value",
                "browserId": 10086,
                "browserName": "Amazon-Test",
                "debuggingPort": 9222,
                "downloadPath": "/tmp/ziniao-downloads",
                "browserPath": "/tmp/ziniao-browser",
                "core_type": "Chromium",
                "core_version": "138.0.7204.168",
                "launcherPage": "https://sellercentral.amazon.com",
                "ipDetectionPage": "https://ip.test",
            }

    calls: list[dict] = []

    def fake_post(url, **kwargs):
        calls.append({"url": url, "kwargs": dict(kwargs)})
        return FakeResponse()

    monkeypatch.setattr(ziniao_client, "local_service_requests_session", SimpleNamespace(post=fake_post))

    with ziniao_trace.trace_context("ziniao_browser.open_store", store_id="secret-store-oauth-value"):
        client = ziniao_client.ZiniaoClient(
            16851,
            {
                "company": "SecretCompany",
                "username": "alice@example.test",
                "password": "super-secret-password",
            },
        )
        assert client.start_browser("secret-store-oauth-value")["browserId"] == 10086

    records = _read_trace_records(trace_dir)
    response_record = next(record for record in records if record["event"] == "client.response")
    assert response_record["action"] == "startBrowser"
    assert response_record["status_code"] == 0
    assert response_record["result"]["browserId"] == 10086
    assert response_record["result"]["debuggingPort"] == 9222
    assert response_record["result"]["core_version"] == "138.0.7204.168"
    assert response_record["result"]["store"]["suffix"] == "alue"

    raw_trace = _trace_text(trace_dir)
    assert "secret-store-oauth-value" not in raw_trace
    assert "SecretCompany" not in raw_trace
    assert "alice@example.test" not in raw_trace
    assert "super-secret-password" not in raw_trace


def test_driver_resolution_failure_trace_includes_candidates(monkeypatch, tmp_path):
    trace_dir = tmp_path / "ziniao-traces"
    monkeypatch.setenv("ZINIAO_DIAGNOSTIC_TRACE_ENABLED", "1")
    monkeypatch.setenv("ZINIAO_DIAGNOSTIC_TRACE_DIR", str(trace_dir))

    browser_root = tmp_path / "browser-root"
    browser_root.mkdir()
    driver_root = tmp_path / "drivers"
    driver_root.mkdir()
    (driver_root / "chromedriver138").write_text("driver", encoding="utf-8")

    with ziniao_trace.trace_context("ziniao_browser.open_store", store_id="secret-store"):
        runner = SeleniumRunner(str(driver_root))
        with pytest.raises(SeleniumRunnerError, match="could not resolve ChromeDriver path"):
            runner.get_driver(
                {
                    "browserPath": str(browser_root),
                    "debuggingPort": 9222,
                    "core_type": "Chromium",
                    "core_version": "146.0.9999.1",
                }
            )

    records = _read_trace_records(trace_dir)
    failure = next(record for record in records if record["event"] == "driver.resolve.failure")
    assert failure["browserPath"] == str(browser_root)
    embedded_driver = "webdriver.exe" if os.name == "nt" else "webdriver"
    assert failure["embedded_driver_candidate"] == str(browser_root / embedded_driver)
    assert failure["embedded_driver_exists"] is False
    assert failure["core_type"] == "Chromium"
    assert failure["core_version"] == "146.0.9999.1"
    fallback_driver = "chromedriver146.exe" if os.name == "nt" else "chromedriver146"
    assert failure["fallback_driver_candidate"] == str(driver_root / fallback_driver)
    assert failure["fallback_driver_exists"] is False
    assert failure["available_chromedrivers"] == ["chromedriver138"]
    assert "secret-store" not in _trace_text(trace_dir)


def test_trace_context_error_redacts_store_id_from_exception_text(monkeypatch, tmp_path):
    trace_dir = tmp_path / "ziniao-traces"
    monkeypatch.setenv("ZINIAO_DIAGNOSTIC_TRACE_ENABLED", "1")
    monkeypatch.setenv("ZINIAO_DIAGNOSTIC_TRACE_DIR", str(trace_dir))

    with pytest.raises(RuntimeError, match="secret-store-oauth-value"):
        with ziniao_trace.trace_context("ziniao_browser.open_store", store_id="secret-store-oauth-value"):
            raise RuntimeError("目标店铺不存在: secret-store-oauth-value")

    raw_trace = _trace_text(trace_dir)
    assert "secret-store-oauth-value" not in raw_trace
    assert "[redacted-store]" in raw_trace
