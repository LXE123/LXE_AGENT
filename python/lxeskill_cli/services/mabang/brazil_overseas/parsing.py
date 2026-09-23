"""ERP pagination and batch identity, grounded in captured 2026-09-23 HTML."""
import re
from dataclasses import dataclass
from bs4 import BeautifulSoup
from .errors import BrazilError
from .contracts import WAREHOUSE_ID, WAREHOUSE_NAME


@dataclass(frozen=True)
class Page:
    total: int
    current: int
    pages: int
    size: int
    start: int
    end: int


def pagination(payload, *, page, size):
    raw = payload.get('pageHtml')
    if not isinstance(raw, str):
        raise BrazilError('pagination_unknown', f'分页响应缺少 HTML pageHtml，实际字段: {sorted(payload)}')
    text = BeautifulSoup(raw, 'html.parser').get_text(' ', strip=True)
    match = re.search(r'共\s*(\d+)\s*条\s*当前显示第\s*(\d+)-(\d+)\s*条\s*(\d+)\s*/\s*(\d+)\s*页', text)
    per = re.search(r'每页\s*(\d+)\s*条', text)
    if not match or not per:
        raise BrazilError('pagination_unknown', f'无法识别实际分页文本: {text}')
    total, start, end, current, pages = map(int, match.groups())
    result = Page(total, current, pages, int(per[1]), start, end)
    if current != page or result.size != size or pages != max(1, (total + size - 1) // size):
        raise BrazilError('pagination_mismatch', f'请求 page={page}, size={size}; 实际 {result}')
    if total and (start != (page - 1) * size + 1 or end != min(page * size, total)):
        raise BrazilError('pagination_mismatch', f'分页区间异常: {result}')
    if not total and (start not in (0, 1) or end != 0):
        raise BrazilError('pagination_mismatch', f'零记录分页区间异常: {result}')
    return result


def allocation_records(payload):
    soup = BeautifulSoup(str(payload.get('message', '')), 'html.parser')
    records = {}
    for item in soup.select('input[name="allot[]"]'):
        identity, code = item.get('value', ''), item.get('data-code', '')
        if not identity.isdigit() or not code:
            raise BrazilError('coverage_schema_unknown', '调拨列表 allot[] 缺少数字 ID 或 data-code')
        if identity in records and records[identity] != code:
            raise BrazilError('coverage_mismatch', '同一调拨 ID 对应多个批次编号')
        records[identity] = code
    if len(set(records.values())) != len(records):
        raise BrazilError('coverage_mismatch', '多个调拨 ID 对应同一批次编号')
    return records


def inventory_sample(payload):
    soup = BeautifulSoup(str(payload.get('message', '')), 'html.parser')
    skus = set()
    for anchor in soup.select('a.shopStock[data-id]'):
        row = anchor.find_parent('ul')
        warehouse = row.select_one('.warehouseIds') if row else None
        if warehouse is None or warehouse.get('data-id') != WAREHOUSE_ID or warehouse.get_text(strip=True) != WAREHOUSE_NAME:
            raise BrazilError('warehouse_mismatch', '库存列表返回非巴西海外仓或无法识别仓库')
        skus.add(anchor.get_text(strip=True))
    return skus
