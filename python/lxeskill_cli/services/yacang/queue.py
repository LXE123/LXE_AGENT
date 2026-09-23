"""Match the actual report/warehouse/filter on a newly created export task."""
from __future__ import annotations

from datetime import date, datetime, time as day_time, timedelta
import json
import time
from zoneinfo import ZoneInfo
from .contracts import REPORTS, WAREHOUSES
from .errors import YacangError


def conditions(value):
    if isinstance(value, list):
        if len(value) >= 3 and isinstance(value[0], str) and isinstance(value[1], str):
            yield value[:3]
        else:
            for child in value:
                yield from conditions(child)
    elif isinstance(value, dict):
        for key, child in value.items():
            if isinstance(child, (dict, list)):
                yield from conditions(child)
            else:
                yield [key, "=", child]


def matches(row, task):
    _, _, kind, name = REPORTS[task['report']]
    if str(row.get('type')) != kind or row.get('name') != name:
        return False
    try:
        where = row.get('param_where')
        where = json.loads(where) if isinstance(where, str) else where
    except ValueError:
        return False
    if not isinstance(where, (dict, list)):
        return False
    terms = list(conditions(where))
    # Refuse unrequested product/search filters instead of silently exporting a subset.
    if any(t[0] not in {'warehouse_id', 'create_time', 'user_id', 'sku_condition', 'goods_sku_condition', 'status'} for t in terms):
        return False
    def exact(field, expected, required=False):
        values = [t for t in terms if t[0] == field]
        return (bool(values) or not required) and all(op == '=' and str(value) == expected for _, op, value in values)
    if not exact('sku_condition', '1') or not exact('goods_sku_condition', '2'):
        return False
    if task['report'] == 'warehouse-products':
        if not exact('status', '1', required=True):
            return False
    elif any(t[0] == 'status' for t in terms):
        return False
    if task['report'] == 'inventory-current-snapshot' and not exact('goods_sku_condition', '2', required=True):
        return False
    warehouse = task['warehouse']
    wterms = [t for t in terms if t[0] == 'warehouse_id']
    if warehouse:
        expected = str(WAREHOUSES[warehouse][0])
        if not wterms or any(op not in ('=', 'in') or {str(x) for x in (value if isinstance(value, list) else [value])} != {expected} for _, op, value in wterms):
            return False
    elif wterms:
        return False
    dates = [t for t in terms if t[0] == 'create_time']
    created = task['created_date']
    if not created:
        if dates:
            raise YacangError('导出范围', f'请求未限制创建日期，但平台任务 {row.get("id")} 实际含创建时间筛选；请明确所需日期范围', code='date_range_required', scope='global')
        return True
    def epoch(day):
        return int(datetime.combine(day, day_time.min, ZoneInfo('Asia/Shanghai')).timestamp())
    expected = [('>=', epoch(date.fromisoformat(created['start_date']))),
                ('<', epoch(date.fromisoformat(created['end_date']) + timedelta(days=1)))]
    try:
        return sorted((op, int(value)) for _, op, value in dates) == sorted(expected)
    except (ValueError, TypeError):
        return False


def wait_for_file(client, task, baseline, *, timeout=180, interval=5):
    deadline = time.monotonic() + timeout
    while True:
        rows = client.list_downloads()
        candidates = [r for r in rows if str(r['id']) not in baseline and matches(r, task)]
        if len(candidates) > 1:
            raise YacangError('导出队列', f'同一条件匹配多个新任务: {[r["id"] for r in candidates]}', code='queue_unknown', scope='global')
        if candidates:
            path = candidates[0].get('path')
            if isinstance(path, str) and path.strip():
                return path
        if time.monotonic() >= deadline:
            raise YacangError('导出队列', client.diagnostic(f'等待文件超时；匹配的新任务: {candidates}；本轮同类任务: {[r for r in rows if str(r["id"]) not in baseline and str(r.get("type")) == REPORTS[task["report"]][2]]}'), code='queue_unknown', scope='global')
        time.sleep(interval)
