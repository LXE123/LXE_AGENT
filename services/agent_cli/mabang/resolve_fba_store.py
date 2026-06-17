from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.mabang.amazon.fba.store_resolver import (
    FbaStore,
    STORE_CANDIDATES_FILE_PREFIX,
    list_fba_stores,
    resolve_fba_store,
    write_fba_stores_xlsx,
)
from shared.infra.net import close_all_network_clients

CANDIDATE_JSON_LIMIT = 10


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


def _write_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _exception_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    return message or exc.__class__.__name__


def _safe_file_part(value: Any) -> str:
    text = str(value or "").strip()
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    return text.strip("._-") or "candidates"


def _candidate_stores_from_payloads(candidates: list[dict[str, Any]]) -> list[FbaStore]:
    stores: list[FbaStore] = []
    for raw in candidates:
        item = dict(raw or {})
        store_name = str(item.get("store_name") or "").strip()
        store_id = str(item.get("store_id") or item.get("warehouse_id") or item.get("shop_id") or "").strip()
        id_type = str(item.get("id_type") or "").strip()
        if not store_name or not store_id or not id_type:
            continue
        stores.append(
            FbaStore(
                store_name=store_name,
                store_id=store_id,
                id_type=id_type,
                parent_store_name=str(item.get("parent_store_name") or "").strip(),
                parent_store_id=str(item.get("parent_store_id") or "").strip(),
                parent_id_type=str(item.get("parent_id_type") or "").strip(),
            )
        )
    return stores


def _candidate_payloads(candidates: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [store.to_payload() for store in _candidate_stores_from_payloads(candidates)]


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.resolve_fba_store"
    )
    parser.add_argument("--store-name", default="")
    return parser


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    store_name = str(getattr(args, "store_name", "") or "").strip()
    if store_name:
        return (await resolve_fba_store(store_name)).to_payload()
    return (await list_fba_stores()).to_payload()


def _augment_error_payload(payload: dict[str, Any], exc: Exception) -> dict[str, Any]:
    candidates = getattr(exc, "candidates", None)
    if candidates is not None:
        candidate_items = [dict(item or {}) for item in list(candidates or [])]
        if len(candidate_items) <= CANDIDATE_JSON_LIMIT:
            payload["candidates"] = _candidate_payloads(candidate_items)
        else:
            payload["candidate_count"] = len(candidate_items)
            query = str(getattr(exc, "query", "") or payload.get("query") or "").strip()
            candidate_stores = _candidate_stores_from_payloads(candidate_items)
            xlsx_path = write_fba_stores_xlsx(
                candidate_stores,
                filename_prefix=f"{STORE_CANDIDATES_FILE_PREFIX}_{_safe_file_part(query)}",
            )
            payload["candidates_xlsx_path"] = str(xlsx_path)
    query = str(getattr(exc, "query", "") or "").strip()
    if query:
        payload["query"] = query
    return payload


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    store_name = ""
    try:
        args = build_parser().parse_args(argv)
        store_name = str(getattr(args, "store_name", "") or "").strip()
        payload = asyncio.run(_run_async(args))
    except Exception as exc:
        payload = {
            "success": False,
            "query": store_name,
            "exception": _exception_text(exc),
        }
        payload = _augment_error_payload(payload, exc)
    finally:
        try:
            asyncio.run(close_all_network_clients())
        except Exception:
            pass

    _write_json(payload)
    return 0 if bool(payload.get("success")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
