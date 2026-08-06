"""shopee 关键词命令的单元测试；全部离线，不访问真实海鹰接口。"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

import shared.workspace as workspace
from services.agent_cli.shopee import _shared as shopee_shared
from services.agent_cli.shopee import keyword_config, keyword_export, keyword_query
from services.agent_cli.shopee._shared import (
    CredentialsNotConfiguredError,
    load_default_keywords,
    resolve_countries,
    resolve_country,
    resolve_credentials,
    save_default_keywords,
)
from services.agent_cli.shopee.haiying_client import (
    LOGIN_AES_KEY,
    PAGE_SIZE,
    build_payload,
    encrypt_login_value,
    fetch_all_pages,
)
from services.agent_cli.shopee.report import (
    build_excel,
    query_report,
    verify_workbook,
)


@pytest.fixture()
def shopee_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """把 lxeskill 内部状态与产物根重定向到临时目录。"""
    internal = tmp_path / "lxeskill"
    artifacts = tmp_path / "artifacts"
    internal.mkdir()
    artifacts.mkdir()
    monkeypatch.setattr(workspace, "_internal_root", internal)
    monkeypatch.setattr(workspace, "_artifact_root", artifacts)
    monkeypatch.delenv("LXE_HAIYING_USERNAME", raising=False)
    monkeypatch.delenv("LXE_HAIYING_PASSWORD", raising=False)
    return tmp_path


def test_resolve_credentials_prefers_env(shopee_state: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LXE_HAIYING_USERNAME", "user-a")
    monkeypatch.setenv("LXE_HAIYING_PASSWORD", "secret-a")
    username, password, source = resolve_credentials()
    assert (username, password, source) == ("user-a", "secret-a", "env")


def test_resolve_credentials_falls_back_to_config_file(shopee_state: Path) -> None:
    path = shopee_shared.credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"username": "user-b", "password": "secret-b"}), encoding="utf-8")
    username, password, source = resolve_credentials()
    assert (username, password, source) == ("user-b", "secret-b", "config_file")


def test_resolve_credentials_missing_raises_with_guidance(shopee_state: Path) -> None:
    with pytest.raises(CredentialsNotConfiguredError) as excinfo:
        resolve_credentials()
    message = str(excinfo.value)
    assert "LXE_HAIYING_USERNAME" in message
    assert "haiying_credentials.json" in message


def test_keywords_set_get_roundtrip(shopee_state: Path) -> None:
    saved = save_default_keywords(["garmin", "Apple Watch", "garmin", "  ", "''"])
    assert saved == ["garmin", "Apple Watch"]
    state = shopee_shared.keywords_state()
    assert state["keywords"] == saved
    assert state["source"] == "stored"
    assert state["updated_at"]


def test_save_default_keywords_rejects_empty(shopee_state: Path) -> None:
    with pytest.raises(ValueError):
        save_default_keywords(["", "  "])


def test_load_default_keywords_falls_back_to_builtin_on_corrupt(shopee_state: Path) -> None:
    path = shopee_shared.default_keywords_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    keywords, source = load_default_keywords()
    assert source == "builtin"
    assert keywords == shopee_shared.DEFAULT_KEYWORDS


def test_resolve_country_aliases_and_explicit_code() -> None:
    assert resolve_country("泰国") == {"name": "泰国", "code": 3}
    assert resolve_country("Thailand") == {"name": "泰国", "code": 3}
    assert resolve_country("3") == {"name": "泰国", "code": 3}
    assert resolve_country("Chile:9") == {"name": "Chile", "code": 9}
    with pytest.raises(ValueError):
        resolve_country("亚特兰蒂斯")


def test_resolve_countries_defaults_to_all_and_dedupes() -> None:
    assert len(resolve_countries(None)) == 9
    resolved = resolve_countries(["泰国", "Thailand", "越南"])
    assert [item["code"] for item in resolved] == [3, 7]


def test_encrypt_login_value_roundtrips_with_platform_key() -> None:
    encrypted = encrypt_login_value("15180175431")
    decryptor = Cipher(algorithms.AES(LOGIN_AES_KEY), modes.ECB()).decryptor()
    padded = decryptor.update(base64.b64decode(encrypted)) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    assert unpadder.update(padded) + unpadder.finalize() == b"15180175431"


def test_build_payload_matches_platform_contract() -> None:
    payload = build_payload(3, "apple watch", 2)
    assert payload["country"] == 3
    assert payload["title"] == "apple watch"
    assert payload["index"] == 2
    assert payload["pageSize"] == PAGE_SIZE
    assert payload["searchType"] == 2
    assert payload["orderColumn"] == "search_volume"


class _FakeClient:
    """按预置分页数据响应的离线客户端。"""

    def __init__(self, pages: list[dict]) -> None:
        self.pages = pages
        self.requested_indexes: list[int] = []

    def request_page(self, payload: dict) -> dict:
        index = int(payload["index"])
        self.requested_indexes.append(index)
        return self.pages[index - 1]


def test_fetch_all_pages_walks_every_page_and_dedupes(monkeypatch: pytest.MonkeyPatch) -> None:
    pages = [
        {"code": 1, "keywordTotal": 3, "data": [{"keyword": "a", "search_volume": 100}, {"keyword": "b", "search_volume": 50}]},
        {"code": 1, "keywordTotal": 3, "data": [{"keyword": "b", "search_volume": 50}, {"keyword": "c", "search_volume": 10}]},
    ]
    import services.agent_cli.shopee.haiying_client as client_module

    monkeypatch.setattr(client_module, "PAGE_SIZE", 2)
    monkeypatch.setattr(client_module, "REQUEST_INTERVAL_SECONDS", 0)
    client = _FakeClient(pages)
    data, stats = fetch_all_pages(client, {"name": "泰国", "code": 3}, "kw")
    assert client.requested_indexes == [1, 2]
    assert data == {"a": 100, "b": 50, "c": 10}
    assert stats["unique_keywords"] == 3
    assert stats["pages"] == 2


def _sample_workbook(path: Path) -> None:
    combined = {
        "泰国(3)": {
            "apple watch": {"apple watch 9": 5000, "apple watch 8": 3000},
            "mi band": {"mi band 9": 4000},
        },
        "越南(7)": {
            "apple watch": {"apple watch": 8000},
            "mi band": {"mi band": 100},
        },
    }
    build_excel(path, combined)


def test_build_excel_then_query_roundtrip(tmp_path: Path) -> None:
    report = tmp_path / "report.xlsx"
    _sample_workbook(report)
    verify_workbook(report, 2)

    by_country = query_report(report, "泰国", None, 10)
    keywords = by_country["countries"]["泰国"]["keywords"]
    assert [item["keyword"] for item in keywords] == ["apple watch", "mi band"]
    assert keywords[0]["top"][0] == {"search_word": "apple watch 9", "volume": 5000}

    by_keyword = query_report(report, None, "APPLE WATCH", 1)
    assert by_keyword["countries"]["越南"]["keywords"][0]["top"] == [
        {"search_word": "apple watch", "volume": 8000}
    ]
    assert by_keyword["countries"]["泰国"]["keywords"][0]["rows"] == 2

    missing = query_report(report, "不存在国", None, 10)
    assert missing["countries"]["不存在国"] == {"error": "Sheet 不存在"}


def test_verify_workbook_rejects_sheet_mismatch(tmp_path: Path) -> None:
    report = tmp_path / "report.xlsx"
    _sample_workbook(report)
    with pytest.raises(RuntimeError):
        verify_workbook(report, 3)


def test_query_command_reports_missing_report(shopee_state: Path) -> None:
    result = keyword_query.run({"top": 10})
    assert result["success"] is False
    assert result["error_kind"] == "report_missing"
    assert "export" in result["exception"]


def test_query_command_reads_report(shopee_state: Path) -> None:
    from shared.datasets import dataset_dir

    report = dataset_dir("shopee_keyword_search", "海鹰Shopee关键词搜索量_全量.xlsx")
    _sample_workbook(report)
    listed = keyword_query.run({"list_countries": True})
    assert listed["success"] is True
    assert listed["countries"] == ["泰国", "越南"]
    result = keyword_query.run({"country": "越南", "top": 1})
    assert result["success"] is True
    assert result["countries"]["越南"]["keywords"][0]["top"] == [
        {"search_word": "apple watch", "volume": 8000}
    ]


def test_config_command_set_then_get(shopee_state: Path) -> None:
    set_result = keyword_config.run({"action": "set", "keywords": ["garmin", "iwatch"]})
    assert set_result["success"] is True
    assert set_result["count"] == 2
    get_result = keyword_config.run({"action": "get"})
    assert get_result["keywords"] == ["garmin", "iwatch"]
    assert get_result["source"] == "stored"


def test_config_command_set_rejects_empty(shopee_state: Path) -> None:
    result = keyword_config.run({"action": "set", "keywords": []})
    assert result["success"] is False


def test_export_command_fails_cleanly_without_credentials(shopee_state: Path) -> None:
    result = keyword_export.run({"keywords": ["garmin"], "countries": ["泰国"]})
    assert result["success"] is False
    assert result["error_kind"] == "credentials_not_configured"
    assert "LXE_HAIYING_USERNAME" in result["exception"]
