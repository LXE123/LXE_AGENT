from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup

from shared.infra.net import erp_http_session
from services.mabang import config as mabang_settings
from services.mabang.auth_constants import (
    MABANG_MEMCACHE_COOKIE_NAME as MEMCACHE_COOKIE_NAME,
    PRIVATE_AMZ_HOST,
    PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
)

from ...auth import get_auth_context
from ...cookies import build_cookie_header, extract_named_cookies, list_cookie_names
from ...errors import MabangAuthError, MabangBusinessError, MabangParseError, MabangRequestError

DEFAULT_STORE_LIST_URL = "https://private-amz.mabangerp.com/index.php"
DEFAULT_PRIVATE_AMZ_REFERER = "https://private-amz.mabangerp.com/"
DEFAULT_OUTPUT_DIR = Path("artifacts") / "mabang_fba_store_resolver"
AUTH_FAIL_STATUS = {401, 403}
SOURCE = "mabang_fba_store_resolver"
WHITESPACE_PATTERN = re.compile(r"\s+")
ID_TYPE_FBA_WAREHOUSE = "fbaWarehouseIds[]"
ID_TYPE_SHOP = "shopId"
QUERY_FIELD_FBA_WAREHOUSE = ID_TYPE_FBA_WAREHOUSE
QUERY_FIELD_SHOP = ID_TYPE_SHOP
STORE_XLSX_HEADERS = (
    "店铺名称",
    "ID",
    "ID类型",
    "父级店铺名称",
)


class FbaStoreResolverError(MabangBusinessError):
    pass


class FbaStoreResolverAuthError(FbaStoreResolverError, MabangAuthError):
    pass


class FbaStoreResolverParseError(FbaStoreResolverError, MabangParseError):
    pass


class FbaStoreMatchError(FbaStoreResolverError):
    def __init__(self, message: str, *, query: str, candidates: list[dict[str, str]] | None = None) -> None:
        super().__init__(message)
        self.query = str(query or "").strip()
        self.candidates = list(candidates or [])


class FbaStoreAmbiguousError(FbaStoreMatchError):
    pass


class FbaStoreNotFoundError(FbaStoreMatchError):
    pass


@dataclass(frozen=True)
class FbaStore:
    store_name: str
    store_id: str
    id_type: str = ID_TYPE_FBA_WAREHOUSE
    parent_store_name: str = ""
    parent_store_id: str = ""
    parent_id_type: str = ""

    @property
    def query_field(self) -> str:
        if self.id_type == ID_TYPE_SHOP:
            return QUERY_FIELD_SHOP
        return QUERY_FIELD_FBA_WAREHOUSE

    @property
    def warehouse_id(self) -> str:
        if self.id_type == ID_TYPE_FBA_WAREHOUSE:
            return self.store_id
        return ""

    @property
    def shop_id(self) -> str:
        if self.id_type == ID_TYPE_SHOP:
            return self.store_id
        return ""

    def to_payload(self) -> dict[str, str]:
        payload = {
            "store_name": self.store_name,
            "store_id": self.store_id,
            "id_type": self.id_type,
            "parent_store_name": self.parent_store_name,
        }
        return payload


@dataclass(frozen=True)
class FbaStoreListResult:
    stores: list[FbaStore]
    xlsx_path: str
    source: str = SOURCE

    @property
    def fba_warehouse_count(self) -> int:
        return count_fba_stores(self.stores)[ID_TYPE_FBA_WAREHOUSE]

    @property
    def shop_count(self) -> int:
        return count_fba_stores(self.stores)[ID_TYPE_SHOP]

    def to_payload(self) -> dict[str, Any]:
        return {
            "success": True,
            "store_count": len(self.stores),
            "fba_warehouse_count": self.fba_warehouse_count,
            "shop_count": self.shop_count,
            "xlsx_path": self.xlsx_path,
            "source": self.source,
        }


@dataclass(frozen=True)
class FbaStoreResolveResult:
    query: str
    match_status: str
    store: FbaStore
    source: str = SOURCE

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "success": True,
            "query": self.query,
            "match_status": self.match_status,
            "store_name": self.store.store_name,
            "store_id": self.store.store_id,
            "id_type": self.store.id_type,
            "parent_store_name": self.store.parent_store_name,
            "source": self.source,
        }
        return payload


@dataclass(frozen=True)
class FbaStoreResolverAuth:
    cookie_header: str
    c_m_key: str


def _configured_text(name: str, default: str) -> str:
    return mabang_settings.configured_text(name, default)


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _safe_file_part(value: Any) -> str:
    text = _clean_text(value)
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    return text.strip("._-") or "stores"


def _timestamp_text(value: datetime | None = None) -> str:
    return (value or datetime.now()).strftime("%Y%m%d_%H%M%S")


def _resolve_output_dir(output_dir: str | Path | None = None) -> Path:
    if output_dir is not None:
        path = Path(output_dir)
    else:
        configured = str(mabang_settings.MABANG_FBA_STORE_RESOLVER_OUTPUT_DIR or "").strip()
        path = Path(configured) if configured else DEFAULT_OUTPUT_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def normalize_store_name(value: Any) -> str:
    return WHITESPACE_PATTERN.sub("", _clean_text(value)).casefold()


def _store_payloads(stores: list[FbaStore]) -> list[dict[str, str]]:
    return [store.to_payload() for store in stores]


def parse_fba_store_options(html: str) -> list[FbaStore]:
    soup = BeautifulSoup(str(html or ""), "html.parser")
    stores: list[FbaStore] = []
    seen: set[tuple[str, str, str]] = set()

    def append_store(
        store_name: Any,
        store_id: Any,
        id_type: str,
        *,
        parent_store_name: Any = "",
        parent_store_id: Any = "",
        parent_id_type: Any = "",
    ) -> None:
        clean_name = _clean_text(store_name)
        clean_id = _clean_text(store_id)
        clean_type = _clean_text(id_type) or ID_TYPE_FBA_WAREHOUSE
        if not clean_id or not clean_name:
            return
        key = (clean_name, clean_id, clean_type)
        if key in seen:
            return
        seen.add(key)
        stores.append(
            FbaStore(
                store_name=clean_name,
                store_id=clean_id,
                id_type=clean_type,
                parent_store_name=_clean_text(parent_store_name),
                parent_store_id=_clean_text(parent_store_id),
                parent_id_type=_clean_text(parent_id_type),
            )
        )

    for li in soup.find_all("li"):
        input_tag = li.find("input", attrs={"name": QUERY_FIELD_FBA_WAREHOUSE})
        text_span = li.find("span", class_="texts")
        parent_store_name = ""
        parent_store_id = ""
        parent_id_type = ""
        if input_tag is not None and text_span is not None:
            parent_store_name = _clean_text(text_span.get_text())
            parent_store_id = _clean_text(input_tag.get("value"))
            parent_id_type = ID_TYPE_FBA_WAREHOUSE
            append_store(parent_store_name, parent_store_id, parent_id_type)

        for anchor in li.select(f'ul.dropdown-menu a[data-type="{QUERY_FIELD_SHOP}"][data-val]'):
            append_store(
                anchor.get_text(),
                anchor.get("data-val"),
                ID_TYPE_SHOP,
                parent_store_name=parent_store_name,
                parent_store_id=parent_store_id,
                parent_id_type=parent_id_type,
            )

    if not stores:
        raise FbaStoreResolverParseError("未解析到FBA店铺名称和ID")
    return stores


def count_fba_stores(stores: list[FbaStore]) -> dict[str, int]:
    return {
        ID_TYPE_FBA_WAREHOUSE: sum(1 for store in stores if store.id_type == ID_TYPE_FBA_WAREHOUSE),
        ID_TYPE_SHOP: sum(1 for store in stores if store.id_type == ID_TYPE_SHOP),
    }


def store_xlsx_row(store: FbaStore) -> list[str]:
    return [
        store.store_name,
        store.store_id,
        store.id_type,
        store.parent_store_name,
    ]


def write_fba_stores_xlsx(
    stores: list[FbaStore],
    *,
    output_dir: str | Path | None = None,
    filename_prefix: str = "fba_stores",
    timestamp: datetime | None = None,
) -> Path:
    try:
        from openpyxl import Workbook
    except Exception as exc:
        raise RuntimeError("缺少 openpyxl 依赖，无法写入FBA店铺xlsx") from exc

    directory = _resolve_output_dir(output_dir)
    target_path = directory / f"{_safe_file_part(filename_prefix)}_{_timestamp_text(timestamp)}.xlsx"
    workbook = Workbook()
    try:
        worksheet = workbook.active
        worksheet.title = "stores"
        worksheet.append(list(STORE_XLSX_HEADERS))
        for store in stores:
            worksheet.append(store_xlsx_row(store))
        workbook.save(target_path)
    finally:
        try:
            workbook.close()
        except Exception:
            pass
    return target_path


def match_fba_store(query: str, stores: list[FbaStore]) -> FbaStoreResolveResult:
    query_text = _clean_text(query)
    query_key = normalize_store_name(query_text)
    if not query_key:
        raise ValueError("store_name 不能为空")
    if not stores:
        raise FbaStoreNotFoundError("未找到FBA店铺: 店铺列表为空", query=query_text, candidates=[])

    exact_matches = [store for store in stores if normalize_store_name(store.store_name) == query_key]
    if len(exact_matches) == 1:
        return FbaStoreResolveResult(query=query_text, match_status="exact", store=exact_matches[0])
    if len(exact_matches) > 1:
        raise FbaStoreAmbiguousError(
            f"店铺名匹配到多个FBA店铺: query={query_text}, count={len(exact_matches)}",
            query=query_text,
            candidates=_store_payloads(exact_matches),
        )

    contains_matches = [store for store in stores if query_key in normalize_store_name(store.store_name)]
    if len(contains_matches) == 1:
        return FbaStoreResolveResult(query=query_text, match_status="contains", store=contains_matches[0])
    if len(contains_matches) > 1:
        raise FbaStoreAmbiguousError(
            f"店铺名不唯一: query={query_text}, count={len(contains_matches)}",
            query=query_text,
            candidates=_store_payloads(contains_matches),
        )

    raise FbaStoreNotFoundError(
        f"未找到FBA店铺: query={query_text}",
        query=query_text,
        candidates=[],
    )


async def resolve_fba_store_auth() -> FbaStoreResolverAuth:
    context = await get_auth_context(scope="private_amz")
    cookie_header = build_cookie_header(
        context.cookies_by_domain,
        request_host=PRIVATE_AMZ_HOST,
        extra_cookies={"mabang_lite_rowsPerPage": "100"},
    )
    if not cookie_header:
        raise FbaStoreResolverAuthError("未获取到 private-amz.mabangerp.com Cookie")

    cookie_names = set(
        list_cookie_names(
            context.cookies_by_domain,
            request_host=PRIVATE_AMZ_HOST,
            extra_cookies={"mabang_lite_rowsPerPage": "100"},
        )
    )
    missing = [name for name in PRIVATE_AMZ_REQUIRED_COOKIE_NAMES if name not in cookie_names]
    if missing:
        raise FbaStoreResolverAuthError(f"缺少 private-amz 关键 Cookie: {', '.join(missing)}")

    values = extract_named_cookies(context.cookies_by_domain, (MEMCACHE_COOKIE_NAME,))
    c_m_key = _clean_text(values.get(MEMCACHE_COOKIE_NAME))
    if not c_m_key:
        raise FbaStoreResolverAuthError(f"缺少关键 Cookie: {MEMCACHE_COOKIE_NAME}")

    return FbaStoreResolverAuth(cookie_header=cookie_header, c_m_key=c_m_key)


def _store_list_url() -> str:
    return _configured_text("MABANG_FBA_STORE_LIST_URL", DEFAULT_STORE_LIST_URL)


def _store_list_params(c_m_key: str) -> list[tuple[str, str]]:
    return [
        ("mod", "fbanew.list"),
        ("platform", "amazon"),
        ("version", "1"),
        ("cMKey", c_m_key),
        ("fromTest", "111"),
        ("lang", "cn"),
        ("tz", "UTC+8"),
        ("DOMAIN", "private.mabangerp.com"),
    ]


def _request_headers(cookie_header: str) -> dict[str, str]:
    return {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8",
        "Referer": _configured_text("MABANG_FBA_STORE_LIST_REFERER", DEFAULT_PRIVATE_AMZ_REFERER),
        "Cookie": cookie_header,
    }


async def _read_store_html(resp: Any) -> str:
    status_code = int(getattr(resp, "status", 0) or 0)
    text = await resp.text()
    if status_code in AUTH_FAIL_STATUS:
        raise FbaStoreResolverAuthError(f"获取FBA店铺列表鉴权失败(status={status_code})")
    if status_code >= 400:
        msg = text[:300] if text else "empty response"
        raise MabangRequestError(f"获取FBA店铺列表请求失败(status={status_code}): {msg}")
    if not _clean_text(text):
        raise FbaStoreResolverParseError("获取FBA店铺列表返回空HTML")
    return text


async def fetch_fba_stores() -> list[FbaStore]:
    auth = await resolve_fba_store_auth()
    async with erp_http_session.get(
        _store_list_url(),
        params=_store_list_params(auth.c_m_key),
        headers=_request_headers(auth.cookie_header),
    ) as resp:
        html = await _read_store_html(resp)
    return parse_fba_store_options(html)


async def list_fba_stores(*, output_dir: str | Path | None = None) -> FbaStoreListResult:
    stores = await fetch_fba_stores()
    xlsx_path = write_fba_stores_xlsx(stores, output_dir=output_dir)
    return FbaStoreListResult(stores=stores, xlsx_path=str(xlsx_path))


async def resolve_fba_store(store_name: str) -> FbaStoreResolveResult:
    return match_fba_store(store_name, await fetch_fba_stores())


__all__ = [
    "FbaStore",
    "FbaStoreAmbiguousError",
    "FbaStoreListResult",
    "FbaStoreMatchError",
    "FbaStoreNotFoundError",
    "FbaStoreResolveResult",
    "FbaStoreResolverAuth",
    "FbaStoreResolverAuthError",
    "FbaStoreResolverError",
    "FbaStoreResolverParseError",
    "ID_TYPE_FBA_WAREHOUSE",
    "ID_TYPE_SHOP",
    "QUERY_FIELD_FBA_WAREHOUSE",
    "QUERY_FIELD_SHOP",
    "STORE_XLSX_HEADERS",
    "count_fba_stores",
    "fetch_fba_stores",
    "list_fba_stores",
    "match_fba_store",
    "normalize_store_name",
    "parse_fba_store_options",
    "resolve_fba_store",
    "resolve_fba_store_auth",
    "store_xlsx_row",
    "write_fba_stores_xlsx",
]
