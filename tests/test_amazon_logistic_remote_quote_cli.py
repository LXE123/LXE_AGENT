from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

import pytest

from services.agent_cli.amazon_logistic import run as cli


BOX_1 = {
    "sequence_no": "1",
    "box_no": "1",
    "gross_weight": "12.5",
    "length": "40",
    "width": "30",
    "height": "20",
}
BOX_2 = {
    "sequence_no": "2",
    "box_no": "2",
    "gross_weight": "8",
    "length": "35",
    "width": "25",
    "height": "18",
}


def _quote_response(payload: dict) -> dict:
    shipment_no = str(payload.get("shipment_no") or "")
    return {
        "ok": True,
        "target_country": "US",
        "recommended": [
            {
                "rank": 1,
                "channel_id": 12,
                "channel_code": "JFX-US-AIR-001",
                "channel_name": f"Remote Channel {shipment_no}",
                "currency": "CNY",
                "total_price": "318.50",
            }
        ],
        "pricing_snapshots": [
            {
                "channel_id": 12,
                "channel_code": "JFX-US-AIR-001",
                "channel_name": f"Remote Channel {shipment_no}",
                "status": "priced",
                "currency": "CNY",
                "total_price": "318.50",
                "calc_note": "remote quote",
            }
        ],
        "rejected_summary": {},
    }


async def _noop_close_all_network_clients() -> None:
    return None


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


def _patch_file_delivery(monkeypatch, saved_markdowns: list[str]) -> list[tuple[str, Path, str]]:
    sent_files: list[tuple[str, Path, str]] = []

    def fake_save_artifacts(markdown: str, _name: str, _kind: str) -> Path:
        saved_markdowns.append(markdown)
        return Path(r"D:\fake\channel_pricing.md")

    async def fake_send_file(session_id: str, path: Path, *, response_route_id: str = "") -> None:
        sent_files.append((session_id, path, response_route_id))

    monkeypatch.setattr(cli, "save_artifacts", fake_save_artifacts)
    monkeypatch.setattr(cli, "send_file_to_current_session", fake_send_file)
    return sent_files


def test_single_quote_uses_remote_api_and_sends_markdown(monkeypatch):
    saved_markdowns: list[str] = []
    sent_files = _patch_file_delivery(monkeypatch, saved_markdowns)
    quote_calls: list[dict] = []

    def fake_load_boxes(consignment_no: str):
        assert consignment_no == "SP001"
        return Path(r"D:\fake\SP001.xlsx"), [BOX_1]

    async def fake_quote_pricing(payload: dict) -> dict:
        quote_calls.append(payload)
        return _quote_response(payload)

    monkeypatch.setattr(cli, "load_pricing_boxes_from_local_excel", fake_load_boxes)
    monkeypatch.setattr(cli, "quote_pricing", fake_quote_pricing)
    monkeypatch.setattr(cli.config, "FBA_LOGISTICS_FIXED_CARGO_NATURE", "general")
    monkeypatch.setattr(
        cli.config,
        "FBA_LOGISTICS_DEFAULTS",
        {"transport_mode": "air", "tax_included": "any"},
    )

    result = asyncio.run(
        cli._run_single_mode(
            session_id="session-1",
            response_route_id="route-1",
            shipment_no="FBAABCD1",
            consignment_no="SP001",
            destination_address="ONT8, CA 92551, US",
        )
    )

    assert result["success"] is True
    assert len(quote_calls) == 1
    assert quote_calls[0] == {
        "shipment_no": "FBAABCD1",
        "consignment_no": "SP001",
        "destination_address": "ONT8, CA 92551, US",
        "transport_mode": "air",
        "cargo_nature": "general",
        "tax_included": "any",
        "boxes": [
            {
                "gross_weight": "12.5",
                "length": "40",
                "width": "30",
                "height": "20",
            }
        ],
        "top_n": 50,
        "allow_any_destination": True,
    }
    assert len(saved_markdowns) == 1
    assert "Remote Channel FBAABCD1" in saved_markdowns[0]
    assert sent_files == [("session-1", Path(r"D:\fake\channel_pricing.md"), "route-1")]


def test_batch_quote_calls_remote_api_once_per_tsv_row(monkeypatch):
    saved_markdowns: list[str] = []
    sent_files = _patch_file_delivery(monkeypatch, saved_markdowns)
    quote_calls: list[dict] = []

    def fake_load_boxes(consignment_no: str):
        assert consignment_no == "SP001"
        return Path(r"D:\fake\SP001.xlsx"), [BOX_1, BOX_2]

    async def fake_quote_pricing(payload: dict) -> dict:
        quote_calls.append(payload)
        return _quote_response(payload)

    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-2")
    monkeypatch.setenv("LXE_RESPONSE_ROUTE_ID", "route-2")
    monkeypatch.setattr(cli, "load_pricing_boxes_from_local_excel", fake_load_boxes)
    monkeypatch.setattr(cli, "quote_pricing", fake_quote_pricing)
    monkeypatch.setattr(cli.config, "FBA_LOGISTICS_FIXED_CARGO_NATURE", "general")
    monkeypatch.setattr(
        cli.config,
        "FBA_LOGISTICS_DEFAULTS",
        {"transport_mode": "air", "tax_included": "any"},
    )

    input_text = "\n".join(
        [
            "SP001\tFBAABCD1\tONT8, CA 92551, US",
            "SP001\tFBAABCD2\tLGB8, CA 92376, US",
        ]
    )
    args = argparse.Namespace(
        input_text=input_text,
        shipment_no="",
        consignment_no="",
        destination_address="",
    )

    result = asyncio.run(cli._run_async(args))

    assert result["success"] is True
    assert [payload["shipment_no"] for payload in quote_calls] == ["FBAABCD1", "FBAABCD2"]
    assert quote_calls[0]["boxes"] == [
        {
            "gross_weight": "12.5",
            "length": "40",
            "width": "30",
            "height": "20",
        }
    ]
    assert quote_calls[1]["boxes"] == [
        {
            "gross_weight": "8",
            "length": "35",
            "width": "25",
            "height": "18",
        }
    ]
    assert len(saved_markdowns) == 1
    assert "Remote Channel FBAABCD1" in saved_markdowns[0]
    assert "Remote Channel FBAABCD2" in saved_markdowns[0]
    assert sent_files == [("session-2", Path(r"D:\fake\channel_pricing.md"), "route-2")]


def test_remote_quote_failure_returns_cli_error(monkeypatch, capsys):
    def fake_load_boxes(_consignment_no: str):
        return Path(r"D:\fake\SP001.xlsx"), [BOX_1]

    async def fake_quote_pricing(_payload: dict) -> dict:
        raise RuntimeError("service rejected quote")

    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-3")
    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "amazon_logistic",
            "--shipment-no",
            "FBAABCD1",
            "--consignment-no",
            "SP001",
            "--destination-address",
            "ONT8, CA 92551, US",
        ],
    )
    monkeypatch.setattr(cli, "configure_utf8_stdio", lambda: None)
    monkeypatch.setattr(cli, "_configure_emit", lambda: None)
    monkeypatch.setattr(cli, "load_pricing_boxes_from_local_excel", fake_load_boxes)
    monkeypatch.setattr(cli, "quote_pricing", fake_quote_pricing)
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    exit_code = cli.main()

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "message": "物流优选流程失败",
        "exception": "service rejected quote",
    }


def test_batch_box_count_mismatch_does_not_call_remote_api(monkeypatch):
    quote_calls: list[dict] = []

    def fake_load_boxes(_consignment_no: str):
        return Path(r"D:\fake\SP001.xlsx"), [BOX_1]

    async def fake_quote_pricing(payload: dict) -> dict:
        quote_calls.append(payload)
        return _quote_response(payload)

    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-4")
    monkeypatch.setattr(cli, "load_pricing_boxes_from_local_excel", fake_load_boxes)
    monkeypatch.setattr(cli, "quote_pricing", fake_quote_pricing)

    input_text = "\n".join(
        [
            "SP001\tFBAABCD1\tONT8, CA 92551, US",
            "SP001\tFBAABCD2\tLGB8, CA 92376, US",
        ]
    )
    args = argparse.Namespace(
        input_text=input_text,
        shipment_no="",
        consignment_no="",
        destination_address="",
    )

    with pytest.raises(RuntimeError, match="输入货件数量与装箱文件箱子数量不一致"):
        asyncio.run(cli._run_async(args))

    assert quote_calls == []
