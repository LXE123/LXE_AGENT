from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
import json

import pytest

from lxeskill import cli as lxeskill_cli
from lxeskill.business import load_catalog
from services.agent_cli.zhihui import export_products
from services.zhihui_tms.intent import normalize_product_export_intent
from services.zhihui_tms.planner import plan_product_export
from shared.process_lock import InterProcessLockTimeout
from shared.repository import repository_root


ARGUMENTS = {"platform": "zhihui_tms", "warehouse": "PH", "intent": "product_export"}


def test_structured_intent_accepts_only_the_fixed_contract() -> None:
    intent = normalize_product_export_intent(ARGUMENTS)
    assert intent.warehouse == "PH"
    invalid = [
        {**ARGUMENTS, "platform": "other"}, {**ARGUMENTS, "warehouse": "ID"},
        {**ARGUMENTS, "intent": "orders"}, {**ARGUMENTS, "fields": ["inventory"]},
        {**ARGUMENTS, "extra": "value"},
    ]
    for arguments in invalid:
        with pytest.raises(ValueError):
            normalize_product_export_intent(arguments)


def test_plan_requires_the_explicit_action_and_structured_input() -> None:
    plan = plan_product_export(ARGUMENTS, action="preview", date_label="20260917")
    assert plan.action == "preview"
    assert plan.page_size == 1000
    with pytest.raises(ValueError, match="action"):
        plan_product_export(ARGUMENTS, action="retry", date_label="20260917")


def test_preview_does_not_construct_a_client_or_create_artifacts(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(export_products, "artifact_root", lambda: tmp_path)
    monkeypatch.setattr(export_products, "ZhihuiTmsClient", lambda: pytest.fail("preview opened network client"))
    result = export_products.run_action(ARGUMENTS, action="preview")
    assert result["success"] is True
    assert result["artifacts"] == []
    assert result["terminal_projection"] == {
        "data": {
            "platform": "zhihui_tms",
            "country": "PH",
            "business_type": "product_export",
            "preview": True,
        },
    }
    assert list(tmp_path.iterdir()) == []


def test_invalid_input_never_constructs_client(monkeypatch) -> None:
    monkeypatch.setattr(export_products, "ZhihuiTmsClient", lambda: pytest.fail("invalid input opened network client"))
    result = export_products.run_action({**ARGUMENTS, "fields": ["inventory"]}, action="execute")
    assert result == {"success": False, "code": "tms_plan_invalid", "exception": "不支持的参数: fields", "artifacts": []}


def test_execute_requires_gate_and_runtime_secrets(monkeypatch) -> None:
    monkeypatch.delenv("ZHIHUI_TMS_PRODUCTION_ENABLED", raising=False)
    monkeypatch.delenv("ZHIHUI_TMS_ACCOUNT", raising=False)
    monkeypatch.delenv("ZHIHUI_TMS_PASSWORD", raising=False)
    monkeypatch.setattr(export_products, "ZhihuiTmsClient", lambda: pytest.fail("gate opened network client"))
    assert export_products.run_action(ARGUMENTS, action="execute")["code"] == "tms_production_disabled"
    monkeypatch.setenv("ZHIHUI_TMS_PRODUCTION_ENABLED", "1")
    assert export_products.run_action(ARGUMENTS, action="execute")["code"] == "tms_credentials_missing"


def test_existing_delivery_uses_the_canonical_zhihui_tms_filename(tmp_path: Path) -> None:
    path = tmp_path / "智汇tms-商品-合并-20260917.xlsx"
    path.write_bytes(b"merged")

    assert export_products._existing_delivery(tmp_path, "20260917") == [
        {"path": str(path.resolve()), "kind": "merged", "page": None, "total_pages": None},
    ]


def test_execute_refuses_second_run_before_login(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ZHIHUI_TMS_PRODUCTION_ENABLED", "1")
    monkeypatch.setenv("ZHIHUI_TMS_ACCOUNT", "fixture-account")
    monkeypatch.setenv("ZHIHUI_TMS_PASSWORD", "fixture-secret")
    monkeypatch.setattr(export_products, "artifact_root", lambda: tmp_path)
    monkeypatch.setattr(export_products, "ZhihuiTmsClient", lambda: pytest.fail("busy run opened network client"))

    @contextmanager
    def busy_lock(_path, *, timeout_seconds):
        assert timeout_seconds == 0
        raise InterProcessLockTimeout("another export owns lock")
        yield

    monkeypatch.setattr(export_products, "interprocess_lock", busy_lock)
    assert export_products.run_action(ARGUMENTS, action="execute")["code"] == "tms_export_busy"


def test_execute_composes_login_export_and_delivery(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ZHIHUI_TMS_PRODUCTION_ENABLED", "1")
    monkeypatch.setenv("ZHIHUI_TMS_ACCOUNT", "fixture-account")
    monkeypatch.setenv("ZHIHUI_TMS_PASSWORD", "fixture-secret")
    monkeypatch.setattr(export_products, "artifact_root", lambda: tmp_path)
    calls: list[object] = []

    class FakeClient:
        def __init__(self, *, api_token: str = "") -> None:
            self.api_token = api_token

        def set_authentication_recovery(self, _callback) -> None:
            return None

        def login(self, account: str, password: str) -> None:
            calls.append(("login", account, password))
            self.api_token = "fixture-api-token"

    client = FakeClient()
    monkeypatch.setattr(export_products, "ZhihuiTmsClient", lambda *, api_token="": client)
    monkeypatch.setattr(export_products, "export_stockwarehouse_pages", lambda actual, **_: (calls.append(("export", actual)) or SimpleNamespace(pages=(object(),), total_records=2, request_count=2)))

    def delivery(actual, result, *, output_dir, date_label):
        assert actual is client and result.total_records == 2
        output_dir.mkdir(parents=True)
        path = output_dir / f"智汇tms-商品-合并-{date_label}.xlsx"
        path.write_bytes(b"merged")
        return SimpleNamespace(artifacts=(SimpleNamespace(path=str(path), kind="merged", page=None, total_pages=1),), total_rows=2)

    monkeypatch.setattr(export_products, "deliver_product_exports", delivery)
    result = export_products.run_action(ARGUMENTS, action="execute")
    assert result["success"] is True
    assert result["artifacts"][0]["kind"] == "merged"
    assert result["terminal_projection"] == {
        "data": {
            "platform": "zhihui_tms",
            "country": "PH",
            "business_type": "product_export",
            "row_count": 2,
        },
    }
    assert "fixture-secret" not in str(result)
    assert calls[0] == ("login", "fixture-account", "fixture-secret")


def test_execute_reuses_cached_session_without_logging_in(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ZHIHUI_TMS_PRODUCTION_ENABLED", "1")
    monkeypatch.setenv("ZHIHUI_TMS_ACCOUNT", "fixture-account")
    monkeypatch.setenv("ZHIHUI_TMS_PASSWORD", "fixture-secret")
    monkeypatch.setattr(export_products, "artifact_root", lambda: tmp_path)
    calls: list[object] = []

    class FakeProvider:
        def read(self, account: str) -> str | None:
            calls.append(("read", account))
            return "fixture-cached-token"

        def write(self, account: str, token: str) -> None:
            calls.append(("write", account, token))

        def clear(self, account: str) -> None:
            calls.append(("clear", account))

    class FakeClient:
        def __init__(self, *, api_token: str = "") -> None:
            self.api_token = api_token
            calls.append(("client", api_token))

        def set_authentication_recovery(self, _callback) -> None:
            calls.append(("recovery",))

        def login(self, *_args) -> None:
            pytest.fail("cached session must not log in")

    client: FakeClient | None = None

    def create_client(*, api_token: str = "") -> FakeClient:
        nonlocal client
        client = FakeClient(api_token=api_token)
        return client

    monkeypatch.setattr(export_products, "ZhihuiTmsSessionProvider", SimpleNamespace(from_environment=lambda: FakeProvider()))
    monkeypatch.setattr(export_products, "ZhihuiTmsClient", create_client)
    monkeypatch.setattr(export_products, "export_stockwarehouse_pages", lambda actual, **_: (calls.append(("export", actual)) or SimpleNamespace(pages=(object(),), total_records=2, request_count=2)))
    monkeypatch.setattr(
        export_products,
        "deliver_product_exports",
        lambda actual, _result, *, output_dir, date_label: (
            output_dir.mkdir(parents=True)
            or SimpleNamespace(
                artifacts=(SimpleNamespace(path=str(output_dir / f"智汇tms-商品-合并-{date_label}.xlsx"), kind="merged", page=None, total_pages=1),),
                total_rows=2,
            )
        ),
    )

    result = export_products.run_action(ARGUMENTS, action="execute")

    assert result["success"] is True
    assert client is not None and client.api_token == "fixture-cached-token"
    assert ("read", "fixture-account") in calls
    assert not any(call[0] == "write" for call in calls if isinstance(call, tuple))


def test_catalog_exposes_exact_preview_and_execute_paths(monkeypatch, capsys) -> None:
    catalog = load_catalog()
    schemas = []
    for name, action in (("zhihui_preview_products", "preview"), ("zhihui_execute_products", "execute")):
        entry = catalog[name]
        assert entry["command_path"][-1] == action
        assert set(entry["input_schema"]["properties"]) == set(ARGUMENTS)
        assert entry["input_schema"]["required"] == list(ARGUMENTS)
        assert entry["input_schema"]["additionalProperties"] is False
        schemas.append(entry["input_schema"])
    assert schemas[0] == schemas[1]
    assert "confirmation" not in catalog["zhihui_execute_products"]
    assert lxeskill_cli.main(["tms", "philippines", "products-export", "preview", "--platform", "zhihui_tms", "--warehouse", "PH", "--intent", "product_export"]) == 0
    result = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line][-1]
    assert result == {
        "protocol_version": "1",
        "type": "result",
        "command": "tms philippines products-export preview",
        "ok": True,
        "data": {
            "platform": "zhihui_tms",
            "country": "PH",
            "business_type": "product_export",
            "preview": True,
        },
        "files": [],
    }


def test_skill_declares_a_deterministic_philippines_contract_without_fields() -> None:
    skill = (repository_root() / "skills" / "zhihui-tms-product-export" / "SKILL.md").read_text(encoding="utf-8")

    assert "当前版本只支持菲律宾" in skill
    assert "固定归一为 PH，不追问国家" in skill
    assert "菲律宾库存" in skill
    assert "--fields" not in skill
    assert "`fields`" not in skill
    assert "data.artifacts" not in skill
