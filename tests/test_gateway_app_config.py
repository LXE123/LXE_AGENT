from __future__ import annotations

import gateway.app as app_mod


def test_gateway_from_config_registers_only_feishu(monkeypatch) -> None:
    original_find_spec = app_mod.importlib.util.find_spec

    def fake_find_spec(name: str):
        if name == "lark_oapi":
            return object()
        return original_find_spec(name)

    monkeypatch.setattr(app_mod, "FEISHU_ENABLED", True)
    monkeypatch.setattr(app_mod, "validate_feishu_runtime_config", lambda: None)
    monkeypatch.setattr(app_mod.importlib.util, "find_spec", fake_find_spec)

    app = app_mod.GatewayApp.from_config()

    assert app._registry.connector_keys() == ["feishu:agent"]


def test_gateway_from_config_fails_without_feishu_config(monkeypatch) -> None:
    def fail_validate() -> None:
        raise RuntimeError("Feishu gateway config incomplete: missing FEISHU_APP_ID")

    monkeypatch.setattr(app_mod, "FEISHU_ENABLED", False)
    monkeypatch.setattr(app_mod, "validate_feishu_runtime_config", fail_validate)

    try:
        app_mod.GatewayApp.from_config()
    except RuntimeError as exc:
        assert "Feishu gateway config incomplete" in str(exc)
    else:
        raise AssertionError("GatewayApp.from_config() should fail when Feishu config is missing")
