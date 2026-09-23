from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .client import ZhihuiTmsClient
from .errors import ZhihuiTmsError, safe_payload_text


PAGE_SIZE = 1000
DEFAULT_MAX_PAGES = 100
DEFAULT_MAX_RECORDS = 100_000
DEFAULT_MAX_REQUESTS = 200
DEFAULT_MAX_RUNTIME = 15 * 60.0


class ZhihuiTmsPaginationError(ZhihuiTmsError):
    """The TMS list response cannot be safely interpreted or advanced."""


class ZhihuiTmsExportLimitError(ZhihuiTmsError):
    """A configured hard limit prevented the next TMS request."""


@dataclass(frozen=True)
class ZhihuiTmsExportPage:
    page: int
    product_ids: tuple[Any, ...]
    response: Mapping[str, Any]

    @property
    def pop(self) -> Any:
        return _extract_pop(self.response)


@dataclass(frozen=True)
class ZhihuiTmsExportResult:
    pages: tuple[ZhihuiTmsExportPage, ...]
    total_records: int
    reported_total_num: int
    request_count: int


Clock = Callable[[], float]


def _diagnostic(value: Any) -> str:
    return safe_payload_text(value)


def _validate_limits(*, max_pages: int, max_records: int, max_requests: int, max_runtime: float) -> None:
    if isinstance(max_pages, bool) or not isinstance(max_pages, int) or max_pages < 1:
        raise ValueError("max_pages 必须是正整数")
    if isinstance(max_records, bool) or not isinstance(max_records, int) or max_records < 0:
        raise ValueError("max_records 必须是非负整数")
    if isinstance(max_requests, bool) or not isinstance(max_requests, int) or max_requests < 1:
        raise ValueError("max_requests 必须是正整数")
    if isinstance(max_runtime, bool) or not isinstance(max_runtime, (int, float)) or max_runtime <= 0:
        raise ValueError("max_runtime 必须是正数")


def _page_payload(response: Mapping[str, Any]) -> Mapping[str, Any]:
    candidates = (response, response.get("data"), response.get("pop"))
    for candidate in candidates:
        if isinstance(candidate, Mapping) and "datas" in candidate and "totalNum" in candidate:
            return candidate
    raise ZhihuiTmsPaginationError(
        "tms_pagination_schema_invalid",
        f"智汇 TMS 商品列表响应缺少 datas/totalNum: {_diagnostic(response)}",
        payload=response,
    )


def _total_num(value: Any, response: Mapping[str, Any]) -> int:
    if isinstance(value, bool):
        valid = False
    elif isinstance(value, int):
        valid = value >= 0
    elif isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
        valid = True
    else:
        valid = False
    if not valid:
        raise ZhihuiTmsPaginationError(
            "tms_pagination_total_invalid",
            f"智汇 TMS totalNum 不是有效非负整数: {_diagnostic(response)}",
            payload=response,
        )
    return int(value)


def _product_ids(datas: Any, response: Mapping[str, Any]) -> tuple[Any, ...]:
    if not isinstance(datas, list):
        raise ZhihuiTmsPaginationError(
            "tms_pagination_datas_invalid",
            f"智汇 TMS datas 不是数组: {_diagnostic(response)}",
            payload=response,
        )
    ids: list[Any] = []
    for item in datas:
        if not isinstance(item, Mapping) or "id" not in item:
            raise ZhihuiTmsPaginationError(
                "tms_product_id_missing",
                f"智汇 TMS 商品记录缺少 id: {_diagnostic(item)}; 原响应: {_diagnostic(response)}",
                payload=response,
            )
        product_id = item["id"]
        if (
            isinstance(product_id, bool)
            or not isinstance(product_id, (str, int))
            or (isinstance(product_id, str) and not product_id.strip())
        ):
            raise ZhihuiTmsPaginationError(
                "tms_product_id_invalid",
                f"智汇 TMS 商品 id 无效: {_diagnostic(item)}; 原响应: {_diagnostic(response)}",
                payload=response,
            )
        ids.append(product_id)
    return tuple(ids)


def _id_key(product_id: Any) -> str:
    return json.dumps(product_id, ensure_ascii=False, sort_keys=True, default=str)


def _returned_page(response: Mapping[str, Any], payload: Mapping[str, Any], *, requested_page: int) -> int | None:
    candidates = (
        payload,
        payload.get("pop"),
        response.get("pop"),
        response.get("data"),
        response,
    )
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        for name in ("page", "pageNo", "pageNum", "currentPage"):
            if name not in candidate:
                continue
            value = candidate[name]
            if isinstance(value, bool):
                break
            if isinstance(value, int):
                returned = value
            elif isinstance(value, str) and value.strip().isdigit():
                returned = int(value.strip())
            else:
                break
            if returned < 1:
                break
            if returned <= requested_page - 1:
                raise ZhihuiTmsPaginationError(
                    "tms_pagination_not_advancing",
                    f"智汇 TMS 商品列表页码不推进: requested={requested_page}; {_diagnostic(response)}",
                    payload=response,
                )
            if returned != requested_page:
                raise ZhihuiTmsPaginationError(
                    "tms_pagination_page_mismatch",
                    f"智汇 TMS 商品列表页码与请求不一致: requested={requested_page}; {_diagnostic(response)}",
                    payload=response,
                )
            return returned
    return None


def _extract_pop(response: Mapping[str, Any]) -> Any:
    if "pop" in response and response["pop"]:
        return response["pop"]
    data = response.get("data")
    if isinstance(data, Mapping) and data.get("pop"):
        return data["pop"]
    raise ZhihuiTmsPaginationError(
        "tms_export_pop_missing",
        f"智汇 TMS 导出响应缺少 pop: {_diagnostic(response)}",
        payload=response,
    )


def export_stockwarehouse_pages(
    client: ZhihuiTmsClient,
    *,
    max_pages: int = DEFAULT_MAX_PAGES,
    max_records: int = DEFAULT_MAX_RECORDS,
    max_requests: int = DEFAULT_MAX_REQUESTS,
    max_runtime: float = DEFAULT_MAX_RUNTIME,
    clock: Clock = time.monotonic,
    on_event: Callable[[dict[str, Any]], None] | None = None,
) -> ZhihuiTmsExportResult:
    """Fetch bounded product pages and request one export for each non-empty page."""
    _validate_limits(
        max_pages=max_pages,
        max_records=max_records,
        max_requests=max_requests,
        max_runtime=max_runtime,
    )
    started = clock()
    request_count = 0

    def check_runtime() -> None:
        elapsed = clock() - started
        if elapsed > max_runtime:
            raise ZhihuiTmsExportLimitError(
                "tms_export_runtime_limit",
                f"智汇 TMS 商品导出运行时间上限: {max_runtime:g}s",
            )

    def allow_request() -> None:
        nonlocal request_count
        check_runtime()
        if request_count >= max_requests:
            raise ZhihuiTmsExportLimitError(
                "tms_export_request_limit",
                f"智汇 TMS 商品导出请求数上限: {max_requests}",
            )
        request_count += 1

    pages: list[ZhihuiTmsExportPage] = []
    seen_ids: set[str] = set()
    reported_total: int | None = None
    page_number = 1

    while True:
        check_runtime()
        if len(pages) >= max_pages:
            raise ZhihuiTmsExportLimitError(
                "tms_export_page_limit",
                f"智汇 TMS 商品导出页数上限: {max_pages}",
            )
        allow_request()
        response = client.find_my_stockwarehouse_list(page=page_number)
        check_runtime()
        if not isinstance(response, Mapping):
            raise ZhihuiTmsPaginationError(
                "tms_pagination_response_invalid",
                f"智汇 TMS 商品列表响应不是对象: {_diagnostic(response)}",
                payload=response,
            )
        payload = _page_payload(response)
        total_num = _total_num(payload["totalNum"], response)
        if reported_total is None:
            reported_total = total_num
        elif reported_total != total_num:
            raise ZhihuiTmsPaginationError(
                "tms_pagination_total_changed",
                f"智汇 TMS 商品列表 totalNum 在分页中变化: {reported_total} -> {total_num}; 响应: {_diagnostic(response)}",
                payload=response,
            )
        if total_num > max_records:
            raise ZhihuiTmsExportLimitError(
                "tms_export_record_limit",
                f"智汇 TMS 商品导出记录数上限: {max_records}",
            )
        _returned_page(response, payload, requested_page=page_number)
        ids = _product_ids(payload["datas"], response)
        if not ids:
            break
        if total_num < len(ids):
            raise ZhihuiTmsPaginationError(
                "tms_pagination_total_too_small",
                f"智汇 TMS totalNum 小于当前页商品数: totalNum={total_num}; {_diagnostic(response)}",
                payload=response,
            )
        page_keys = [_id_key(product_id) for product_id in ids]
        if len(set(page_keys)) != len(page_keys) or any(key in seen_ids for key in page_keys):
            raise ZhihuiTmsPaginationError(
                "tms_pagination_duplicate_id",
                f"智汇 TMS 商品列表出现重复商品: {_diagnostic(response)}",
                payload=response,
            )
        if len(seen_ids) + len(ids) > max_records:
            raise ZhihuiTmsExportLimitError(
                "tms_export_record_limit",
                f"智汇 TMS 商品导出记录数上限: {max_records}",
            )
        seen_ids.update(page_keys)
        if on_event is not None:
            on_event({
                "stage": "listed", "page": page_number,
                "page_records": len(ids), "total_records": len(seen_ids),
            })

        allow_request()
        export_response = client.export_stockwarehouse(list(ids))
        check_runtime()
        if not isinstance(export_response, Mapping):
            raise ZhihuiTmsPaginationError(
                "tms_export_response_invalid",
                f"智汇 TMS 导出响应不是对象: {_diagnostic(export_response)}",
                payload=export_response,
            )
        _extract_pop(export_response)
        if on_event is not None:
            on_event({"stage": "exported", "page": page_number, "page_records": len(ids)})
        pages.append(
            ZhihuiTmsExportPage(
                page=page_number,
                product_ids=ids,
                response=export_response,
            )
        )

        if len(seen_ids) >= total_num or len(ids) < PAGE_SIZE:
            break
        page_number += 1

    return ZhihuiTmsExportResult(
        pages=tuple(pages),
        total_records=len(seen_ids),
        reported_total_num=reported_total if reported_total is not None else 0,
        request_count=request_count,
    )


__all__ = [
    "DEFAULT_MAX_PAGES",
    "DEFAULT_MAX_RECORDS",
    "DEFAULT_MAX_REQUESTS",
    "DEFAULT_MAX_RUNTIME",
    "PAGE_SIZE",
    "ZhihuiTmsExportLimitError",
    "ZhihuiTmsExportPage",
    "ZhihuiTmsExportResult",
    "ZhihuiTmsPaginationError",
    "export_stockwarehouse_pages",
]
