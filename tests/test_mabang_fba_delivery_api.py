from __future__ import annotations

import asyncio
import json

import pytest

from services.mabang.amazon.fba import batch_delivery


def _list_payload(rows: list[dict]) -> dict:
    return {"code": 200, "msg": "success", "data": {"data": rows}}


def test_extract_delivery_id_requires_exact_match():
    payload = _list_payload(
        [
            {"id": 1, "delivery_no": "SP000000001"},
            {"id": 147674, "delivery_no": "SP260508022"},
        ]
    )

    assert batch_delivery.extract_delivery_id(payload, "sp260508022") == 147674


def test_extract_delivery_id_rejects_missing_match():
    payload = _list_payload([{"id": 1, "delivery_no": "SP000000001"}])

    with pytest.raises(batch_delivery.BatchDeliveryApiError, match="未查询到FBA发货单"):
        batch_delivery.extract_delivery_id(payload, "SP260508022")


def test_extract_delivery_id_rejects_multiple_matches():
    payload = _list_payload(
        [
            {"id": 147674, "delivery_no": "SP260508022"},
            {"id": 147675, "delivery_no": "sp260508022"},
        ]
    )

    with pytest.raises(batch_delivery.BatchDeliveryApiError, match="查询到多个FBA发货单"):
        batch_delivery.extract_delivery_id(payload, "SP260508022")


async def _fake_fetch_pending(task_id: int, *, token: str | None = None) -> dict:
    return {
        "taskId": task_id,
        "taskStatus": 0,
        "taskStatusText": "待处理",
        "errMessage": "",
        "fileHash": "",
    }


def test_wait_for_delivery_task_times_out(monkeypatch):
    monkeypatch.setattr(batch_delivery, "fetch_task_report_row", _fake_fetch_pending)

    with pytest.raises(batch_delivery.BatchDeliveryTimeoutError, match="导出任务超时"):
        asyncio.run(
            batch_delivery.wait_for_delivery_task(
                370502,
                token="token",
                timeout_sec=0,
                poll_interval_sec=0.1,
            )
        )


def test_wait_for_delivery_task_returns_completed(monkeypatch):
    async def fake_fetch(task_id: int, *, token: str | None = None) -> dict:
        return {
            "taskId": task_id,
            "taskStatus": 2,
            "taskStatusText": "处理完成",
            "errMessage": "done",
            "fileHash": "hash-1",
            "fileName": "delivery.csv",
        }

    monkeypatch.setattr(batch_delivery, "fetch_task_report_row", fake_fetch)

    task = asyncio.run(batch_delivery.wait_for_delivery_task(370502, token="token"))

    assert task.task_id == 370502
    assert task.file_hash == "hash-1"
    assert task.file_name == "delivery.csv"


def test_wait_for_delivery_task_rejects_failed_status(monkeypatch):
    async def fake_fetch(task_id: int, *, token: str | None = None) -> dict:
        return {
            "taskId": task_id,
            "taskStatus": 3,
            "taskStatusText": "处理失败",
            "errMessage": "export failed",
            "fileHash": "",
        }

    monkeypatch.setattr(batch_delivery, "fetch_task_report_row", fake_fetch)

    with pytest.raises(batch_delivery.BatchDeliveryApiError, match="export failed"):
        asyncio.run(batch_delivery.wait_for_delivery_task(370502, token="token"))


def test_completed_task_requires_file_hash():
    row = {
        "taskId": 370502,
        "taskStatus": 2,
        "taskStatusText": "处理完成",
        "fileHash": "",
    }

    with pytest.raises(batch_delivery.BatchDeliveryApiError, match="缺少 fileHash"):
        batch_delivery._normalize_completed_task(row, expected_task_id=370502)


def test_download_info_requires_download_url():
    payload = {
        "code": 200,
        "msg": "success",
        "data": {
            "taskId": 370502,
            "fileHash": "hash-1",
            "fileName": "delivery.csv",
            "downloadUrl": "",
        },
    }

    with pytest.raises(batch_delivery.BatchDeliveryApiError, match="缺少 downloadUrl"):
        batch_delivery._normalize_download_info(
            payload,
            expected_task_id=370502,
            expected_file_hash="hash-1",
        )


class _FakeResponse:
    def __init__(self, payload: dict | None = None, *, status: int = 200, body: bytes = b"") -> None:
        self.status = status
        self._payload = dict(payload or {})
        self._body = body

    async def text(self) -> str:
        return json.dumps(self._payload, ensure_ascii=False)

    async def json(self, content_type=None) -> dict:
        return dict(self._payload)

    async def read(self) -> bytes:
        return self._body


class _FakeRequest:
    def __init__(self, response: _FakeResponse) -> None:
        self._response = response

    async def __aenter__(self) -> _FakeResponse:
        return self._response

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None


class _FakeSession:
    def __init__(self, responses: list[_FakeResponse]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def get(self, url: str, **kwargs) -> _FakeRequest:
        self.calls.append({"method": "GET", "url": url, **kwargs})
        return _FakeRequest(self.responses.pop(0))


def test_download_csv_from_url_does_not_send_authorization(monkeypatch, tmp_path):
    fake_session = _FakeSession([_FakeResponse(body=b"sku,qty\nA,1\n")])
    monkeypatch.setattr(batch_delivery, "external_http_session", fake_session)

    path = asyncio.run(
        batch_delivery.download_csv_from_url(
            "https://cos.example.test/file.csv",
            delivery_no="SP260508022",
            task_id=370502,
            output_dir=tmp_path,
        )
    )

    assert path.read_bytes() == b"sku,qty\nA,1\n"
    assert "Authorization" not in fake_session.calls[0].get("headers", {})
