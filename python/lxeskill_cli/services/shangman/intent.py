from __future__ import annotations

from typing import Any


PLATFORM = "上马印尼"
COUNTRY = "印尼"
OPERATION = "goods_export"
PARAM_KEYS = frozenset({"platform", "country", "operation"})

SOURCE_NOTICE = "该文件保留平台原始商品导出字段，不包含逐日销量、14天销量或历史月末快照。"


def _error(code: str, message: str, *, recoverable: bool) -> dict[str, Any]:
    return {"code": code, "message": message, "recoverable": recoverable}


def _invalid(message: str) -> dict[str, Any]:
    return {"status": "blocked", "error": _error("params_invalid", message, recoverable=True)}


def _string(value: Any) -> str:
    return str(value or "").strip()


def _normalize_params(raw_params: Any) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not isinstance(raw_params, dict):
        return None, _invalid("params must be an object")
    extras = sorted(set(raw_params) - PARAM_KEYS)
    if extras:
        return None, _invalid(f"params contains unsupported fields: {', '.join(extras)}")

    platform = _string(raw_params.get("platform"))
    country = _string(raw_params.get("country"))
    operation = _string(raw_params.get("operation"))
    if platform != PLATFORM:
        return None, _invalid(f"params.platform must be {PLATFORM}")
    if country != COUNTRY:
        return None, _invalid(f"params.country must be {COUNTRY}")
    if operation != OPERATION:
        return None, _invalid(f"params.operation must be {OPERATION}")

    return {
        "platform": platform,
        "country": country,
        "operation": operation,
    }, None


def build_goods_export_plan(params: Any) -> dict[str, Any]:
    normalized_params, error = _normalize_params(params)
    if error is not None:
        return error
    assert normalized_params is not None
    return {
        "status": "ready",
        "params": normalized_params,
        "intent": {
            "type": "goods-export",
            "platform": PLATFORM,
            "country": COUNTRY,
            "operation": OPERATION,
            "params": normalized_params,
        },
        "plan": {
            "type": "goods-export",
            "tasks": [{"type": "goods-export", "params": normalized_params}],
            "source_notice": SOURCE_NOTICE,
        },
    }


__all__ = [
    "COUNTRY",
    "OPERATION",
    "PLATFORM",
    "SOURCE_NOTICE",
    "PARAM_KEYS",
    "build_goods_export_plan",
]
