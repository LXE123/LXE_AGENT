"""Shopee 关键词命令的共享设施：凭据解析、默认关键词存储、国家配置。

凭据永远不写入仓库；解析顺序为环境变量优先、本地配置文件兜底：

- ``LXE_HAIYING_USERNAME`` / ``LXE_HAIYING_PASSWORD``
- ``<var>/lxeskill/shopee/haiying_credentials.json``，形如
  ``{"username": "...", "password": "..."}``（var 目录已被 gitignore）

默认关键词持久化在 ``<var>/lxeskill/shopee/default_keywords.json``，
同样是本地状态文件，不进 Git。
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from shared.env_config import env_text
from shared.workspace import internal_root


class CredentialsNotConfiguredError(RuntimeError):
    """海鹰账号凭据未配置。"""


CREDENTIALS_ENV_USERNAME = "LXE_HAIYING_USERNAME"
CREDENTIALS_ENV_PASSWORD = "LXE_HAIYING_PASSWORD"

COUNTRIES: list[dict[str, Any]] = [
    {"name": "越南", "code": 7, "aliases": ["Vietnam", "VN"]},
    {"name": "泰国", "code": 3, "aliases": ["Thailand", "TH"]},
    {"name": "印尼", "code": 2, "aliases": ["印度尼西亚", "Indonesia", "ID"]},
    {"name": "巴西", "code": 8, "aliases": ["Brazil", "BR"]},
    {"name": "马来西亚", "code": 1, "aliases": ["马来", "Malaysia", "MY"]},
    {"name": "台湾", "code": 5, "aliases": ["Taiwan", "TW"]},
    {"name": "菲律宾", "code": 4, "aliases": ["Philippines", "PH"]},
    {"name": "新加坡", "code": 6, "aliases": ["Singapore", "SG"]},
    {"name": "墨西哥", "code": 11, "aliases": ["Mexico", "MX"]},
]

DEFAULT_KEYWORDS: list[str] = [
    "strap",
    "band",
    "case",
    "cover",
    "charger",
    "smartwatch",
    "smart watch",
    "iwatch",
    "apple watch",
    "mi band",
    "miband",
    "xiaomi band",
    "redmi watch",
    "xiaomi watch",
    "mi watch",
    "garmin",
    "huawei band",
    "huawei watch fit",
    "huawei fit",
    "huawei watch",
    "huawei gt",
    "amazfit",
    "samsung fit",
    "samsung galaxy watch",
    "galaxy watch",
    "samsung watch",
    "google",
]


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def state_dir() -> Path:
    return internal_root() / "shopee"


def credentials_path() -> Path:
    return state_dir() / "haiying_credentials.json"


def default_keywords_path() -> Path:
    return state_dir() / "default_keywords.json"


def resolve_credentials() -> tuple[str, str, str]:
    """返回 (username, password, source)；未配置时抛出带配置指引的异常。"""
    username = env_text(CREDENTIALS_ENV_USERNAME)
    password = env_text(CREDENTIALS_ENV_PASSWORD)
    if username and password:
        return username, password, "env"

    path = credentials_path()
    if path.is_file():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            username = str(payload.get("username") or "").strip()
            password = str(payload.get("password") or "").strip()
        except (OSError, ValueError) as exc:
            raise CredentialsNotConfiguredError(
                f"海鹰凭据配置文件读取失败：{path}（{exc}）"
            ) from exc
        if username and password:
            return username, password, "config_file"

    raise CredentialsNotConfiguredError(
        "海鹰账号凭据未配置。请设置环境变量 "
        f"{CREDENTIALS_ENV_USERNAME}/{CREDENTIALS_ENV_PASSWORD}，"
        f"或写入本地配置文件 {path}（格式：{{\"username\": \"...\", \"password\": \"...\"}}）。"
    )


def unique_nonempty(values: Iterable[Any]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = str(value).strip().strip("\"'")
        identity = cleaned.casefold()
        if cleaned and identity not in seen:
            seen.add(identity)
            output.append(cleaned)
    return output


def load_default_keywords() -> tuple[list[str], str]:
    """返回 (关键词列表, source)；source 为 stored / builtin。"""
    path = default_keywords_path()
    if not path.is_file():
        return list(DEFAULT_KEYWORDS), "builtin"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        values = payload.get("keywords") if isinstance(payload, dict) else payload
        if not isinstance(values, list):
            raise ValueError("keywords 必须是列表")
        keywords = unique_nonempty(values)
        if not keywords:
            raise ValueError("关键词列表为空")
        return keywords, "stored"
    except (OSError, ValueError, json.JSONDecodeError):
        return list(DEFAULT_KEYWORDS), "builtin"


def save_default_keywords(values: Iterable[Any]) -> list[str]:
    """原子保存用户更新的默认关键词。"""
    keywords = unique_nonempty(values)
    if not keywords:
        raise ValueError("没有可保存的关键词")

    path = default_keywords_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "keywords": keywords,
        "updated_at": _now_iso(),
        "note": "Updated via lxeskill shopee keywords config.",
    }
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    try:
        temporary_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary_path.replace(path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    return keywords


def keywords_state() -> dict[str, Any]:
    """供 config 查询：当前词表、来源与更新时间。"""
    path = default_keywords_path()
    keywords, source = load_default_keywords()
    updated_at = ""
    if source == "stored":
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            updated_at = str(payload.get("updated_at") or "")
        except (OSError, ValueError, json.JSONDecodeError):
            updated_at = ""
    return {
        "keywords": keywords,
        "source": source,
        "updated_at": updated_at,
        "path": str(path),
    }


def _normalize_country_key(value: Any) -> str:
    return re.sub(r"\s+", "", str(value)).casefold()


def _country_lookup() -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    for country in COUNTRIES:
        normalized = {"name": str(country["name"]), "code": int(country["code"])}
        keys = [
            normalized["name"],
            str(normalized["code"]),
            *[str(alias) for alias in country.get("aliases", [])],
        ]
        for key in keys:
            lookup[_normalize_country_key(key)] = normalized
    return lookup


def resolve_country(value: str) -> dict[str, Any]:
    """把国家名/别名/代码或 `名称:代码` 解析为 {name, code}。"""
    cleaned = str(value).strip()
    explicit_match = re.fullmatch(r"(.+?)\s*[:：]\s*(\d+)", cleaned)
    if explicit_match:
        return {
            "name": explicit_match.group(1).strip(),
            "code": int(explicit_match.group(2)),
        }
    resolved = _country_lookup().get(_normalize_country_key(cleaned))
    if not resolved:
        raise ValueError(
            f"无法识别国家 {value!r}；配置外国家请使用“名称:代码”，例如 Chile:9"
        )
    return dict(resolved)


def resolve_countries(values: Iterable[Any] | None) -> list[dict[str, Any]]:
    """未指定时返回全部 9 个站点；按 code 去重。"""
    raw_values = unique_nonempty(values or [])
    candidates = [resolve_country(value) for value in raw_values] if raw_values else [
        {"name": str(country["name"]), "code": int(country["code"])}
        for country in COUNTRIES
    ]
    output: list[dict[str, Any]] = []
    seen_codes: set[int] = set()
    for country in candidates:
        code = int(country["code"])
        if code not in seen_codes:
            seen_codes.add(code)
            output.append({"name": str(country["name"]), "code": code})
    if not output:
        raise ValueError("国家列表为空")
    return output
