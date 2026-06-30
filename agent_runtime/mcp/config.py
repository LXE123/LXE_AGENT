from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import yaml


MCP_CONFIG_PATH_ENV = "LXE_MCP_CONFIG_PATH"
MCP_TOOL_SEARCH_ENABLED_ENV = "LXE_MCP_TOOL_SEARCH_ENABLED"
_SERVER_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_ENV_PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")

TransportKind = Literal["stdio", "streamable-http"]
ExposureKind = Literal["direct", "deferred", "auto"]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_mcp_config_path() -> Path:
    return _repo_root() / "config" / "mcp_servers.local.yaml"


def mcp_config_path(path: str | Path | None = None) -> Path:
    if path is not None:
        return Path(path).expanduser()
    configured = str(os.getenv(MCP_CONFIG_PATH_ENV, "") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return default_mcp_config_path()


def mcp_tool_search_enabled() -> bool:
    raw = str(os.getenv(MCP_TOOL_SEARCH_ENABLED_ENV, "1") or "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


@dataclass(frozen=True)
class McpServerConfig:
    name: str
    enabled: bool = True
    transport: TransportKind = "stdio"
    command: str = ""
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    cwd: str = ""
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    env_headers: dict[str, str] = field(default_factory=dict)
    bearer_token_env_var: str = ""
    startup_timeout_s: float = 10.0
    tool_timeout_s: float = 60.0
    enabled_tools: frozenset[str] | None = None
    disabled_tools: frozenset[str] = field(default_factory=frozenset)
    exposure: ExposureKind = "deferred"
    connector_id: str = ""
    connector_name: str = ""
    connector_description: str = ""

    def allows_tool(self, raw_tool_name: str) -> bool:
        safe_name = str(raw_tool_name or "").strip()
        if self.enabled_tools is not None and safe_name not in self.enabled_tools:
            return False
        return safe_name not in self.disabled_tools


@dataclass(frozen=True)
class McpConfig:
    servers: tuple[McpServerConfig, ...] = ()

    def enabled_servers(self) -> tuple[McpServerConfig, ...]:
        return tuple(server for server in self.servers if server.enabled)


def _as_mapping(value: Any, *, field_name: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise RuntimeError(f"{field_name} must be a mapping")
    return dict(value)


def _as_str_dict(value: Any, *, field_name: str) -> dict[str, str]:
    data = _as_mapping(value, field_name=field_name)
    return {
        str(key or "").strip(): str(item or "")
        for key, item in data.items()
        if str(key or "").strip()
    }


def _as_str_tuple(value: Any, *, field_name: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise RuntimeError(f"{field_name} must be a list")
    return tuple(str(item or "") for item in value)


def _as_tool_filter(value: Any, *, field_name: str) -> frozenset[str] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise RuntimeError(f"{field_name} must be a list")
    return frozenset(str(item or "").strip() for item in value if str(item or "").strip())


def _as_float(value: Any, *, field_name: str, default: float) -> float:
    if value in (None, ""):
        return default
    try:
        parsed = float(value)
    except Exception as exc:
        raise RuntimeError(f"{field_name} must be a number") from exc
    if parsed <= 0:
        raise RuntimeError(f"{field_name} must be greater than 0")
    return parsed


def _as_bool(value: Any, *, field_name: str, default: bool) -> bool:
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{field_name} must be a boolean")


def _normalize_transport(raw: Any) -> TransportKind:
    text = str(raw or "").strip().lower().replace("_", "-")
    if text in {"", "stdio"}:
        return "stdio"
    if text in {"streamable-http", "streamable_http", "http"}:
        return "streamable-http"
    raise RuntimeError(f"unsupported MCP transport: {raw}")


def _normalize_exposure(raw: Any) -> ExposureKind:
    text = str(raw or "deferred").strip().lower()
    if text in {"direct", "deferred", "auto"}:
        return text  # type: ignore[return-value]
    raise RuntimeError(f"unsupported MCP exposure: {raw}")


def _validate_server_name(name: str) -> str:
    safe_name = str(name or "").strip()
    if not safe_name:
        raise RuntimeError("MCP server name is required")
    if not _SERVER_NAME_RE.fullmatch(safe_name):
        raise RuntimeError(
            f"invalid MCP server name {safe_name!r}: must match {_SERVER_NAME_RE.pattern}"
        )
    return safe_name


def _server_config_from_mapping(name: str, raw_config: Any) -> McpServerConfig:
    data = _as_mapping(raw_config, field_name=f"mcpServers.{name}")
    safe_name = _validate_server_name(name)
    transport = _normalize_transport(data.get("transport", data.get("type")))
    enabled_tools = _as_tool_filter(data.get("enabled_tools", data.get("enabledTools")), field_name=f"{safe_name}.enabled_tools")
    disabled_tools = _as_tool_filter(data.get("disabled_tools", data.get("disabledTools")), field_name=f"{safe_name}.disabled_tools")

    return McpServerConfig(
        name=safe_name,
        enabled=_as_bool(data.get("enabled"), field_name=f"{safe_name}.enabled", default=True),
        transport=transport,
        command=str(data.get("command") or "").strip(),
        args=_as_str_tuple(data.get("args"), field_name=f"{safe_name}.args"),
        env=_as_str_dict(data.get("env"), field_name=f"{safe_name}.env"),
        cwd=str(data.get("cwd") or "").strip(),
        url=str(data.get("url") or "").strip(),
        headers=_as_str_dict(data.get("headers"), field_name=f"{safe_name}.headers"),
        env_headers=_as_str_dict(
            data.get("env_headers", data.get("envHttpHeaders", data.get("env_http_headers"))),
            field_name=f"{safe_name}.env_headers",
        ),
        bearer_token_env_var=str(
            data.get("bearer_token_env_var", data.get("bearerTokenEnvVar")) or ""
        ).strip(),
        startup_timeout_s=_as_float(
            data.get("startup_timeout_s", data.get("startupTimeoutS")),
            field_name=f"{safe_name}.startup_timeout_s",
            default=10.0,
        ),
        tool_timeout_s=_as_float(
            data.get("tool_timeout_s", data.get("toolTimeoutS")),
            field_name=f"{safe_name}.tool_timeout_s",
            default=60.0,
        ),
        enabled_tools=enabled_tools,
        disabled_tools=disabled_tools or frozenset(),
        exposure=_normalize_exposure(data.get("exposure")),
        connector_id=str(data.get("connector_id", data.get("connectorId")) or "").strip(),
        connector_name=str(data.get("connector_name", data.get("connectorName")) or "").strip(),
        connector_description=str(
            data.get("connector_description", data.get("connectorDescription")) or ""
        ).strip(),
    )


def load_mcp_config(path: str | Path | None = None) -> McpConfig:
    config_path = mcp_config_path(path)
    try:
        raw_text = config_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return McpConfig()
    try:
        raw_data = yaml.safe_load(raw_text) or {}
    except Exception as exc:
        raise RuntimeError(f"MCP config is not valid YAML: {config_path}") from exc
    root = _as_mapping(raw_data, field_name="MCP config")
    raw_servers = root.get("mcpServers", root.get("servers", {}))
    servers_map = _as_mapping(raw_servers, field_name="mcpServers")
    servers = tuple(
        _server_config_from_mapping(name, raw_server)
        for name, raw_server in sorted(servers_map.items(), key=lambda item: str(item[0]).casefold())
    )
    return McpConfig(servers=servers)


def resolve_env_placeholders(value: str, *, field_name: str) -> str:
    def _replace(match: re.Match[str]) -> str:
        env_name = match.group(1)
        resolved = os.getenv(env_name)
        if resolved is None or resolved == "":
            raise RuntimeError(f"environment variable {env_name} for {field_name} is not set")
        return resolved

    return _ENV_PLACEHOLDER_RE.sub(_replace, str(value or ""))


def resolve_server_headers(server: McpServerConfig) -> dict[str, str]:
    headers = {
        key: resolve_env_placeholders(value, field_name=f"{server.name}.headers.{key}")
        for key, value in server.headers.items()
    }
    for header_name, env_name in server.env_headers.items():
        value = os.getenv(env_name)
        if value is None or value == "":
            raise RuntimeError(
                f"environment variable {env_name} for {server.name}.env_headers.{header_name} is not set"
            )
        headers[header_name] = value
    if server.bearer_token_env_var:
        token = os.getenv(server.bearer_token_env_var)
        if token is None or token == "":
            raise RuntimeError(
                f"environment variable {server.bearer_token_env_var} for {server.name}.bearer_token_env_var is not set"
            )
        headers["Authorization"] = f"Bearer {token}"
    return headers


__all__ = [
    "MCP_CONFIG_PATH_ENV",
    "MCP_TOOL_SEARCH_ENABLED_ENV",
    "McpConfig",
    "McpServerConfig",
    "default_mcp_config_path",
    "load_mcp_config",
    "mcp_config_path",
    "mcp_tool_search_enabled",
    "resolve_env_placeholders",
    "resolve_server_headers",
]
