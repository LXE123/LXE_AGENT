from __future__ import annotations

import asyncio

import pytest

from services.amazon.amazon_logistic import remote_client


class _FakeFormData:
    def __init__(self) -> None:
        self.fields: list[tuple[str, object, dict]] = []

    def add_field(self, name: str, value: object, **kwargs) -> None:
        self.fields.append((name, value, kwargs))


class _FakeResponse:
    def __init__(self, payload: dict, status: int = 202) -> None:
        self._payload = payload
        self.status = status

    async def text(self) -> str:
        return "{}"

    async def json(self, content_type=None) -> dict:
        return dict(self._payload)


class _FakeRequest:
    def __init__(self, response: _FakeResponse) -> None:
        self._response = response

    async def __aenter__(self) -> _FakeResponse:
        return self._response

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None


class _FakeSession:
    def __init__(self, payload: dict, status: int = 202) -> None:
        self.response = _FakeResponse(payload, status)
        self.calls: list[dict] = []

    def post(self, url: str, **kwargs) -> _FakeRequest:
        self.calls.append({"url": url, **kwargs})
        return _FakeRequest(self.response)


def test_upload_import_file_posts_multipart_file_field(monkeypatch, tmp_path):
    file_path = tmp_path / "quote.xlsx"
    file_path.write_bytes(b"quote-data")
    form_instances: list[_FakeFormData] = []

    def fake_form_data() -> _FakeFormData:
        form = _FakeFormData()
        form_instances.append(form)
        return form

    fake_session = _FakeSession({"ok": True, "job_id": "imp_upload", "status": "queued"})
    monkeypatch.setattr(remote_client.aiohttp, "FormData", fake_form_data)
    monkeypatch.setattr(remote_client, "external_http_session", fake_session)
    monkeypatch.setattr(remote_client.config, "LOGISTICS_API_BASE_URL", "http://logistics.test")

    payload = asyncio.run(remote_client.upload_import_file(str(file_path)))

    assert payload["job_id"] == "imp_upload"
    assert fake_session.calls[0]["url"] == "http://logistics.test/api/v1/pricing/import-jobs/upload"
    assert fake_session.calls[0]["data"] is form_instances[0]
    assert form_instances[0].fields[0][0] == "file"
    assert form_instances[0].fields[0][2]["filename"] == "quote.xlsx"


def test_upload_import_file_requires_job_id(monkeypatch, tmp_path):
    file_path = tmp_path / "quote.xlsx"
    file_path.write_bytes(b"quote-data")
    fake_session = _FakeSession({"ok": True, "status": "queued"})
    monkeypatch.setattr(remote_client, "external_http_session", fake_session)
    monkeypatch.setattr(remote_client.config, "LOGISTICS_API_BASE_URL", "http://logistics.test")

    with pytest.raises(remote_client.LogisticsApiError, match="missing job_id"):
        asyncio.run(remote_client.upload_import_file(str(file_path)))
