from __future__ import annotations

from typing import Any

import pytest

from services.zhihui_tms.errors import ZhihuiTmsApiError
from services.zhihui_tms.product_export import (
    ZhihuiTmsExportLimitError,
    ZhihuiTmsPaginationError,
    export_stockwarehouse_pages,
)


class FakeProductClient:
    def __init__(self, pages: dict[int, dict[str, Any]], *, export_response: dict[str, Any] | None = None) -> None:
        self.pages = pages
        self.export_response = export_response or {"code": "200", "pop": "fixture-export-url"}
        self.list_calls: list[int] = []
        self.export_calls: list[list[Any]] = []

    def find_my_stockwarehouse_list(self, *, page: int) -> dict[str, Any]:
        self.list_calls.append(page)
        return self.pages[page]

    def export_stockwarehouse(self, product_ids: list[Any]) -> dict[str, Any]:
        self.export_calls.append(list(product_ids))
        return self.export_response


def list_fixture(page: int, ids: list[Any], total_num: int, *, returned_page: int | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "code": "200",
        "datas": [{"id": item} for item in ids],
        "totalNum": total_num,
        "pop": {"totalPage": 2, "totalNum": total_num},
    }
    if returned_page is not None:
        payload["page"] = returned_page
    return payload


def test_paginates_and_exports_each_page_until_total_is_reached() -> None:
    client = FakeProductClient(
        {
            1: list_fixture(1, list(range(1000)), 1001),
            2: list_fixture(2, [1000], 1001),
        }
    )

    result = export_stockwarehouse_pages(client)

    assert [page.page for page in result.pages] == [1, 2]
    assert [len(page.product_ids) for page in result.pages] == [1000, 1]
    assert result.pages[0].pop == "fixture-export-url"
    assert result.total_records == 1001
    assert result.reported_total_num == 1001
    assert result.request_count == 4
    assert client.list_calls == [1, 2]
    assert client.export_calls == [list(range(1000)), [1000]]


def test_progress_reports_only_validated_lists_and_successful_exports() -> None:
    client = FakeProductClient({1: list_fixture(1, [101, 102], 2)})
    events: list[dict[str, Any]] = []

    export_stockwarehouse_pages(client, on_event=events.append)

    assert events == [
        {"stage": "listed", "page": 1, "page_records": 2, "total_records": 2},
        {"stage": "exported", "page": 1, "page_records": 2},
    ]
    assert "fixture-export-url" not in str(events)

    failed = FakeProductClient({1: list_fixture(1, [101], 1)}, export_response={"code": "200"})
    failed_events: list[dict[str, Any]] = []
    with pytest.raises(ZhihuiTmsPaginationError, match="pop"):
        export_stockwarehouse_pages(failed, on_event=failed_events.append)
    assert failed_events == [{"stage": "listed", "page": 1, "page_records": 1, "total_records": 1}]


def test_empty_page_is_successful_and_does_not_export() -> None:
    client = FakeProductClient({1: list_fixture(1, [], 0)})

    result = export_stockwarehouse_pages(client)

    assert result.pages == ()
    assert result.total_records == 0
    assert result.reported_total_num == 0
    assert result.request_count == 1
    assert client.export_calls == []


def test_short_page_stops_even_when_reported_total_is_larger() -> None:
    client = FakeProductClient({1: list_fixture(1, [1, 2], 99)})

    result = export_stockwarehouse_pages(client)

    assert [page.product_ids for page in result.pages] == [(1, 2)]
    assert result.request_count == 2
    assert client.list_calls == [1]


def test_duplicate_product_ids_are_rejected_before_reexporting() -> None:
    client = FakeProductClient(
        {
            1: list_fixture(1, list(range(1000)), 2000),
            2: list_fixture(2, list(range(1000)), 2000),
        }
    )

    with pytest.raises(ZhihuiTmsPaginationError, match="重复"):
        export_stockwarehouse_pages(client)

    assert len(client.export_calls) == 1


def test_inconsistent_total_and_invalid_product_id_are_rejected() -> None:
    changing_total = FakeProductClient(
        {
            1: list_fixture(1, list(range(1000)), 2000),
            2: list_fixture(2, [1000], 2001),
        }
    )
    with pytest.raises(ZhihuiTmsPaginationError, match="totalNum"):
        export_stockwarehouse_pages(changing_total)

    invalid_id = FakeProductClient({1: {"code": "200", "datas": [{"sku": "SKU-7"}], "totalNum": 1}})
    with pytest.raises(ZhihuiTmsPaginationError, match="缺少 id"):
        export_stockwarehouse_pages(invalid_id)


def test_non_advancing_response_page_and_missing_export_pop_are_rejected() -> None:
    non_advancing = FakeProductClient(
        {
            1: list_fixture(1, list(range(1000)), 2000),
            2: list_fixture(2, [1000], 2000, returned_page=1),
        }
    )
    with pytest.raises(ZhihuiTmsPaginationError, match="不推进"):
        export_stockwarehouse_pages(non_advancing)

    missing_pop = FakeProductClient(
        {1: list_fixture(1, [1], 1)},
        export_response={"code": "200", "data": None},
    )
    with pytest.raises(ZhihuiTmsPaginationError, match="pop"):
        export_stockwarehouse_pages(missing_pop)


@pytest.mark.parametrize(
    ("limits", "message"),
    [
        ({"max_pages": 1}, "页数上限"),
        ({"max_records": 999}, "记录数上限"),
        ({"max_requests": 1}, "请求数上限"),
    ],
)
def test_hard_limits_stop_before_an_unbounded_next_step(limits: dict[str, Any], message: str) -> None:
    client = FakeProductClient(
        {
            1: list_fixture(1, list(range(1000)), 1001),
            2: list_fixture(2, [1000], 1001),
        }
    )

    with pytest.raises(ZhihuiTmsExportLimitError, match=message):
        export_stockwarehouse_pages(client, **limits)


def test_runtime_limit_is_checked_with_an_injected_clock() -> None:
    now = [0.0]

    def clock() -> float:
        return now[0]

    class AdvancingClient(FakeProductClient):
        def find_my_stockwarehouse_list(self, *, page: int) -> dict[str, Any]:
            now[0] += 2.0
            return super().find_my_stockwarehouse_list(page=page)

    client = AdvancingClient({1: list_fixture(1, [1], 1)})

    with pytest.raises(ZhihuiTmsExportLimitError, match="运行时间上限"):
        export_stockwarehouse_pages(client, max_runtime=1.0, clock=clock)


def test_existing_client_error_is_not_replaced_with_a_generic_message() -> None:
    class FailingClient(FakeProductClient):
        def find_my_stockwarehouse_list(self, *, page: int) -> dict[str, Any]:
            raise ZhihuiTmsApiError("tms_business_error", "warehouse list rejected: fixture-id-42")

    with pytest.raises(ZhihuiTmsApiError, match="fixture-id-42"):
        export_stockwarehouse_pages(FailingClient({}))
