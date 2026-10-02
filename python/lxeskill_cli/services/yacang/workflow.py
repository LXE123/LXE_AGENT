from __future__ import annotations

from datetime import datetime
from contextlib import ExitStack
import uuid
import os
from xml.etree import ElementTree
from zipfile import ZipFile
from zoneinfo import ZoneInfo
from openpyxl import load_workbook
from shared.datasets import dataset_dir
from shared.filesystem import display_path, filesystem_path
from .client import YacangClient
from .contracts import Credentials, REPORTS, WAREHOUSES, normalize, tasks_for, task_key, export_parameters
from .errors import YacangError, safe_remote_detail
from .queue import wait_for_file
from .state import ExportState
from .validation import INVENTORY_SALES_HEADERS, validate_inventory_sales_workbook, validate_inventory_list_workbook, validate_warehouse_products_workbook


def validate(path, task, diagnostic):
    if task['report'] == 'inventory-sales':
        count = validate_inventory_sales_workbook(path, warehouse_code=task['warehouse'], diagnostic=diagnostic)
    elif task['report'] == 'inventory-current-snapshot':
        count = validate_inventory_list_workbook(path, warehouse_code=task['warehouse'], diagnostic=diagnostic)
    else:
        count = validate_warehouse_products_workbook(path, diagnostic=diagnostic)
    with filesystem_path(path).open("rb") as source:
        wb = load_workbook(source, read_only=True)
        try:
            return {'row_count': count, 'sheet_names': wb.sheetnames}
        finally:
            wb.close()


def publish_inventory_sales_without_snapshot_date(original, temporary, target):
    with filesystem_path(original).open("rb") as source:
        workbook = load_workbook(source, read_only=True, data_only=True)
        try:
            if len(workbook.sheetnames) != 1 or workbook.active.cell(1, len(INVENTORY_SALES_HEADERS)).value != "创建日期":
                raise YacangError("处理库存动销 XLSX", "原始报表缺少预期的创建日期末列")
        finally:
            workbook.close()

    namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    prefix = f"{{{namespace}}}"
    ElementTree.register_namespace("", namespace)
    with filesystem_path(original).open("rb") as source, ZipFile(source) as package:
        sheets = [name for name in package.namelist() if name.startswith("xl/worksheets/") and name.endswith(".xml")]
        if len(sheets) != 1:
            raise YacangError("处理库存动销 XLSX", f"工作表 XML 数量异常: {len(sheets)}")
        sheet_name = sheets[0]
        sheet = ElementTree.fromstring(package.read(sheet_name))
        dimension = sheet.find(prefix + "dimension")
        if dimension is None or not (dimension.get("ref") or "").startswith("A1:P"):
            raise YacangError("处理库存动销 XLSX", "原始报表列范围不是预期的 A1:P")
        dimension.set("ref", "A1:O" + dimension.get("ref")[4:])
        sheet_data = sheet.find(prefix + "sheetData")
        if sheet_data is None:
            raise YacangError("处理库存动销 XLSX", "原始报表缺少工作表数据")
        removed_header = False
        for row in sheet_data.findall(prefix + "row"):
            for cell in list(row):
                reference = cell.get("r", "")
                if cell.tag == prefix + "c" and reference == f"P{row.get('r')}":
                    removed_header |= reference == "P1"
                    row.remove(cell)
            if row.get("spans") == "1:16":
                row.set("spans", "1:15")
        if not removed_header:
            raise YacangError("处理库存动销 XLSX", "原始报表缺少创建日期表头单元格")
        modified_sheet = ElementTree.tostring(sheet, encoding="utf-8", xml_declaration=True)
        with filesystem_path(temporary).open("xb") as output, ZipFile(output, "w") as published:
            for member in package.infolist():
                published.writestr(member, modified_sheet if member.filename == sheet_name else package.read(member.filename))
    temporary.replace(target)


def run(arguments):
    artifacts, tasks, client = [], [], None
    locks = ExitStack()
    try:
        if set(arguments) != {'params'}:
            raise YacangError('参数校验', '必须提供 params，且不接受其他顶层参数', code='invalid_arguments')
        params = normalize(arguments['params'])
        credentials = Credentials.from_environment()
        state = ExportState(credentials.account_id)
        planned = tasks_for(params)
        tasks = [{**t, 'status': 'not_run', 'filters': export_parameters(t)} for t in planned]
        locks.enter_context(state.run_lock())
        client = YacangClient(credentials, state)
        client.login()
        folder = filesystem_path(dataset_dir("yacang_exports", credentials.account_id, uuid.uuid4().hex))
        folder.mkdir(parents=True, exist_ok=False)
        for task in tasks:
            spec = {k: task[k] for k in ('report', 'warehouse', 'created_date')}
            key = task_key(credentials.account_id, spec)
            temporary = None
            try:
                with state.task_lock(key):
                    baseline = state.pending(key)
                    if baseline is None:
                        baseline = {str(r['id']) for r in client.list_downloads()}
                        state.begin(key, baseline)
                        try:
                            client.submit(spec)
                        except YacangError as exc:
                            if exc.code in {'date_range_required', 'remote_error', 'login_required', 'forbidden', 'rate_limited'}:
                                state.clear(key)  # Explicit platform rejection, no accepted export.
                            raise
                    # An interrupted/uncertain submission resumes read-only queue checks.
                    url = wait_for_file(client, spec, baseline)
                    # A ready file proves the remote task completed, even if download later fails.
                    state.clear(key)
                    name = REPORTS[spec['report']][0]
                    warehouse_name = '_' + WAREHOUSES[spec['warehouse']][1] if spec['warehouse'] else ''
                    filename = f'雅仓-{name}{warehouse_name}-{datetime.now(ZoneInfo("Asia/Shanghai")):%Y%m%d-%H%M%S}.xlsx'
                    target = folder / filename
                    temporary = folder / ('.' + filename)
                    client.download(url, temporary)
                    metadata = validate(temporary, spec, client.diagnostic)
                    if spec['report'] == 'inventory-sales':
                        original = folder / 'original' / filename
                        original.parent.mkdir(exist_ok=True)
                        temporary.replace(original)
                        publish_inventory_sales_without_snapshot_date(original, temporary, target)
                    else:
                        temporary.replace(target)
                    artifact = {**spec, **metadata, 'filters': export_parameters(spec), 'path': str(display_path(target.resolve())), 'filename': filename,
                                'source': 'yacang', 'notice': '没有数据行' if metadata['row_count'] == 0 else ''}
                    artifacts.append(artifact)
                    task.update(status='completed', artifact_path=artifact['path'], row_count=metadata['row_count'])
            except Exception as exc:
                error = {'code': getattr(exc, 'code', 'export_failed'), 'message': client.diagnostic(f'{type(exc).__name__}: {exc}')}
                if temporary is not None:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError as cleanup:
                        error['cleanup_error'] = client.diagnostic(f'{type(cleanup).__name__}: {cleanup}')
                task.update(status='failed', error=error)
                if getattr(exc, 'scope', 'global') == 'global':
                    break
        failed = [t for t in tasks if t['status'] != 'completed']
        result = {'success': not failed, 'status': 'partial_success' if failed and artifacts else 'failed' if failed else 'completed',
                  'params': params, 'tasks': tasks, 'artifacts': artifacts, 'auth_refresh_required': False}
        if failed:
            result['error'] = next(t['error'] for t in tasks if t.get('error'))
        return result
    except Exception as exc:
        message = client.diagnostic(f'{type(exc).__name__}: {exc}') if client else safe_remote_detail(f'{type(exc).__name__}: {exc}', secrets=tuple(os.getenv(k, '') for k in ('LXE_YACANG_MOBILE', 'LXE_YACANG_PASSWORD')))
        return {'success': False, 'status': 'failed', 'tasks': tasks, 'artifacts': artifacts, 'auth_refresh_required': False,
                'error': {'code': getattr(exc, 'code', 'export_failed'), 'message': message}}
    finally:
        if client:
            client.close()
        locks.close()
