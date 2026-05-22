from __future__ import annotations

from services.browser.workflows.amazon_fba_common import WorkflowBrowserSession
from services.browser.workflows.amazon_fba_prepare_upload import run_prepare_upload_workflow


def _session(tmp_path) -> WorkflowBrowserSession:
    return WorkflowBrowserSession(
        driver=object(),
        state_data={},
        output_dir=tmp_path,
        session_id="session-1",
        store_id="store-1",
        store_name="Amazon-YRZ",
        download_path="D:\\RPA\\downloads",
    )


def _payload() -> dict[str, str]:
    return {
        "site": "US",
        "consignment_no": "SP260408007",
        "transport_mode": "空运",
    }


def test_prepare_upload_waits_for_step1_inventory_confirmation_before_success(tmp_path) -> None:
    calls: list[str] = []

    result = run_prepare_upload_workflow(
        session=_session(tmp_path),
        payload=_payload(),
        event_writer=lambda _event: None,
        switch_region_fn=lambda *_args, **_kwargs: calls.append("switch_region") or {},
        open_upload_mode_fn=lambda *_args, **_kwargs: calls.append("open_upload_mode") or {},
        prepare_consignment_fn=lambda consignment_no: calls.append(f"prepare:{consignment_no}")
        or {"excel_path": "D:\\tmp\\consignment.xlsx"},
        download_template_fn=lambda *_args, **_kwargs: calls.append("download_template")
        or {"template_path": "D:\\tmp\\template.xlsx"},
        fill_template_fn=lambda *_args, **_kwargs: calls.append("fill_template")
        or {"filled_template_path": "D:\\tmp\\filled.xlsx"},
        upload_template_fn=lambda *_args, **_kwargs: calls.append("upload_template")
        or {"notice": "准备发送的 SKU：1（1 件商品）"},
        advance_multi_box_entry_fn=lambda *_args, **_kwargs: calls.append("advance_multi_box_entry")
        or {"notice": "已确认要发送的库存"},
    )

    assert result["finished"] is True
    assert "第一阶段完成" in result["notice"]
    assert "已确认要发送的库存" in result["notice"]
    assert calls[-2:] == ["upload_template", "advance_multi_box_entry"]


def test_prepare_upload_advance_failure_keeps_generated_file_paths(tmp_path) -> None:
    def raise_advance(*_args, **_kwargs):
        raise RuntimeError("等待第 1 步库存确认完成超时")

    result = run_prepare_upload_workflow(
        session=_session(tmp_path),
        payload=_payload(),
        event_writer=lambda _event: None,
        switch_region_fn=lambda *_args, **_kwargs: {},
        open_upload_mode_fn=lambda *_args, **_kwargs: {},
        prepare_consignment_fn=lambda _consignment_no: {"excel_path": "D:\\tmp\\consignment.xlsx"},
        download_template_fn=lambda *_args, **_kwargs: {"template_path": "D:\\tmp\\template.xlsx"},
        fill_template_fn=lambda *_args, **_kwargs: {"filled_template_path": "D:\\tmp\\filled.xlsx"},
        upload_template_fn=lambda *_args, **_kwargs: {"notice": "准备发送的 SKU：1（1 件商品）"},
        advance_multi_box_entry_fn=raise_advance,
    )

    assert result["finished"] is False
    assert result["exception"] == "等待第 1 步库存确认完成超时"
    assert result["file_path"] == [
        {"key": "consignment_excel", "value": "D:\\tmp\\consignment.xlsx"},
        {"key": "amazon_template", "value": "D:\\tmp\\template.xlsx"},
        {"key": "filled_template", "value": "D:\\tmp\\filled.xlsx"},
    ]


def test_prepare_upload_step1_sku_footer_error_goes_to_exception(tmp_path) -> None:
    error = "第一阶段库存确认失败: 此商品超出了仓储的容量限制。 点击仓储容量监视器，查看仓储的货件容量上限。"

    def raise_advance(*_args, **_kwargs):
        raise RuntimeError(error)

    result = run_prepare_upload_workflow(
        session=_session(tmp_path),
        payload=_payload(),
        event_writer=lambda _event: None,
        switch_region_fn=lambda *_args, **_kwargs: {},
        open_upload_mode_fn=lambda *_args, **_kwargs: {},
        prepare_consignment_fn=lambda _consignment_no: {"excel_path": "D:\\tmp\\consignment.xlsx"},
        download_template_fn=lambda *_args, **_kwargs: {"template_path": "D:\\tmp\\template.xlsx"},
        fill_template_fn=lambda *_args, **_kwargs: {"filled_template_path": "D:\\tmp\\filled.xlsx"},
        upload_template_fn=lambda *_args, **_kwargs: {"notice": "准备发送的 SKU：1（1 件商品）"},
        advance_multi_box_entry_fn=raise_advance,
    )

    assert result["finished"] is False
    assert result["exception"] == error
    assert result["notice"] == ""
    assert result["file_path"] == [
        {"key": "consignment_excel", "value": "D:\\tmp\\consignment.xlsx"},
        {"key": "amazon_template", "value": "D:\\tmp\\template.xlsx"},
        {"key": "filled_template", "value": "D:\\tmp\\filled.xlsx"},
    ]
