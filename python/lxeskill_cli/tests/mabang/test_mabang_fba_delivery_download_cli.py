from __future__ import annotations

import asyncio

import pytest
from aiohttp import web

from services.agent_cli.mabang import customs_erp
from services.agent_cli.mabang import download_fba_delivery_csv as cli
from services.mabang.amazon.fba.batch_delivery import BatchDeliveryCsvResult
from shared.infra.net.aiohttp_client import (
    HttpSessionPurpose,
    HttpSessionRegistry,
    close_all_aiohttp_sessions,
)


def test_success_returns_downloaded_csv_path(monkeypatch, capsys):

    async def fake_download(delivery_no: str, *, timeout_sec: float, poll_interval_sec: float):
        assert delivery_no == "SP260508022"
        assert timeout_sec == 180
        assert poll_interval_sec == 10
        return BatchDeliveryCsvResult(
            delivery_no="SP260508022",
            delivery_id=147674,
            task_id=370502,
            file_hash="hash-1",
            file_name="delivery.csv",
            csv_path="artifacts/mabang_fba_delivery/SP260508022_370502.csv",
        )

    monkeypatch.setattr(cli, "download_fba_delivery_csv", fake_download)

    payload = cli.run({"delivery_no": 'sp260508022'})
    assert payload == {
        "success": True,
        "delivery_no": "SP260508022",
        "delivery_id": 147674,
        "task_id": 370502,
        "file_hash": "hash-1",
        "file_name": "delivery.csv",
        "csv_path": "artifacts/mabang_fba_delivery/SP260508022_370502.csv",
        "source": "mabang_fba_delivery",
    }


def test_success_preserves_explicit_poll_interval(monkeypatch, capsys):

    async def fake_download(delivery_no: str, *, timeout_sec: float, poll_interval_sec: float):
        assert delivery_no == "SP260508022"
        assert timeout_sec == 180
        assert poll_interval_sec == 15
        return BatchDeliveryCsvResult(
            delivery_no="SP260508022",
            delivery_id=147674,
            task_id=370502,
            file_hash="hash-1",
            file_name="delivery.csv",
            csv_path="artifacts/mabang_fba_delivery/SP260508022_370502.csv",
        )

    monkeypatch.setattr(cli, "download_fba_delivery_csv", fake_download)

    payload = cli.run({"delivery_no": 'sp260508022', "poll_interval_sec": '15'})
    assert payload["success"] is True


@pytest.mark.parametrize("fail_first", [False, True])
@pytest.mark.parametrize("through_customs", [False, True])
def test_repeated_downloads_use_live_sessions(monkeypatch, tmp_path, fail_first, through_customs):
    """Keep real loops, sessions and HTTP; replace only the Mabang workflow."""
    sessions = []
    received = []
    numbers = ["SP260820009", "SP260831008", "SP999"]

    async def fake_download(delivery_no, **kwargs):
        async def respond(request):
            received.append(delivery_no)
            return web.Response(text="MSKU,MSKU发货量\nSKU-A,1\n")

        app = web.Application()
        app.router.add_get("/delivery.csv", respond)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        try:
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            for purpose in (HttpSessionPurpose.ERP, HttpSessionPurpose.EXTERNAL):
                session = HttpSessionRegistry.get(purpose)
                sessions.append(session)
                async with session.get(f"http://127.0.0.1:{port}/delivery.csv") as response:
                    content = await response.text()
            if fail_first and delivery_no == numbers[0]:
                raise RuntimeError("delivery export failed after HTTP response")
            path = tmp_path / f"{delivery_no}.csv"
            path.write_text(content, encoding="utf-8")
            return BatchDeliveryCsvResult(delivery_no, 1, 2, "hash", path.name, str(path))
        finally:
            await runner.cleanup()

    monkeypatch.setattr(cli, "download_fba_delivery_csv", fake_download)
    try:
        for index, sp in enumerate(numbers):
            if through_customs:
                if fail_first and index == 0:
                    with pytest.raises(ValueError, match="delivery export failed after HTTP response"):
                        customs_erp._download(sp)
                else:
                    assert customs_erp._download(sp).read_text(encoding="utf-8") == "MSKU,MSKU发货量\nSKU-A,1\n"
            else:
                result = cli.run({"delivery_no": sp})
                if fail_first and index == 0:
                    assert result["success"] is False
                    assert "delivery export failed after HTTP response" in result["exception"]
                else:
                    assert result["success"] is True, result
        assert received == [sp for sp in numbers for _ in range(2)]
        assert len({id(session) for session in sessions}) == 6
        assert all(session.closed for session in sessions)
    finally:
        asyncio.run(close_all_aiohttp_sessions())
