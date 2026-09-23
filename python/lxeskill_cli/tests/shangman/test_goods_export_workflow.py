from services.agent_cli.shangman import _workflow


PARAMS = {"params": {"platform": "上马印尼", "country": "印尼", "operation": "goods_export"}}


def test_gate_blocks_before_persisted_export(monkeypatch):
    monkeypatch.delenv("LXE_SHANGMAN_PROD_ENABLED", raising=False)
    monkeypatch.setattr(_workflow, "export_goods", lambda _: (_ for _ in ()).throw(AssertionError("exporter called")))
    result = _workflow.run(PARAMS)
    assert result["error"]["code"] == "production_gate_required"


def test_fixed_contract_delegates_once_and_keeps_compact_terminal(monkeypatch):
    monkeypatch.setenv("LXE_SHANGMAN_PROD_ENABLED", "true")
    calls = []
    monkeypatch.setattr(_workflow, "export_goods", lambda args: (calls.append(args) or {
        "success": True, "artifact_path": "/safe/shangman.xlsx", "row_count": 3,
    }))
    result = _workflow.run(PARAMS)
    assert calls == [{}]
    assert result["terminal_projection"] == {"data": {
        "platform": "上马印尼", "country": "印尼", "business_type": "goods_export", "row_count": 3,
    }}
    assert "plan" not in result["terminal_projection"]["data"]


def test_login_required_is_compact_and_does_not_retry(monkeypatch):
    monkeypatch.setenv("LXE_SHANGMAN_PROD_ENABLED", "true")
    calls = []
    monkeypatch.setattr(_workflow, "export_goods", lambda _: (calls.append(1) or {
        "success": False, "error": {"code": "login_required", "message": "登录态缺失"},
    }))
    result = _workflow.run(PARAMS)
    assert calls == [1]
    assert result["error"]["code"] == "login_required"
    assert result["terminal_projection"]["data"] == {
        "platform": "上马印尼", "country": "印尼", "business_type": "goods_export",
    }
