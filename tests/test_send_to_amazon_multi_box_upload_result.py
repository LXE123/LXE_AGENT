from __future__ import annotations

from typing import Any

from services.agent_cli.browser.amazon_common import send_to_amazon_multi_box as multi_box


def test_read_step2_upload_result_prefers_warning_alert_rows(monkeypatch) -> None:
    calls: list[tuple[str, tuple[Any, ...]]] = []

    def fake_execute(_driver, script: str, *args: Any) -> dict[str, str]:
        calls.append((script, args))
        return {
            "status": "warning",
            "notice": "P1 - B1 重型包裹；P1 - B1 包装箱体积未达到预期的最小体积",
        }

    monkeypatch.setattr(multi_box, "_execute_page_script", fake_execute)

    result = multi_box._read_step2_upload_result(object())

    assert result == {
        "status": "warning",
        "notice": "P1 - B1 重型包裹；P1 - B1 包装箱体积未达到预期的最小体积",
    }
    script, args = calls[0]
    assert ".alert-error-list" in script
    assert args == (
        '[data-testid="pack-group-row-validation-error-message"]',
        '[data-testid="inbound-problem-message-with-sku-list"]',
        '[data-testid="pack-group-cli-warning-results"]',
        '[data-testid="inbound-problem-message"]',
        '[data-testid="pack-group-success-results"]',
    )
