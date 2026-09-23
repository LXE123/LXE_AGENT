from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import hashlib
import json
import os
from .errors import YacangError

# Platform warehouse IDs verified by PR #65; never accept arbitrary IDs from callers.
WAREHOUSES = {"MY8801": (26, "马来西亚仓"), "PH8805": (46, "菲律宾仓"),
              "TH8802": (47, "泰国仓"), "VN8806": (80, "越南仓")}
REPORTS = {
    "inventory-sales": ("库存动销", "/sys/customer/mrpPrepare/export", "10", "库存动销导出"),
    "inventory-current-snapshot": ("当前库存", "/sys/customer/stockWarehouse/export", "1", "库存导出"),
    "warehouse-products": ("仓库产品资料", "/sys/customer/sku/export", "6", "资料导出"),
}


@dataclass(frozen=True, repr=False)
class Credentials:
    mobile: str
    password: str

    @classmethod
    def from_environment(cls):
        mobile, password = os.getenv("LXE_YACANG_MOBILE", "").strip(), os.getenv("LXE_YACANG_PASSWORD", "")
        if not mobile or not password:
            raise YacangError("读取配置", "桌面设置中缺少雅仓手机号或密码", code="credentials_required", scope="global")
        return cls(mobile, password)

    @property
    def account_id(self):
        return hashlib.sha256(self.mobile.encode()).hexdigest()


def normalize(params):
    def invalid(message):
        raise YacangError("参数校验", message, code="invalid_arguments", scope="global")
    if not isinstance(params, dict) or set(params) - {"reports", "warehouses", "created_date"}:
        invalid("params 仅接受 reports、warehouses 和 created_date")
    def selection(name, allowed, default=None):
        raw = params.get(name, default)
        if not isinstance(raw, list) or not raw or any(not isinstance(v, str) or v not in allowed for v in raw):
            invalid(f"{name} 必须是非空数组，可选值: {', '.join(allowed)}")
        return [v for v in allowed if v in raw]
    reports = selection("reports", REPORTS)
    warehouses = selection("warehouses", WAREHOUSES, list(WAREHOUSES))
    if reports == ["warehouse-products"] and "warehouses" in params:
        invalid("仓库产品资料是全局报表，不支持按仓筛选；接受全局范围后请省略 warehouses")
    created = params.get("created_date")
    if "created_date" in params:
        if "inventory-sales" not in reports or not isinstance(created, dict) or set(created) != {"start_date", "end_date"}:
            invalid("created_date 仅用于库存动销，须同时提供 start_date 和 end_date")
        try:
            start, end = (date.fromisoformat(created[k]) for k in ("start_date", "end_date"))
            if start > end or start.isoformat() != created["start_date"] or end.isoformat() != created["end_date"]:
                raise ValueError("日期顺序或格式错误")
        except (ValueError, TypeError) as exc:
            invalid(f"创建日期须为 YYYY-MM-DD 且开始不晚于结束: {exc}")
    return {"reports": reports, "warehouses": warehouses, "created_date": created}


def tasks_for(params):
    return [{"report": report, "warehouse": warehouse,
             "created_date": params["created_date"] if report == "inventory-sales" else None}
            for report in params["reports"]
            for warehouse in ([None] if report == "warehouse-products" else params["warehouses"])]


def task_key(account_id, task):
    return hashlib.sha256(json.dumps([account_id, task], sort_keys=True).encode()).hexdigest()


def export_parameters(task):
    """Exact non-secret platform filters, also retained in result metadata."""
    params = {"page": 1, "limit": 10}
    if task["warehouse"]:
        params["warehouse_id"] = WAREHOUSES[task["warehouse"]][0]
    if task["report"] == "inventory-sales":
        params["sku_condition"] = 1
        if task["created_date"]:
            created = task["created_date"]
            params["create_time"] = f"{created['start_date']} - {created['end_date']}"
    else:
        params["goods_sku_condition"] = 2
        if task["report"] == "warehouse-products":
            params["status"] = 1
    return params
