from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .errors import ZhihuiTmsApiError, ZhihuiTmsSchemaError


@dataclass(frozen=True)
class LoginResult:
    api_token: str
    user_id: str | None
    supplier_id: str | None
    customer_id: str | None
    role_id: str | None


def _optional_identifier(data: Mapping[str, Any], key: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if isinstance(value, (str, int)) and str(value).strip():
        return str(value)
    raise ZhihuiTmsSchemaError(
        "tms_login_schema_invalid",
        f"登录响应 data.{key} 必须是非空字符串或整数",
        payload=data,
    )


def parse_login_response(
    payload: Any,
    *,
    http_status: int = 200,
    secrets: Sequence[str] = (),
) -> LoginResult:
    if not isinstance(payload, Mapping):
        raise ZhihuiTmsSchemaError(
            "tms_login_schema_invalid",
            "登录响应必须是 JSON object",
            http_status=http_status,
            payload=payload,
            secrets=secrets,
        )

    if payload.get("code") != "200":
        observed_message = str(payload.get("msg") or f"登录响应 code={payload.get('code')!r}")
        raise ZhihuiTmsApiError(
            "tms_login_business_error",
            observed_message,
            http_status=http_status,
            payload=payload,
            secrets=secrets,
        )

    data = payload.get("data")
    if not isinstance(data, Mapping):
        raise ZhihuiTmsSchemaError(
            "tms_login_schema_invalid",
            "登录响应 data 必须是 JSON object",
            http_status=http_status,
            payload=payload,
            secrets=secrets,
        )

    api_token = data.get("apiToken")
    if not isinstance(api_token, str) or not api_token.strip():
        raise ZhihuiTmsSchemaError(
            "tms_login_schema_invalid",
            "登录响应 data.apiToken 必须存在且非空",
            http_status=http_status,
            payload=payload,
            secrets=secrets,
        )

    return LoginResult(
        api_token=api_token.strip(),
        user_id=_optional_identifier(data, "id"),
        supplier_id=_optional_identifier(data, "supplierId"),
        customer_id=_optional_identifier(data, "customerId"),
        role_id=_optional_identifier(data, "roleId"),
    )


__all__ = ["LoginResult", "parse_login_response"]
