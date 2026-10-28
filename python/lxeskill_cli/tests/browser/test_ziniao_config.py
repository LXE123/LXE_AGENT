from services.browser.store import ziniao_config


def test_planner_tool_visibility_follows_configuration(monkeypatch) -> None:
    for enabled in (False, True):
        monkeypatch.setattr(ziniao_config, "ZINIAO_REGISTER_PLANNER_TOOLS", enabled)
        assert ziniao_config.is_ziniao_planner_tools_enabled() is enabled
