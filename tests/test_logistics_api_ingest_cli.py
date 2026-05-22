from __future__ import annotations

import json

from scripts import logistics_update_ingest as cli


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


async def _noop_close_all_network_clients() -> None:
    return None


async def _noop_sleep(_seconds: float) -> None:
    return None


def _patch_fast_polling(monkeypatch, *, max_polls: int = 6) -> None:
    monkeypatch.setattr(cli.config, "LOGISTICS_IMPORT_POLL_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(cli.config, "LOGISTICS_IMPORT_MAX_POLLS", max_polls)
    monkeypatch.setattr(cli.asyncio, "sleep", _noop_sleep)
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)


def test_local_file_is_uploaded_before_import_job(monkeypatch, tmp_path, capsys):
    _patch_fast_polling(monkeypatch)
    source_file = tmp_path / "quote.xlsx"
    source_file.write_bytes(b"quote-data")

    async def fake_upload_import_file(file_path: str) -> dict:
        assert file_path == str(source_file)
        return {"ok": True, "job_id": "imp_stage", "status": "succeeded", "result": {"status": "accepted"}}

    async def fake_create_import_job(_file_path: str) -> dict:
        raise AssertionError("create_import_job should not be called for a local file")

    monkeypatch.setattr(cli, "upload_import_file", fake_upload_import_file)
    monkeypatch.setattr(cli, "create_import_job", fake_create_import_job)

    exit_code = cli.main(["--file-path", str(source_file)])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["file_path"] == str(source_file)
    assert payload["status"] == "succeeded"


def test_import_job_succeeds_after_poll(monkeypatch, capsys):
    _patch_fast_polling(monkeypatch)
    seen = {"gets": 0}

    async def fake_create_import_job(file_path: str) -> dict:
        assert file_path == r"D:\agentTemp\logistics_uploads\quote.xlsx"
        return {"ok": True, "job_id": "imp_1", "status": "queued"}

    async def fake_upload_import_file(_file_path: str) -> dict:
        raise AssertionError("upload_import_file should not be called for a remote path")

    async def fake_get_import_job(job_id: str) -> dict:
        assert job_id == "imp_1"
        seen["gets"] += 1
        return {
            "ok": True,
            "job_id": "imp_1",
            "status": "succeeded",
            "result": {"status": "accepted", "decision_reason": "ok"},
        }

    monkeypatch.setattr(cli, "create_import_job", fake_create_import_job)
    monkeypatch.setattr(cli, "upload_import_file", fake_upload_import_file)
    monkeypatch.setattr(cli, "get_import_job", fake_get_import_job)

    exit_code = cli.main(["--file-path", r"D:\agentTemp\logistics_uploads\quote.xlsx"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert seen["gets"] == 1
    assert payload["ok"] is True
    assert payload["job_id"] == "imp_1"
    assert payload["status"] == "succeeded"
    assert payload["result"]["status"] == "accepted"


def test_import_job_failed_status_returns_error(monkeypatch, capsys):
    _patch_fast_polling(monkeypatch)

    async def fake_create_import_job(_file_path: str) -> dict:
        return {"ok": True, "job_id": "imp_2", "status": "queued"}

    async def fake_get_import_job(_job_id: str) -> dict:
        return {"ok": True, "job_id": "imp_2", "status": "failed", "error": "bad workbook"}

    monkeypatch.setattr(cli, "create_import_job", fake_create_import_job)
    monkeypatch.setattr(cli, "get_import_job", fake_get_import_job)

    exit_code = cli.main(["--file-path", r"D:\agentTemp\logistics_uploads\bad.xlsx"])

    payload = _read_payload(capsys)
    assert exit_code == 3
    assert payload == {
        "ok": False,
        "job_id": "imp_2",
        "status": "failed",
        "file_path": r"D:\agentTemp\logistics_uploads\bad.xlsx",
        "error": "bad workbook",
    }


def test_import_job_still_running_after_max_polls(monkeypatch, capsys):
    _patch_fast_polling(monkeypatch, max_polls=2)
    seen = {"gets": 0}

    async def fake_create_import_job(_file_path: str) -> dict:
        return {"ok": True, "job_id": "imp_3", "status": "queued"}

    async def fake_get_import_job(_job_id: str) -> dict:
        seen["gets"] += 1
        return {"ok": True, "job_id": "imp_3", "status": "running"}

    monkeypatch.setattr(cli, "create_import_job", fake_create_import_job)
    monkeypatch.setattr(cli, "get_import_job", fake_get_import_job)

    exit_code = cli.main(["--file-path", r"D:\agentTemp\logistics_uploads\slow.xlsx"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert seen["gets"] == 2
    assert payload["ok"] is True
    assert payload["job_id"] == "imp_3"
    assert payload["status"] == "running"
    assert payload["message"] == "导入任务仍在后台执行"


def test_import_job_api_error_returns_failure_json(monkeypatch, capsys):
    _patch_fast_polling(monkeypatch)

    async def fake_create_import_job(_file_path: str) -> dict:
        raise RuntimeError("connection refused")

    monkeypatch.setattr(cli, "create_import_job", fake_create_import_job)

    exit_code = cli.main(["--file-path", r"D:\agentTemp\logistics_uploads\quote.xlsx"])

    payload = _read_payload(capsys)
    assert exit_code == 3
    assert payload["ok"] is False
    assert payload["file_path"] == r"D:\agentTemp\logistics_uploads\quote.xlsx"
    assert payload["error"] == "connection refused"


def test_upload_failure_returns_failure_json(monkeypatch, tmp_path, capsys):
    _patch_fast_polling(monkeypatch)
    source_file = tmp_path / "quote.xlsx"
    source_file.write_bytes(b"quote-data")

    async def fake_upload_import_file(_file_path: str) -> dict:
        raise RuntimeError("upload endpoint returned 404")

    async def fake_create_import_job(_file_path: str) -> dict:
        raise AssertionError("create_import_job should not be called when upload fails")

    monkeypatch.setattr(cli, "upload_import_file", fake_upload_import_file)
    monkeypatch.setattr(cli, "create_import_job", fake_create_import_job)

    exit_code = cli.main(["--file-path", str(source_file)])

    payload = _read_payload(capsys)
    assert exit_code == 3
    assert payload["ok"] is False
    assert payload["file_path"] == str(source_file)
    assert payload["error"] == "upload endpoint returned 404"


def test_query_job_does_not_upload_import_file(monkeypatch, capsys):
    _patch_fast_polling(monkeypatch)

    async def fake_get_import_job(job_id: str) -> dict:
        assert job_id == "imp_query"
        return {"ok": True, "job_id": "imp_query", "status": "succeeded", "result": {"status": "accepted"}}

    async def fake_upload_import_file(_file_path: str) -> dict:
        raise AssertionError("upload_import_file should not be called when querying a job")

    monkeypatch.setattr(cli, "get_import_job", fake_get_import_job)
    monkeypatch.setattr(cli, "upload_import_file", fake_upload_import_file)

    exit_code = cli.main(["--job-id", "imp_query"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["ok"] is True
    assert payload["job_id"] == "imp_query"
