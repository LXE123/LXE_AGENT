from __future__ import annotations

import asyncio
import json
import logging

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


async def _fake_fetch_pending(task_id: int) -> dict:
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
                timeout_sec=0,
                poll_interval_sec=0.1,
            )
        )


def test_wait_for_delivery_task_uses_ten_second_min_poll_interval_and_logs_progress(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="services.mabang.amazon.fba.batch_delivery")
    calls = {"count": 0}
    sleeps: list[float] = []

    async def fake_fetch(task_id: int) -> dict:
        calls["count"] += 1
        if calls["count"] == 1:
            return {
                "taskId": task_id,
                "taskStatus": 0,
                "taskStatusText": "待处理",
                "errMessage": "",
                "fileHash": "",
            }
        return {
            "taskId": task_id,
            "taskStatus": 2,
            "taskStatusText": "处理完成",
            "errMessage": "done",
            "fileHash": "hash-1",
            "fileName": "delivery.csv",
        }

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(batch_delivery, "fetch_task_report_row", fake_fetch)
    monkeypatch.setattr(batch_delivery.asyncio, "sleep", fake_sleep)

    task = asyncio.run(
        batch_delivery.wait_for_delivery_task(
            370502,
            timeout_sec=30,
            poll_interval_sec=0.1,
            progress_label="[UnlinkedShipments] WMS待装箱",
        )
    )

    assert task.task_id == 370502
    assert sleeps == [10.0]
    assert "[UnlinkedShipments] WMS待装箱 轮询 1: taskStatus=0, taskStatusText=待处理" in caplog.text
    assert "[UnlinkedShipments] WMS待装箱 轮询 2: taskStatus=2, taskStatusText=处理完成" in caplog.text


def test_wait_for_delivery_task_returns_completed(monkeypatch):
    async def fake_fetch(task_id: int) -> dict:
        return {
            "taskId": task_id,
            "taskStatus": 2,
            "taskStatusText": "处理完成",
            "errMessage": "done",
            "fileHash": "hash-1",
            "fileName": "delivery.csv",
        }

    monkeypatch.setattr(batch_delivery, "fetch_task_report_row", fake_fetch)

    task = asyncio.run(batch_delivery.wait_for_delivery_task(370502))

    assert task.task_id == 370502
    assert task.file_hash == "hash-1"
    assert task.file_name == "delivery.csv"


def test_wait_for_delivery_task_rejects_failed_status(monkeypatch):
    async def fake_fetch(task_id: int) -> dict:
        return {
            "taskId": task_id,
            "taskStatus": 3,
            "taskStatusText": "处理失败",
            "errMessage": "export failed",
            "fileHash": "",
        }

    monkeypatch.setattr(batch_delivery, "fetch_task_report_row", fake_fetch)

    with pytest.raises(batch_delivery.BatchDeliveryApiError, match="export failed"):
        asyncio.run(batch_delivery.wait_for_delivery_task(370502))


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


def test_each_fba_request_resolves_latest_token(monkeypatch) -> None:
    payloads = [
        _FakeResponse(
            {
                "code": 200,
                "data": {
                    "taskId": 370502,
                    "fileHash": "hash-1",
                    "fileName": "delivery.csv",
                    "downloadUrl": "https://files.example/one.csv",
                },
            }
        ),
        _FakeResponse(
            {
                "code": 200,
                "data": {
                    "taskId": 370502,
                    "fileHash": "hash-1",
                    "fileName": "delivery.csv",
                    "downloadUrl": "https://files.example/two.csv",
                },
            }
        ),
    ]
    fake_session = _FakeSession(payloads)
    tokens = iter(("token-a", "token-b"))

    async def fake_get_token(purpose: str = "") -> str:
        return next(tokens)

    monkeypatch.setattr(batch_delivery, "erp_http_session", fake_session)
    monkeypatch.setattr(batch_delivery, "get_fba_free_token", fake_get_token)

    async def run_requests() -> None:
        await batch_delivery.request_download_info(370502, "hash-1")
        await batch_delivery.request_download_info(370502, "hash-1")

    asyncio.run(run_requests())

    assert [call["headers"]["Authorization"] for call in fake_session.calls] == [
        "Bearer token-a",
        "Bearer token-b",
    ]


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


def test_download_fba_delivery_csv_refreshes_once_after_auth_failure(monkeypatch, tmp_path):
    refresh_calls: list[str] = []
    run_calls: list[str] = []

    async def fake_refresh(*, purpose: str = "") -> dict:
        refresh_calls.append(purpose)
        return {"success": True}

    async def fake_run(target: str, **kwargs) -> batch_delivery.BatchDeliveryCsvResult:
        run_calls.append(target)
        if len(run_calls) == 1:
            raise batch_delivery.BatchDeliveryApiAuthError("查询FBA发货单鉴权失败(status=401)")
        return batch_delivery.BatchDeliveryCsvResult(
            delivery_no=target,
            delivery_id=148028,
            task_id=379014,
            file_hash="hash",
            file_name="delivery.csv",
            csv_path=str(tmp_path / "delivery.csv"),
        )

    monkeypatch.setattr(batch_delivery, "refresh_mabang_auth", fake_refresh)
    monkeypatch.setattr(batch_delivery, "_download_fba_delivery_csv_once", fake_run)

    result = asyncio.run(batch_delivery.download_fba_delivery_csv("SP260529005", output_dir=tmp_path))

    assert result.delivery_no == "SP260529005"
    assert refresh_calls == ["fba_delivery_csv_download_auth_retry"]
    assert run_calls == ["SP260529005", "SP260529005"]


def test_download_fba_delivery_csv_does_not_retry_more_than_once(monkeypatch, tmp_path):
    refresh_calls: list[str] = []
    run_calls: list[str] = []

    async def fake_refresh(*, purpose: str = "") -> dict:
        refresh_calls.append(purpose)
        return {"success": True}

    async def fake_run(target: str, **kwargs) -> batch_delivery.BatchDeliveryCsvResult:
        run_calls.append(target)
        raise batch_delivery.BatchDeliveryApiAuthError("查询FBA发货单鉴权失败(status=403)")

    monkeypatch.setattr(batch_delivery, "refresh_mabang_auth", fake_refresh)
    monkeypatch.setattr(batch_delivery, "_download_fba_delivery_csv_once", fake_run)

    with pytest.raises(batch_delivery.BatchDeliveryApiAuthError, match="status=403"):
        asyncio.run(batch_delivery.download_fba_delivery_csv("SP260529005", output_dir=tmp_path))

    assert refresh_calls == ["fba_delivery_csv_download_auth_retry"]
    assert run_calls == ["SP260529005", "SP260529005"]


def test_download_fba_delivery_csv_does_not_refresh_non_auth_errors(monkeypatch, tmp_path):
    refresh_calls: list[str] = []

    async def fake_refresh(*, purpose: str = "") -> dict:
        refresh_calls.append(purpose)
        return {"success": True}

    async def fake_run(target: str, **kwargs) -> batch_delivery.BatchDeliveryCsvResult:
        raise batch_delivery.BatchDeliveryApiError("业务异常")

    monkeypatch.setattr(batch_delivery, "refresh_mabang_auth", fake_refresh)
    monkeypatch.setattr(batch_delivery, "_download_fba_delivery_csv_once", fake_run)

    with pytest.raises(batch_delivery.BatchDeliveryApiError, match="业务异常"):
        asyncio.run(batch_delivery.download_fba_delivery_csv("SP260529005", output_dir=tmp_path))

    assert refresh_calls == []
