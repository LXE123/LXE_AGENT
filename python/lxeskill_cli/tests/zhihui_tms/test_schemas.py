from __future__ import annotations

import pytest

from services.zhihui_tms.errors import ZhihuiTmsApiError, ZhihuiTmsSchemaError
from services.zhihui_tms.schemas import LoginResult, parse_login_response


def test_parse_login_response_returns_only_validated_login_fields() -> None:
    result = parse_login_response(
        {
            "code": "200",
            "msg": "成功",
            "data": {
                "id": 12,
                "supplierId": 34,
                "customerId": 56,
                "roleId": 78,
                "apiToken": "fixture-api-token",
            },
        }
    )

    assert result == LoginResult(
        api_token="fixture-api-token",
        user_id="12",
        supplier_id="34",
        customer_id="56",
        role_id="78",
    )


@pytest.mark.parametrize(
    ("payload", "expected_fragment"),
    [
        ({"code": "200", "data": {}}, "apiToken"),
        ({"code": "200", "data": {"apiToken": "  "}}, "apiToken"),
        ({"code": "200", "data": {"apiToken": 123}}, "apiToken"),
    ],
)
def test_parse_login_response_rejects_missing_or_invalid_token(
    payload: dict,
    expected_fragment: str,
) -> None:
    with pytest.raises(ZhihuiTmsSchemaError, match=expected_fragment):
        parse_login_response(payload)


def test_parse_login_response_maps_observed_business_error_without_guessing() -> None:
    with pytest.raises(ZhihuiTmsApiError) as captured:
        parse_login_response(
            {
                "code": "4010",
                "msg": "账号或密码错误，请重新输入",
                "data": None,
            }
        )

    assert captured.value.code == "tms_login_business_error"
    assert captured.value.http_status == 200
    assert "账号或密码错误" in str(captured.value)


def test_schema_error_redacts_sensitive_payload_values_and_truncates_observed_text() -> None:
    payload = {
        "code": "500",
        "msg": "upstream detail " + ("x" * 5_000),
        "data": {
            "apiToken": "fixture-api-token",
            "password": "fixture-password",
            "Cookie": "JSESSIONID=fixture-session",
        },
    }

    with pytest.raises(ZhihuiTmsApiError) as captured:
        parse_login_response(payload)

    serialized = str(captured.value) + repr(captured.value.payload)
    assert "fixture-api-token" not in serialized
    assert "fixture-password" not in serialized
    assert "fixture-session" not in serialized
    assert "[REDACTED]" in serialized
    assert "[truncated " in serialized


def test_parse_login_response_rejects_non_object_payload() -> None:
    with pytest.raises(ZhihuiTmsSchemaError, match="JSON object"):
        parse_login_response(["not", "an", "object"])
