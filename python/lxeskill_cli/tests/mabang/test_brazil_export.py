import asyncio
import io
import json
from pathlib import Path
from unittest.mock import AsyncMock
import pytest
from openpyxl import Workbook
from services.mabang.auth import MabangAuthContext
from services.mabang.brazil_overseas import workflow, parsing, workbooks, client
from services.mabang.brazil_overseas.contracts import ALLOCATION_EXPORT_FIELDS
from services.mabang.brazil_overseas.errors import BrazilError, diagnostic

FIXTURES = Path(__file__).parent/'fixtures/brazil'
INVENTORY='inventory_sales_snapshot'
PENDING='allocation_pending_default_3m'
SIGNED='allocation_signed_before_3m'


def paged(total,page=1,size=20):
    start = (page-1)*size+1 if total else 0
    end = min(page*size,total)
    pages = max(1,(total+size-1)//size)
    return f'每页 {size} 条 共 {total} 条 当前显示第 {start}-{end} 条 {page}/{pages} 页'


def listing(total=2,page=1):
    ids=range((page-1)*20+1,min(page*20,total)+1)
    return {'success':True,'pageHtml':paged(total,page),'message':''.join(f'<input name="allot[]" value="{i}" data-code="TEST-{i}">' for i in ids)}


def xlsx(rows,headers=None):
    stream=io.BytesIO();wb=Workbook();ws=wb.active
    headers=headers or sorted(workbooks.INVENTORY_HEADERS)
    ws.append(headers)
    for row in rows:ws.append([row.get(h,'') for h in headers])
    wb.save(stream);wb.close();return stream.getvalue()


def test_captured_pagination_and_id_code_mapping():
    for name,total in [('pending',7),('signed',15)]:
        payload=json.loads((FIXTURES/(name+'.json')).read_text())
        assert parsing.pagination(payload,page=1,size=20).total==total
        records=parsing.allocation_records(payload)
        assert len(records)==total and records['100001']=='TEST-BATCH-001'
    payload=json.loads((FIXTURES/'inventory-pages.json').read_text())
    assert parsing.pagination(payload,page=1,size=50).total==2334


@pytest.mark.parametrize('payload',[{}, {'pageHtml':False}, {'pageHtml':'没有数据'}, {'pageHtml':paged(30,2)}])
def test_unknown_or_wrong_page_fails(payload):
    with pytest.raises(BrazilError):parsing.pagination(payload,page=1,size=20)


def test_same_page_duplicate_link_is_one_record():
    d=listing();d['message']*=2
    assert len(parsing.allocation_records(d))==2


@pytest.mark.parametrize('params',[{}, {'reports':[]}, {'reports':['no']}, {'reports':[{}]}, {'reports':[INVENTORY],'warehouse':'other'}])
def test_invalid_params(params):
    with pytest.raises(BrazilError):workflow.normalize({'params':params})


def test_reports_deduplicate_without_changing_order():
    assert workflow.normalize({'params':{'reports':[PENDING,INVENTORY,PENDING]}})==[PENDING,INVENTORY]


def setup_client(monkeypatch,tmp_path):
    fake=type('Fake',(),{})()
    fake.diagnostic=diagnostic
    fake.allocation_search=AsyncMock(side_effect=lambda kind,page: listing(23,page))
    fake.allocation_download=AsyncMock(return_value=b'original-xls')
    fake.inventory_search=AsyncMock(return_value={'message':'<ul><a class="shopStock" data-id="1">SKU</a><li class="warehouseIds" data-id="1072376">巴西海外仓</li></ul>'})
    fake.inventory_page=AsyncMock(return_value={'pageHtml':paged(1,1,50)})
    fake.inventory_download=AsyncMock(return_value=b'original-xlsx')
    monkeypatch.setattr(workflow,'get_existing_auth_context',AsyncMock(return_value=MabangAuthContext('test','test',{},'', '')))
    monkeypatch.setattr(workflow,'BrazilClient',lambda context:fake)
    monkeypatch.setattr(workflow,'dataset_dir',lambda *args:tmp_path/'artifacts')
    monkeypatch.setenv('LXE_DATA_ROOT',str(tmp_path/'state'))
    monkeypatch.setattr(workflow,'validate',lambda body,report,**kw:dict(row_count=5,headers=['header'],sheet_names=['Sheet1'],extension='xlsx' if report==INVENTORY else 'xls'))
    return fake


def test_multi_page_raw_delivery(monkeypatch,tmp_path):
    fake=setup_client(monkeypatch,tmp_path)
    result=workflow.run({'params':{'reports':[PENDING]}})
    assert result['success'] and len(result['artifacts'])==2
    assert result['tasks'][0]['exported_document_count']==23
    assert result['tasks'][0]['row_count']==10 # not document count
    assert [len(c.args[0]) for c in fake.allocation_download.call_args_list]==[20,3]
    assert all(Path(a['path']).read_bytes()==b'original-xls' for a in result['artifacts'])


@pytest.mark.parametrize('failure',['duplicate','early_empty','total_changed','wrong_page','download','validation','budget'])
def test_later_failure_retains_only_validated_files(monkeypatch,tmp_path,failure):
    fake=setup_client(monkeypatch,tmp_path)
    page2=listing(23,2)
    if failure=='duplicate':page2['message']=listing(3)['message']
    if failure=='early_empty':page2['message']=''
    if failure=='total_changed':page2['pageHtml']=paged(24,2)
    if failure=='wrong_page':page2=listing(23,1)
    fake.allocation_search.side_effect=[listing(23),page2]
    if failure=='download':fake.allocation_download.side_effect=[b'original-xls',BrazilError('download_failed','actual failure')]
    if failure=='validation':
        monkeypatch.setattr(workflow,'validate',__import__('unittest.mock',fromlist=['Mock']).Mock(side_effect=[dict(row_count=5,headers=['header'],sheet_names=['Sheet1'],extension='xls'),BrazilError('coverage_mismatch','actual mismatch')]))
    if failure=='budget':monkeypatch.setattr(workflow,'MAX_PAGES',1)
    result=workflow.run({'params':{'reports':[PENDING,SIGNED]}})
    assert result['success'] is False and result['status']=='partial_success'
    assert len(result['artifacts'])==1 and result['tasks'][1]['status']=='not_run'
    assert result['tasks'][0]['remaining_document_count']==3


def test_zero_records_no_fake_file(monkeypatch,tmp_path):
    fake=setup_client(monkeypatch,tmp_path);fake.allocation_search.side_effect=None
    fake.allocation_search.return_value=listing(0)
    result=workflow.run({'params':{'reports':[PENDING]}})
    assert result['success'] and result['artifacts']==[]
    fake.allocation_download.assert_not_called()


def test_inventory_total_change_not_published(monkeypatch,tmp_path):
    fake=setup_client(monkeypatch,tmp_path)
    fake.inventory_page.side_effect=[{'pageHtml':paged(1,1,50)},{'pageHtml':paged(2,1,50)}]
    result=workflow.run({'params':{'reports':[INVENTORY]}})
    assert result['error']['code']=='total_changed' and not result['artifacts']


def test_real_xlsx_parser_warehouse_total_sample_and_bytes(tmp_path):
    row={'库存SKU编号':'SKU','仓库':'巴西海外仓','仓位库存':-1,'可用库存量':0,'销量(7)':'1/2'}
    body=xlsx([row]);meta=workbooks.validate(body,INVENTORY,expected_total=1,sample_skus={'SKU'})
    assert meta['row_count']==1
    path=tmp_path/'original.xlsx';workbooks.publish(path,body);assert path.read_bytes()==body
    for kwargs in [dict(expected_total=2),dict(expected_total=1,sample_skus={'other'})]:
        with pytest.raises(BrazilError):workbooks.validate(body,INVENTORY,**kwargs)
    row['仓库']='other'
    with pytest.raises(BrazilError,match='非巴西'):workbooks.validate(xlsx([row]),INVENTORY,expected_total=1)


def test_missing_headers_and_invalid_file():
    with pytest.raises(BrazilError):workbooks.validate(xlsx([],['库存SKU编号']),INVENTORY,expected_total=0)
    with pytest.raises(BrazilError):workbooks.validate(b'<html>actual login error</html>',INVENTORY,expected_total=1)


def test_redact_before_truncate():
    text=diagnostic('x'*1990+' secret-value https://upload.mabangerp.com/a?sign=secret-value password=hidden',('secret-value',))
    assert 'secret-value' not in text and 'hidden' not in text and 'truncated' in text


def test_atomic_publish_failure_leaves_no_file(monkeypatch,tmp_path):
    monkeypatch.setattr(workbooks.os,'replace',lambda *args: (_ for _ in ()).throw(OSError('disk failed')))
    with pytest.raises(OSError):workbooks.publish(tmp_path/'a.xls',b'bytes')
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('bad_mini_tail',[False,True])
def test_real_biff_parser_preserves_merged_group_semantics(bad_mini_tail):
    from brazil_xls_fixture import synthetic_xls
    headers=[name for name,_ in ALLOCATION_EXPORT_FIELDS]
    a=dict.fromkeys(headers,0);a.update({'批次编号':'TEST-1','目标仓库':'巴西海外仓','库存SKU':'SKU-A'})
    b=dict(a);b.update({'批次编号':None,'目标仓库':None,'库存SKU':'SKU-A','调拨数量':-3})
    body=synthetic_xls(headers,[[r[h] for h in headers] for r in [a,b]],merges=[(1,3,0,1),(1,3,14,15)],bad_mini_tail=bad_mini_tail)
    meta=workbooks.validate(body,PENDING,expected_codes={'TEST-1'})
    assert meta['row_count']==2 and bool(meta['validation_notices'])==bad_mini_tail
    with pytest.raises(BrazilError):workbooks.validate(body,PENDING,expected_codes={'TEST-1','missing'})


def test_cyclic_ole_stays_invalid():
    from brazil_xls_fixture import synthetic_xls
    body=synthetic_xls(['header'],[['text']],bad_mini_tail=True,cycle=True)
    with pytest.raises(Exception):workbooks.read_workbook(body,'xls')


class Response:
    def __init__(self,status,body):self.status=status;self.body=body;self.content=self
    async def __aenter__(self):return self
    async def __aexit__(self,*args):return False
    async def iter_chunked(self,size):yield self.body


def http_client(monkeypatch,responses):
    from unittest.mock import Mock
    def send(*args,**kwargs):
        response=responses.pop(0)
        if isinstance(response,Exception):raise response
        return response
    session=Mock();session.post.side_effect=send;session.get.side_effect=send
    monkeypatch.setattr(client,'erp_http_session',session);monkeypatch.setattr(client,'external_http_session',session)
    monkeypatch.setattr(client.asyncio,'sleep',AsyncMock())
    context=MabangAuthContext('test','test',{'.mabangerp.com':[{'name':'PHPSESSID','value':'secret-value','domain':'.mabangerp.com'}]},'token-secret','')
    return client.BrazilClient(context),session


@pytest.mark.parametrize('status,code',[(401,'login_required'),(403,'forbidden'),(429,'rate_limited'),(302,'http_error'),(500,'http_error')])
def test_http_error_actual_diagnostic_and_no_retry(monkeypatch,status,code):
    c,session=http_client(monkeypatch,[Response(status,b'actual denied token=secret-value')])
    with pytest.raises(BrazilError) as e:asyncio.run(c.allocation_search(PENDING,1))
    assert e.value.code==code and 'actual denied' in str(e.value) and 'secret-value' not in str(e.value)
    assert session.post.call_count==1


def test_only_queries_retry_network_timeout(monkeypatch):
    c,session=http_client(monkeypatch,[TimeoutError('actual timeout')]*3)
    with pytest.raises(BrazilError,match='actual timeout'):asyncio.run(c.allocation_search(PENDING,1))
    assert session.post.call_count==3
    c,session=http_client(monkeypatch,[TimeoutError('submit timeout')]);c.memcache='present'
    with pytest.raises(BrazilError) as e:asyncio.run(c.allocation_download(['1']))
    assert e.value.code=='submission_unknown' and session.post.call_count==1


def test_non_json_is_diagnostic(monkeypatch):
    c,_=http_client(monkeypatch,[Response(200,b'<html>actual maintenance</html>')])
    with pytest.raises(BrazilError,match='actual maintenance'):asyncio.run(c.inventory_search())


def test_download_does_not_forward_auth_and_is_not_retried(monkeypatch):
    c,s=http_client(monkeypatch,[Response(200,b'{"success":true,"gourl":"https://upload.mabangerp.com/file?sign=secret-value"}'),TimeoutError('download timeout')]);c.memcache='present'
    with pytest.raises(BrazilError) as e:asyncio.run(c.allocation_download(['1']))
    assert e.value.code=='download_failed' and s.get.call_count==1
    assert s.get.call_args.kwargs['headers']=={} and s.get.call_args.kwargs['allow_redirects'] is False


def test_unapproved_url_not_fetched(monkeypatch):
    c,s=http_client(monkeypatch,[Response(200,b'{"success":true,"gourl":"https://example.com/?sign=secret-value"}')]);c.memcache='present'
    with pytest.raises(BrazilError):asyncio.run(c.allocation_download(['1']))
    s.get.assert_not_called()


def test_existing_auth_never_ensures_or_refreshes(monkeypatch):
    from services.mabang import auth
    monkeypatch.setattr(auth,'_read_auth_context',AsyncMock(side_effect=RuntimeError('missing current state')))
    ensure=AsyncMock();monkeypatch.setattr(auth,'_ensure_mabang_auth',ensure)
    with pytest.raises(auth.MabangAuthError,match='missing current state'):
        asyncio.run(auth.get_existing_auth_context(account='test'))
    ensure.assert_not_called()


def test_lock_is_shared_with_amazon_and_separates_accounts(monkeypatch,tmp_path):
    import subprocess,sys
    from services.mabang.export_lock import warehouse_export_lock
    from services.mabang.amazon.fba import store_msku_actual_inventory as amazon
    assert amazon.warehouse_export_lock is warehouse_export_lock
    monkeypatch.setenv('LXE_DATA_ROOT',str(tmp_path))
    with warehouse_export_lock('account-a'):
        with warehouse_export_lock('account-b'):pass
        code="from services.mabang.export_lock import warehouse_export_lock\nwith warehouse_export_lock('account-a'):pass"
        p=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True)
        assert p.returncode!=0 and 'InterProcessLockTimeout' in p.stderr


def test_task_deadline_stops_and_reports(monkeypatch,tmp_path):
    fake=setup_client(monkeypatch,tmp_path)
    async def stalled(*args):await asyncio.sleep(1)
    fake.allocation_search.side_effect=stalled
    monkeypatch.setattr(workflow,'TIME_BUDGET',0.01)
    r=workflow.run({'params':{'reports':[PENDING]}})
    assert r['error']['code']=='budget_exceeded' and not r['artifacts']


def test_cli_partial_result_preserves_successful_attachments(monkeypatch,tmp_path,capsys):
    from lxeskill import cli
    from services.agent_cli.mabang import brazil_overseas_export as adapter
    from shared.workspace import activate_external_workspace,activate_project_workspace,artifact_root
    try:
        monkeypatch.setenv('LXE_DATA_ROOT',str(tmp_path/'var'))
        activate_project_workspace()
        path=artifact_root()/'brazil.xls';path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'validated-in-other-tests')
        monkeypatch.delenv('LXESKILL_SKILL_SCOPE',raising=False)
        monkeypatch.setattr(adapter,'run',lambda arguments:{'success':False,'status':'partial_success','artifacts':[{'path':str(path)}],'error':{'code':'coverage_mismatch','message':'actual missing 2 batches'}})
        result=cli.main(['mabang','brazil-overseas','export','run','--params',json.dumps({'reports':[PENDING]})])
        terminal=json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result!=0 and terminal['ok'] is False
        assert terminal['files']==[str(path.resolve())], terminal
        assert 'actual missing 2 batches' in terminal['error']['message']
    finally:
        monkeypatch.undo()
        activate_project_workspace()


def test_page_budget_is_shared_across_report_types(monkeypatch,tmp_path):
    fake=setup_client(monkeypatch,tmp_path)
    fake.allocation_search.side_effect=lambda kind,page:listing(1)
    monkeypatch.setattr(workflow,'MAX_PAGES',1)
    result=workflow.run({'params':{'reports':[PENDING,SIGNED]}})
    assert result['status']=='partial_success' and result['error']['code']=='budget_exceeded'
    assert fake.allocation_search.call_count==1
