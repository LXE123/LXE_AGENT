from __future__ import annotations
import asyncio
from datetime import datetime
import json
import uuid
from zoneinfo import ZoneInfo
from shared.datasets import dataset_dir
from shared.process_lock import InterProcessLockTimeout
from shared.infra.net.aiohttp_client import HttpSessionRegistry
from services.mabang import config
from services.mabang.auth import get_existing_auth_context
from services.mabang.errors import MabangAuthError
from services.mabang.export_lock import account_digest, warehouse_export_lock
from .client import BrazilClient
from .contracts import REPORTS, WAREHOUSE_ID, WAREHOUSE_NAME, inventory_form, allocation_form
from .errors import BrazilError, diagnostic
from .parsing import pagination, allocation_records, inventory_sample
from .workbooks import validate, publish

MAX_PAGES = 1000
TIME_BUDGET = 900


def normalize(arguments):
    if set(arguments) != {'params'}:
        raise BrazilError('invalid_arguments','必须只提供 params')
    params = arguments['params']
    if isinstance(params,str):
        params = json.loads(params)
    if not isinstance(params,dict) or set(params) != {'reports'}:
        raise BrazilError('invalid_arguments','params 只接受 reports')
    reports = params['reports']
    if not isinstance(reports,list) or not reports or any(not isinstance(r,str) or r not in REPORTS for r in reports):
        raise BrazilError('invalid_arguments',f'reports 必须是非空数组，枚举: {list(REPORTS)}')
    return list(dict.fromkeys(reports))


def artifact(folder, report, body, metadata, *, batch=1):
    name = f'马帮-巴西海外仓-{REPORTS[report]}-第{batch:03d}批-{datetime.now(ZoneInfo("Asia/Shanghai")):%Y%m%d-%H%M%S}.{metadata["extension"]}'
    target = folder / name
    publish(target,body)
    return {**metadata,'report':report,'batch':batch,'path':str(target.resolve()),'filename':name,'source':'mabang_erp','original':True}


def validate_download(folder, body, report, **kwargs):
    try:
        return validate(body, report, **kwargs)
    except Exception as exc:
        # Quarantine for diagnosis only; never register this path in artifacts/files.
        path = folder / ('.rejected-' + report + '-' + uuid.uuid4().hex + '.bin')
        try:
            publish(path, body)
            path.chmod(0o600)
        except OSError as write_error:
            raise BrazilError(getattr(exc, 'code', 'validation_failed'), f'{exc}; 异常原件留存也失败: {write_error}') from exc
        raise


async def execute(arguments):
    tasks, artifacts, client = [], [], None
    try:
        reports = normalize(arguments)
        tasks = [{'report':r,'status':'not_run','warehouse_id':WAREHOUSE_ID,'warehouse':WAREHOUSE_NAME,
                  'filters':dict(inventory_form() if r == 'inventory_sales_snapshot' else allocation_form(r)),
                  'time_scope': '当前快照' if r == 'inventory_sales_snapshot' else REPORTS[r]+'（平台页面快捷筛选，不推断为签收日期）',
                  'completed_batches':0,'exported_document_count':0} for r in reports]
        async with asyncio.timeout(TIME_BUDGET):
            context = await get_existing_auth_context(purpose='brazil_overseas_export')
            client = BrazilClient(context)
            with warehouse_export_lock(context.account):
                folder = dataset_dir("mabang_brazil_exports",account_digest(context.account),uuid.uuid4().hex)
                folder.mkdir(parents=True,exist_ok=False)
                queried_pages = 0
                for task in tasks:
                    task['status'] = 'running'
                    report = task['report']
                    if report == 'inventory_sales_snapshot':
                        listing = await client.inventory_search()
                        page = pagination(await client.inventory_page(),page=1,size=50)
                        sample = inventory_sample(listing)
                        if bool(sample) != bool(page.total):
                            raise BrazilError('coverage_mismatch', '库存列表内容与总数不一致')
                        task.update(reported_total=page.total, count_unit='库存列表记录')
                        if page.total:
                            body = await client.inventory_download()
                            metadata = validate_download(folder,body,report,expected_total=page.total,sample_skus=sample)
                            # Recheck total after downloading the session-filtered export.
                            after = pagination(await client.inventory_page(),page=1,size=50)
                            if after.total != page.total:
                                raise BrazilError('total_changed',f'库存查询总数从 {page.total} 变为 {after.total}')
                            artifacts.append(artifact(folder,report,body,metadata))
                            task.update(completed_batches=1,row_count=metadata['row_count'])
                        else:
                            task['row_count'] = 0
                        task.update(status='completed',completeness='列表总数、仓库及首批 SKU 样本核对通过', exported_document_count=None)
                        continue
                    seen, baseline, read_count = set(), None, 0
                    page_number = 1
                    while True:
                        if queried_pages >= MAX_PAGES:
                            raise BrazilError('budget_exceeded',f'超过 {MAX_PAGES} 个调拨查询页，导出未完成')
                        queried_pages += 1
                        listing = await client.allocation_search(report,page_number)
                        page = pagination(listing,page=page_number,size=20)
                        if baseline is None:
                            baseline = page.total
                        if page.total != baseline:
                            raise BrazilError('total_changed',f'调拨总数从 {baseline} 变为 {page.total}')
                        records = allocation_records(listing)
                        expected_count = page.end-page.start+1 if page.total else 0
                        if len(records) != expected_count:
                            raise BrazilError('incomplete_page',f'第 {page_number} 页标记 {page.start}-{page.end}，实际 {len(records)} 张单据')
                        if seen.intersection(records):
                            raise BrazilError('duplicate_ids',f'第 {page_number} 页重复返回已读取单据 ID')
                        seen.update(records)
                        task.update(reported_total=baseline,read_unique_ids=len(seen),count_unit='调拨单据',remaining_document_count=baseline-read_count)
                        if records:
                            body = await client.allocation_download(list(records))
                            metadata = validate_download(folder,body,report,expected_codes=records.values())
                            artifacts.append(artifact(folder,report,body,metadata,batch=page_number))
                            read_count += len(records)
                            task.update(completed_batches=page_number,exported_document_count=read_count,remaining_document_count=baseline-read_count,
                                        row_count=task.get('row_count',0)+metadata['row_count'])
                        if len(seen) == baseline:
                            if page_number != page.pages:
                                raise BrazilError('pagination_mismatch','已读取数量达到总数，但页面仍声明有后续页')
                            task.update(status='completed',completeness='全部单据 ID 与文件批次编号覆盖核对通过',row_count=task.get('row_count',0))
                            break
                        if page_number >= page.pages:
                            raise BrazilError('incomplete_page',f'分页结束但仅读取 {len(seen)}/{baseline} 张单据')
                        page_number += 1
        return {'success':True,'status':'completed','tasks':tasks,'artifacts':artifacts,'auth_refresh_required':False}
    except Exception as exc:
        message = f'{type(exc).__name__}: {exc}'
        safe = client.diagnostic(message) if client else diagnostic(message,(config.MABANG_ACCOUNT,config.MABANG_PASSWORD))
        code = 'account_busy' if isinstance(exc,InterProcessLockTimeout) else 'login_required' if isinstance(exc,MabangAuthError) else 'budget_exceeded' if isinstance(exc,TimeoutError) else getattr(exc,'code','export_failed')
        error = {'code':code,'message':safe}
        for task in tasks:
            if task['status'] == 'running':
                task.update(status='failed',error=error)
        return {'success':False,'status':'partial_success' if artifacts else 'failed','tasks':tasks,'artifacts':artifacts,'error':error,'auth_refresh_required':False}
    finally:
        await HttpSessionRegistry.close_all()


def run(arguments):
    return asyncio.run(execute(arguments))
