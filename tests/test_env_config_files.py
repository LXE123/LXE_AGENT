from __future__ import annotations

from pathlib import Path

import shared.env as project_env


PRIVATE_ENV_KEYS = {
    "DEEPSEEK_API",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_BOT_OPEN_ID",
    "GATEWAY_ID",
    "GLM_API_KEY",
    "KIMI_API_KEY",
    "KIMI_CODE_API_KEY",
    "LXE_DATA_SERVER_API_KEY",
    "MABANG_ACCOUNT",
    "MABANG_PASSWORD",
    "ZINIAO_COMPANY",
    "ZINIAO_PASSWORD",
    "ZINIAO_USERNAME",
}


def _write_env(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    return path


def _env_keys(path: Path) -> set[str]:
    keys: set[str] = set()
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        name, _ = line.split("=", 1)
        keys.add(name.strip())
    return keys


def test_project_env_loads_secret_local_and_runtime_layers(monkeypatch, tmp_path: Path) -> None:
    env_path = _write_env(
        tmp_path / ".env",
        "FROM_ENV=env\n"
        "FROM_SYSTEM=env\n",
    )
    local_path = _write_env(
        tmp_path / ".env.local",
        "FROM_LOCAL=local\n"
        "FROM_ENV=local\n"
        "FROM_SYSTEM=local\n",
    )
    runtime_path = _write_env(
        tmp_path / "runtime.env",
        "FROM_RUNTIME=runtime\n"
        "FROM_LOCAL=runtime\n"
        "FROM_ENV=runtime\n"
        "FROM_SYSTEM=runtime\n",
    )
    for key in ("FROM_RUNTIME", "FROM_LOCAL", "FROM_ENV", "FROM_SYSTEM"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("FROM_SYSTEM", "system")
    monkeypatch.setattr(project_env, "_ENV_LOADED", False)

    project_env.load_project_env(env_path, local_path=local_path, runtime_path=runtime_path)

    assert project_env.os.environ["FROM_RUNTIME"] == "runtime"
    assert project_env.os.environ["FROM_LOCAL"] == "local"
    assert project_env.os.environ["FROM_ENV"] == "env"
    assert project_env.os.environ["FROM_SYSTEM"] == "system"


def test_project_env_custom_path_uses_adjacent_local_and_runtime_defaults(monkeypatch, tmp_path: Path) -> None:
    env_path = _write_env(tmp_path / ".env", "CUSTOM_FROM_ENV=env\n")
    _write_env(tmp_path / ".env.local", "CUSTOM_FROM_LOCAL=local\n")
    runtime_dir = tmp_path / "config"
    runtime_dir.mkdir()
    _write_env(runtime_dir / "runtime.env", "CUSTOM_FROM_RUNTIME=runtime\n")
    for key in ("CUSTOM_FROM_ENV", "CUSTOM_FROM_LOCAL", "CUSTOM_FROM_RUNTIME"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(project_env, "_ENV_LOADED", False)

    project_env.load_project_env(env_path)

    assert project_env.os.environ["CUSTOM_FROM_ENV"] == "env"
    assert project_env.os.environ["CUSTOM_FROM_LOCAL"] == "local"
    assert project_env.os.environ["CUSTOM_FROM_RUNTIME"] == "runtime"


def test_project_local_config_upsert_preserves_existing_content(tmp_path: Path) -> None:
    local_path = tmp_path / ".env.local"
    local_path.write_text(
        "# local runtime overrides\n"
        "export AGENT_LLM_THINKING_ENABLED=0\n",
        encoding="utf-8",
    )

    project_env.upsert_project_local_config_values(
        {
            "AGENT_LLM_THINKING_ENABLED": "1",
            "AGENT_LLM_THINKING_EFFORT": "low",
        },
        path=local_path,
    )

    assert local_path.read_text(encoding="utf-8") == (
        "# local runtime overrides\n"
        "export AGENT_LLM_THINKING_ENABLED=1\n"
        "AGENT_LLM_THINKING_EFFORT=low\n"
    )


def test_runtime_config_keeps_private_values_out_of_git_tracked_defaults() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime_keys = _env_keys(root / "config" / "runtime.env")
    example_keys = _env_keys(root / ".env.example")

    assert PRIVATE_ENV_KEYS.isdisjoint(runtime_keys)
    assert runtime_keys.isdisjoint(example_keys)
    assert {
        "AGENT_LLM_MODEL",
        "AGENT_LLM_PROVIDER",
        "AGENT_LLM_THINKING_ENABLED",
        "LOCAL_LOGS_ENABLED",
    }.issubset(runtime_keys)
    assert {
        "FEISHU_APP_ID",
        "FEISHU_APP_SECRET",
        "KIMI_CODE_API_KEY",
        "MABANG_PASSWORD",
        "ZINIAO_PASSWORD",
    }.issubset(example_keys)
