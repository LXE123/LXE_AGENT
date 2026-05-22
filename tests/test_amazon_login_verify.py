from __future__ import annotations

from pathlib import Path

import pytest

from services.agent_cli.browser.amazon_common import login_verify
from services.agent_cli.browser.amazon_fba import login_verify as login_verify_cli
from services.browser.workflows import amazon_fba_login_verify
from services.browser.workflows import registry
from services.browser.workflows.amazon_fba_common import WorkflowBrowserSession


def test_click_current_login_button_targets_path_specific_buttons() -> None:
    class _Driver:
        def execute_script(self, script: str):
            if "return String((window.location && window.location.pathname)" in script:
                return "/ap/signin"
            assert "window.location.pathname" in script
            assert "'input#continue[type=\"submit\"]'" in script
            assert script.index("'input#continue[type=\"submit\"]'") < script.index("'#signInSubmit'")
            assert '\'#auth-signin-button[name="mfaSubmit"]\'' in script
            assert "'#auth-signin-button'" in script
            return {"path": "/ap/signin", "login": True, "clicked": True, "button": "continue"}

    assert login_verify._click_current_login_button(_Driver()) == {
        "path": "/ap/signin",
        "login": True,
        "clicked": True,
        "button": "continue",
    }


def test_click_current_login_button_waits_before_mfa_submit(monkeypatch) -> None:
    sleeps: list[float] = []

    class _Driver:
        def execute_script(self, script: str):
            if "return String((window.location && window.location.pathname)" in script:
                return "/ap/mfa"
            assert sleeps == [1.5]
            return {"path": "/ap/mfa", "login": True, "clicked": True, "button": "mfaSubmit"}

    monkeypatch.setattr(login_verify.time, "sleep", lambda seconds: sleeps.append(float(seconds)))

    assert login_verify._click_current_login_button(_Driver()) == {
        "path": "/ap/mfa",
        "login": True,
        "clicked": True,
        "button": "mfaSubmit",
    }
    assert sleeps == [1.5]


def test_verify_seller_central_login_noops_when_not_login_path(monkeypatch) -> None:
    monkeypatch.setattr(
        login_verify,
        "_click_current_login_button",
        lambda _driver: {"path": "/home", "login": False, "clicked": False, "button": ""},
    )

    result = login_verify.verify_seller_central_login(object(), timeout_seconds=30)

    assert result == {
        "handled": False,
        "click_count": 0,
        "last_path": "/home",
        "notice": "当前页面无需登录验证",
    }


def test_verify_seller_central_login_handles_signin_and_mfa_sequence(monkeypatch) -> None:
    payloads = iter(
        [
            {"path": "/ap/signin", "login": True, "clicked": True, "button": "continue"},
            {"path": "/ap/signin", "login": True, "clicked": True, "button": "signInSubmit"},
            {"path": "/ap/mfa", "login": True, "clicked": True, "button": "mfaSubmit"},
            {"path": "/home", "login": False, "clicked": False, "button": ""},
        ]
    )
    sleeps: list[float] = []

    monkeypatch.setattr(login_verify, "_click_current_login_button", lambda _driver: next(payloads))
    monkeypatch.setattr(login_verify.time, "sleep", lambda seconds: sleeps.append(float(seconds)))

    result = login_verify.verify_seller_central_login(object(), timeout_seconds=30)

    assert result == {
        "handled": True,
        "click_count": 3,
        "last_path": "/home",
        "notice": "登录验证已完成",
    }
    assert sleeps == [0.5, 0.5, 0.5]


def test_verify_seller_central_login_stops_after_max_clicks(monkeypatch) -> None:
    calls: list[str] = []
    sleeps: list[float] = []

    monkeypatch.setattr(
        login_verify,
        "_click_current_login_button",
        lambda _driver: calls.append("click") or {"path": "/ap/signin", "login": True, "clicked": True, "button": "continue"},
    )
    monkeypatch.setattr(login_verify, "_current_path", lambda _driver: "/ap/signin")
    monkeypatch.setattr(login_verify.time, "sleep", lambda seconds: sleeps.append(float(seconds)))

    result = login_verify.verify_seller_central_login(object(), timeout_seconds=30, max_clicks=3)

    assert result == {
        "handled": True,
        "manual_required": True,
        "click_count": 3,
        "last_path": "/ap/signin",
        "notice": "登录验证自动点击已达上限，仍停留在登录页面，请让用户手动完成登录验证",
    }
    assert calls == ["click", "click", "click"]
    assert sleeps == [0.5, 0.5, 0.5]


def test_verify_seller_central_login_times_out_on_login_path(monkeypatch) -> None:
    clock = {"now": 0.0}
    calls: list[str] = []

    monkeypatch.setattr(
        login_verify,
        "_click_current_login_button",
        lambda _driver: calls.append("click") or {"path": "/ap/signin", "login": True, "clicked": False, "button": ""},
    )
    monkeypatch.setattr(login_verify.time, "time", lambda: clock["now"])
    monkeypatch.setattr(login_verify.time, "sleep", lambda seconds: clock.__setitem__("now", clock["now"] + float(seconds)))

    with pytest.raises(RuntimeError, match=r"等待登录验证完成超时: path=/ap/signin"):
        login_verify.verify_seller_central_login(object(), timeout_seconds=1)
    assert calls == ["click", "click"]


def test_run_login_verify_workflow_uses_driver_and_returns_notice() -> None:
    driver = object()
    session = WorkflowBrowserSession(
        driver=driver,
        state_data={},
        output_dir=Path.cwd(),
        store_id="store-1",
        store_name="Amazon-BR",
    )
    seen: list[tuple[object, int]] = []

    def fake_verify(_driver, *, timeout_seconds: int):
        seen.append((_driver, timeout_seconds))
        return {"handled": True, "click_count": 2, "last_path": "/home", "notice": "登录验证已完成"}

    result = amazon_fba_login_verify.run_login_verify_workflow(
        session=session,
        payload={"site": "BR", "timeout_sec": 45},
        event_writer=lambda _payload: None,
        verify_fn=fake_verify,
    )

    assert result["params_ready"] is True
    assert result["finished"] is True
    assert result["notice"] == "登录验证已完成，共点击 2 次"
    assert result["context"]["store_id"] == "store-1"
    assert seen == [(driver, 45)]


def test_run_login_verify_workflow_returns_manual_required_failure() -> None:
    session = WorkflowBrowserSession(
        driver=object(),
        state_data={},
        output_dir=Path.cwd(),
        store_id="store-1",
        store_name="Amazon-BR",
    )

    result = amazon_fba_login_verify.run_login_verify_workflow(
        session=session,
        payload={"timeout_sec": 45},
        event_writer=lambda _payload: None,
        verify_fn=lambda *_args, **_kwargs: {
            "handled": True,
            "manual_required": True,
            "click_count": 10,
            "last_path": "/ap/signin",
            "notice": "登录验证自动点击已达上限，仍停留在登录页面，请让用户手动完成登录验证",
        },
    )

    assert result["params_ready"] is True
    assert result["finished"] is False
    assert result["exception"] == "登录验证自动点击已达上限，仍停留在登录页面，请让用户手动完成登录验证，共点击 10 次"
    assert result["notice"] == "登录验证自动点击已达上限，仍停留在登录页面，请让用户手动完成登录验证，共点击 10 次"


def test_run_login_verify_workflow_returns_not_ready_without_selected_store() -> None:
    session = WorkflowBrowserSession(
        driver=object(),
        state_data={},
        output_dir=Path.cwd(),
        store_id="",
        store_name="",
    )

    result = amazon_fba_login_verify.run_login_verify_workflow(
        session=session,
        payload={"timeout_sec": 45},
        event_writer=lambda _payload: None,
        verify_fn=lambda *_args, **_kwargs: {"notice": "should not run"},
    )

    assert result["params_ready"] is False
    assert result["finished"] is False
    assert result["exception"] == "当前没有明确选中的店铺"


def test_login_verify_cli_accepts_store_id_without_context_file() -> None:
    parser = login_verify_cli._build_parser()
    args = parser.parse_args(["--store-id", "store-1", "--timeout-sec", "60"])

    context, timeout_sec = login_verify_cli._validate_args(args)

    assert context == {"store_id": "store-1"}
    assert timeout_sec == 60


def test_login_verify_cli_missing_store_id_returns_not_ready(monkeypatch) -> None:
    events: list[dict[str, object]] = []

    monkeypatch.setattr(login_verify_cli, "write_result_event", lambda payload: events.append(dict(payload)))
    monkeypatch.setattr(login_verify_cli, "finalize_fba_cli_process", lambda: None)

    exit_code = login_verify_cli.main([])

    assert exit_code == 1
    assert events[0]["params_ready"] is False
    assert events[0]["finished"] is False
    assert events[0]["exception"] == "缺少 store_id"


def test_login_verify_cli_uses_direct_workflow_without_files(monkeypatch) -> None:
    driver = object()
    session = WorkflowBrowserSession(
        driver=driver,
        state_data={},
        output_dir=Path.cwd(),
        session_id="agent-1",
        store_id="store-1",
        store_name="Amazon-BR",
    )
    calls: list[dict[str, object]] = []

    class _BrowserSessionContext:
        def __enter__(self):
            return session

        def __exit__(self, exc_type, exc, tb):
            return None

    def fake_browser_session(**kwargs):
        calls.append(kwargs)
        return _BrowserSessionContext()

    def fake_workflow_runner(**kwargs):
        calls.append(kwargs)
        return {"params_ready": True, "finished": True, "exception": "", "notice": "ok", "file_path": [], "context": {}}

    monkeypatch.setattr(login_verify_cli, "resolve_agent_session_id", lambda: "agent-1")
    monkeypatch.setattr(login_verify_cli, "browser_session", fake_browser_session)
    monkeypatch.setattr(login_verify_cli, "_workflow_output_dir", lambda _session_id: Path.cwd())

    result = login_verify_cli.run_login_verify(
        context={"store_id": "store-1"},
        timeout_sec=30,
        workflow_runner=fake_workflow_runner,
    )

    assert result["finished"] is True
    assert calls[0]["session_id"] == "agent-1"
    assert calls[0]["context"] == {"store_id": "store-1"}
    assert calls[1]["session"] is session
    assert calls[1]["payload"] == {"store_id": "store-1", "timeout_sec": 30}


def test_login_verify_workflow_is_registered() -> None:
    assert registry._BROWSER_FLOW_RUNNERS["amazon_fba.login_verify"] is amazon_fba_login_verify.run_login_verify_workflow
