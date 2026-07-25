from __future__ import annotations

from pathlib import Path

from shared.repository import repository_root


SECRET_ENV_KEYS = {
    "DEEPSEEK_API",
    "FEISHU_APP_SECRET",
    "GLM_API_KEY",
    "KIMI_CODE_API_KEY",
    "LXE_DATA_SERVER_API_KEY",
    "LXE_DATA_SERVER_FALLBACK_API_KEY",
    "LXE_ERP_API_KEY",
    "MABANG_PASSWORD",
    "ZINIAO_PASSWORD",
}

NON_SECRET_SETTINGS_KEYS = {
    "AGENT_LLM_MODEL",
    "AGENT_LLM_PROVIDER",
    "AGENT_LLM_THINKING_ENABLED",
    "AGENT_LLM_THINKING_EFFORT",
    "FEISHU_APP_ID",
    "LOCAL_LOGS_ENABLED",
    "MABANG_ACCOUNT",
    "MABANG_FBA_STORE_RESOLVER_OUTPUT_DIR",
    "MABANG_FBA_UNLINKED_SHIPMENTS_OUTPUT_DIR",
    "MABANG_MSKU_DETAIL_OUTPUT_DIR",
    "MABANG_STOCK_SKU_EXPORT_DIR",
    "MABANG_STORE_MSKU_ANALYSIS_OUTPUT_DIR",
    "MABANG_STORE_MSKU_INVENTORY_OUTPUT_DIR",
    "MABANG_STORE_MSKU_OUTPUT_DIR",
    "MABANG_STORE_MSKU_REPLENISHMENT_OUTPUT_DIR",
    "FBA_DELIVERY_CSV_DIR",
    "ZINIAO_CLIENT_PATH",
    "ZINIAO_COMPANY",
    "ZINIAO_USERNAME",
}


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


def test_python_runtime_does_not_load_dotenv_files() -> None:
    root = repository_root()
    assert not (root / "python" / "lxeskill_cli" / "shared" / "env_files.py").exists()
    env_config = (root / "python" / "lxeskill_cli" / "shared" / "env_config.py").read_text(encoding="utf-8")
    assert "load_project_env" not in env_config
    assert ".env.local" not in env_config
    assert "runtime.env" not in env_config


def test_only_secret_development_template_remains() -> None:
    root = repository_root()
    example_keys = _env_keys(root / ".env.example")

    assert not (root / ".env.local.example").exists()
    assert not (root / "config" / "runtime.env").exists()
    assert example_keys == SECRET_ENV_KEYS
    assert NON_SECRET_SETTINGS_KEYS.isdisjoint(example_keys)
