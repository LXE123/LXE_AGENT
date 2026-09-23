"""Captured PR #65 export template; no authentication material."""

WAREHOUSE_ID = "1072376"
WAREHOUSE_NAME = "巴西海外仓"
REPORTS = {
 "inventory_sales_snapshot": "库存动销",
 "allocation_pending_default_3m": "三个月内待签收",
 "allocation_signed_before_3m": "三个月前已签收",
}

ALLOCATION_FIELDLABELS = ('uq102', 'uq103', 'uq108', 'uq109', 'uq110', 'uq201', 'uq202', 'uq203', 'uq204', 'uq205', 'uq207', 'uq2072', 'uq208', 'uq209', 'uq301', 'uq302', 'uq304')

ALLOCATION_EXPORT_FIELDS = (('批次编号', 'uq101'), ('签收日期', 'uq301'), ('目标仓位', 'uq302'), ('签收量', 'uq304'), ('库存SKU', 'uq201'), ('中文名称', 'uq202'), ('重量', 'uq203'), ('体积重', 'uq204'), ('起始仓位', 'uq205'), ('调拨数量', 'uq207'), ('单价(RMB)', 'uq2072'), ('待签收数量', 'uq208'), ('总入库数量', 'uq209'), ('起始仓库', 'uq102'), ('目标仓库', 'uq103'), ('发货日期', 'uq108'), ('预期到货日期', 'uq109'), ('最近签收日期', 'uq110'))

def _export_form_data(*, memcache_key: str, order_ids: str) -> list[tuple[str, str]]:
    form: list[tuple[str, str]] = [('mod', 'export.doAllocationWarehouseExportFile'), ('backUrl', ''), ('orderIds', order_ids)]
    form.extend((('fieldlabel', field) for field in ALLOCATION_FIELDLABELS))
    for name, field in ALLOCATION_EXPORT_FIELDS:
        form.extend([('map-name[]', name), ('map-uq[]', field), ('map-text[]', '')])
    form.extend([('templateName', ''), ('templateId', '1058049'), ('datasOpen', '2'), ('memcacheKey', memcache_key), ('showRmbColumn', '0'), ('pageSave', '1'), ('operateType', '17'), ('params', ''), ('InterfaceUrl', ''), ('mainMenu', ''), ('hiddenPage', ''), ('hiddenPageSize', ''), ('tableBase', ''), ('isMerage', '1'), ('showRmbColumn', '0')])
    return form


def inventory_form() -> list[tuple[str, str]]:
    """Return only the values confirmed by the Brazil warehouse capture."""
    return [('stockOrderby', ''), ('search-content', 'stocksku'), ('stockQuantitytype', 'stockQuantitygt'), ('stockWarningQuantitytype', 'stockWarningQuantitygt'), ('saleAvailableDaystype', 'saleAvailableDaysgt'), ('showstart', '1'), ('timeField', 'updateDate2'), ('warehouseMold', 'all'), ('page', '1'), ('warehouseId', 'undefined'), ('isIdn', '1'), ('warehouseIdArr', WAREHOUSE_ID)]


def allocation_form(kind: str) -> list[tuple[str, str]]:
    return [('mod', 'warehouseallocation.searchallocation'), ('orderBys[]', ''), ('warehouseMold', 'all'), ('startWarehouseIdStr', ''), ('targetWarehouseIdStr', ''), ('search-content1', 'allocationCode'), ('search-content-text1', ''), ('tablebase', ('2' if kind == 'allocation_signed_before_3m' else '')), ('Orderby', ''), ('startWarehouseIdStr', ''), ('third_in_status', 'undefined'), ('third_out_status', 'undefined'), ('page', '1'), ('rowsPerPage', '20'), ('type', '2'), ('allocationstatus', ('4' if kind == 'allocation_signed_before_3m' else '2')), ('startwarhouseId', ''), ('targetwarhouseId', WAREHOUSE_ID), ('timetype', 'timeCreated'), ('datepickerfrom', ''), ('datepickerto', ''), ('isBatchSearch', '0'), ('selecttype', 'allocationCode'), ('stockData', ''), ('orderbysVal', ''), ('orderbydac', ''), ('auditStatus', '0'), ('labelId', ''), ('freight_set', ''), ('transportType', '')]
