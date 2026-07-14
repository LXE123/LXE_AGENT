"""Repository structure contracts.

The top-level layout answers one question per directory: which runtime world
does this belong to (Bun process / Python lxeskill closure / frontend /
assets / state)? These tests freeze that layout and the env naming rule so
drift shows up in review instead of months later.

Changing the frozen sets is allowed — do it together with a dated entry in
docs/record explaining the structure decision.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

ALLOWED_TOP_LEVEL_DIRECTORIES = {
    # TS world
    "apps",
    "packages",
    "web",
    # Python world (planned to consolidate under python/ in a later batch)
    "browser_auth_service",
    "clients",
    "py_tools",
    "services",
    "shared",
    "tests",
    # Assets and supporting material
    "skills",
    "config",
    "data",
    "docs",
    "scripts",
}

# Frozen on 2026-07-14. New runtime configuration must use the LXE_ prefix
# (domain-scoped keys use a second segment, e.g. LXE_MABANG_*). Removing a
# legacy key is always allowed; never add to this list.
LEGACY_RUNTIME_ENV_KEYS = {
    "AGENT_DASHBOARD_ENABLED",
    "AGENT_DASHBOARD_HOST",
    "AGENT_DASHBOARD_OPEN_BROWSER",
    "AGENT_DASHBOARD_PORT",
    "AGENT_DASHBOARD_PORT_AUTO_FALLBACK",
    "AGENT_LLM_MAX_TOKENS",
    "AGENT_LLM_MODEL",
    "AGENT_LLM_PROVIDER",
    "AGENT_LLM_THINKING_DISPLAY",
    "AGENT_LLM_THINKING_EFFORT",
    "AGENT_LLM_THINKING_ENABLED",
    "AGENT_MAX_CONCURRENCY",
    "AGENT_SSE_WIRE_TRACE_DIR",
    "AGENT_SSE_WIRE_TRACE_ENABLED",
    "AGENT_STREAM_DEBUG_PREVIEW_CHARS",
    "AGENT_STREAM_HEARTBEAT_CHARS",
    "AGENT_STREAM_HEARTBEAT_MS",
    "AGENT_STREAM_LOG_MODE",
    "AGENT_STREAM_TRACE_DIR",
    "AGENT_STREAM_TRACE_ENABLED",
    "BROWSER_AUTH_FORCE_COOLDOWN_SECONDS",
    "BROWSER_AUTH_HEADLESS",
    "BROWSER_AUTH_LOCK_TIMEOUT_SECONDS",
    "BROWSER_AUTH_LOG_FILE",
    "FBA_DELIVERY_CSV_DIR",
    "FBA_LOGISTICS_ENABLE_WMS_EXPORT",
    "FBA_LOGISTICS_TOKEN_HEADLESS",
    "FBA_LOGISTICS_WMS_EXPORT_RETRY",
    "FBA_LOGISTICS_WMS_EXPORT_STRICT",
    "FEISHU_RAW_EVENT_DUMP_DIR",
    "FEISHU_RAW_EVENT_DUMP_ENABLED",
    "LLM_REQUEST_TIMEOUT_S",
    "LOCAL_LOGS_ENABLED",
    "LOCAL_LOG_RETENTION_DAYS",
    "LOGISTICS_API_TIMEOUT_SECONDS",
    "LOGISTICS_IMPORT_MAX_POLLS",
    "LOGISTICS_IMPORT_POLL_INTERVAL_SECONDS",
    "LOGISTICS_LOCAL_API_BASE_URL",
    "LOGISTICS_REMOTE_API_BASE_URL",
    "LOGISTICS_USE_REMOTE_API",
    "LOG_CONSOLE_FORMAT",
    "LOG_FILE",
    "LOG_FORMAT",
    "LOG_LEVEL",
    "LOG_LEVELS",
    "MABANG_FBA_STORE_RESOLVER_OUTPUT_DIR",
    "MABANG_FBA_UNLINKED_SHIPMENTS_OUTPUT_DIR",
    "MABANG_MSKU_DETAIL_OUTPUT_DIR",
    "MABANG_STOCK_SKU_EXPORT_DIR",
    "MABANG_STORE_MSKU_ANALYSIS_OUTPUT_DIR",
    "MABANG_STORE_MSKU_INVENTORY_OUTPUT_DIR",
    "MABANG_STORE_MSKU_OUTPUT_DIR",
    "MABANG_STORE_MSKU_REPLENISHMENT_OUTPUT_DIR",
    "RUNTIME_LOG_LEVEL",
    "ZINIAO_BROWSER_VERSION",
    "ZINIAO_CLIENT_PATH",
    "ZINIAO_DIAGNOSTIC_TRACE_DIR",
    "ZINIAO_DIAGNOSTIC_TRACE_ENABLED",
    "ZINIAO_REGISTER_PLANNER_TOOLS",
    "ZINIAO_SOCKET_PORT",
    "ZINIAO_WEBDRIVER_PATH",
}


def _tracked_top_level_directories() -> set[str]:
    output = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    ).stdout.decode("utf-8")
    return {
        path.split("/", 1)[0]
        for path in output.split("\0")
        if path and "/" in path
    }


def _runtime_env_keys() -> set[str]:
    keys: set[str] = set()
    for line in (REPO_ROOT / "config" / "runtime.env").read_text("utf-8").splitlines():
        match = re.match(r"([A-Z][A-Z0-9_]*)=", line.strip())
        if match:
            keys.add(match.group(1))
    return keys


def test_top_level_directories_stay_in_the_frozen_set() -> None:
    unexpected = _tracked_top_level_directories() - ALLOWED_TOP_LEVEL_DIRECTORIES
    assert unexpected == set(), (
        "new top-level directories need a structure decision in docs/record "
        f"before extending the frozen set: {sorted(unexpected)}"
    )


def test_new_runtime_env_keys_use_the_lxe_prefix() -> None:
    added = _runtime_env_keys() - LEGACY_RUNTIME_ENV_KEYS
    offenders = sorted(key for key in added if not key.startswith("LXE_"))
    assert offenders == [], (
        "new runtime env keys must use the LXE_ prefix "
        f"(legacy prefixes are frozen): {offenders}"
    )
