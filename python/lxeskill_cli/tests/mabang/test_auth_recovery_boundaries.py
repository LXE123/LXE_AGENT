import asyncio
from unittest.mock import AsyncMock

import pytest

from browser_auth_service.client import BrowserAuthClientError
from services.mabang import auth, export_common
from services.mabang.amazon.fba import wms
from services.mabang.errors import MabangAuthError, MabangAuthUnavailableError


def pipeline(fetch):
    return export_common.ExportPipelineSpec(
        fetch_ids=fetch,
        request_file_url=AsyncMock(return_value="fixture-url"),
        download_file=AsyncMock(return_value="fixture-file"),
        transform_result=lambda ids, file: file,
    )


@pytest.mark.parametrize("consumer", ["export", "wms"])
def test_failed_ensure_is_terminal_even_inside_business_retries(monkeypatch, consumer):
    read = AsyncMock(side_effect=BrowserAuthClientError("state expired"))
    cause = BrowserAuthClientError("stage=login actual rejection")
    ensure = AsyncMock(side_effect=cause)
    refresh = AsyncMock()
    request = AsyncMock()
    monkeypatch.setattr(auth.mabang_settings, "MABANG_ACCOUNT", "fixture-account")
    monkeypatch.setattr(auth, "read_auth", read)
    monkeypatch.setattr(auth, "ensure_auth", ensure)
    monkeypatch.setattr(export_common, "refresh_mabang_auth", refresh)
    monkeypatch.setattr(wms, "refresh_mabang_auth", refresh)
    monkeypatch.setattr(wms, "_request_once", request)

    async def fetch():
        await auth.get_auth_context()
        pytest.fail("business request must not run without authentication")

    operation = (export_common.run_export_pipeline(pipeline(fetch)) if consumer == "export"
                 else wms.download_consignment_excel_from_wms("SP-FIXTURE"))
    with pytest.raises(MabangAuthUnavailableError, match="actual rejection") as captured:
        asyncio.run(operation)
    assert captured.value.__cause__ is cause
    read.assert_awaited_once()
    ensure.assert_awaited_once()
    refresh.assert_not_called()
    request.assert_not_called()


def test_server_auth_rejection_still_refreshes_once_without_unbounded_retry(monkeypatch):
    first = MabangAuthError("server rejected cached credential")
    final = MabangAuthError("server still rejects credential")
    fetch = AsyncMock(side_effect=[first, final])
    refresh = AsyncMock()
    monkeypatch.setattr(export_common, "refresh_mabang_auth", refresh)
    with pytest.raises(MabangAuthError) as captured:
        asyncio.run(export_common.run_export_pipeline(pipeline(fetch)))
    assert captured.value is final
    assert fetch.await_count == 2
    refresh.assert_awaited_once()


def test_failed_explicit_refresh_preserves_cause_and_is_terminal(monkeypatch):
    cause = BrowserAuthClientError("stage=wms Element is not visible")
    refresh = AsyncMock(side_effect=cause)
    monkeypatch.setattr(auth.mabang_settings, "MABANG_ACCOUNT", "fixture-account")
    monkeypatch.setattr(auth, "refresh_auth", refresh)
    with pytest.raises(MabangAuthUnavailableError, match="Element is not visible") as captured:
        asyncio.run(auth.refresh_mabang_auth())
    assert captured.value.__cause__ is cause
    refresh.assert_awaited_once()
