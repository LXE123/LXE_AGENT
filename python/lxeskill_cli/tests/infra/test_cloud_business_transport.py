"""Actual HTTP checks for migrated adapters; no desktop or live business writes."""
import asyncio
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading

import pytest
from services.agent_cli.mabang import erp_http, erp_packing_upload
from services.mabang import official_api
from shared.infra.cloud_async import AsyncCloudClient


@contextmanager
def server(responses):
    calls=[]
    class Handler(BaseHTTPRequestHandler):
        def handle_request(self):
            raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
            calls.append((self.command,self.path,dict(self.headers),raw))
            result=responses(self.path,len(calls)) if callable(responses) else responses
            status,payload,headers=result
            self.send_response(status)
            for key,value in headers.items(): self.send_header(key,value)
            self.end_headers()
            try:
                self.wfile.write(payload if isinstance(payload,bytes) else json.dumps(payload).encode())
            except (BrokenPipeError,ConnectionResetError): pass
        do_GET=handle_request
        do_POST=handle_request
        def log_message(self,*args): pass
    http=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    worker=threading.Thread(target=lambda:http.serve_forever(poll_interval=0.01),daemon=True)
    worker.start()
    try: yield f'http://127.0.0.1:{http.server_port}',calls
    finally: http.shutdown(); http.server_close(); worker.join()


@pytest.fixture(autouse=True)
def no_credentials(monkeypatch):
    for name in ('LXE_ERP_API_KEY','LXE_DATA_SERVER_API_KEY','LXE_DATA_SERVER_FALLBACK_API_KEY'):
        monkeypatch.delenv(name,raising=False)
    monkeypatch.setenv('HTTP_PROXY','http://127.0.0.1:1')
    monkeypatch.setenv('http_proxy','http://127.0.0.1:1')


def assert_native(calls):
    assert calls
    for method,path,headers,body in calls:
        assert {key.lower(): value for key,value in headers.items()}['x-lxe-client']=='cli'
        assert not {'authorization','cookie','proxy-authorization'} & {key.lower() for key in headers}


def test_erp_confirmation_and_full_large_response(monkeypatch):
    body={'detail':{'code':'purchase_batch_replace_confirmation_required'},'lines':['x'*1500000]}
    with server((409,body,{})) as (url,calls):
        monkeypatch.setenv('LXE_DATA_SERVER_URL',url)
        status,payload=erp_http.request_json('POST','/api/v1/erp/purchase-batches/preview',operation='preview',
            json_payload={'test':'input'},accepted_error_codes=frozenset({'purchase_batch_replace_confirmation_required'}))
    assert status==409 and payload==body
    assert_native(calls); assert len(calls)==1


def test_binary_contract_download_is_complete(monkeypatch):
    content=b'PK'+bytes(range(256))*6000
    with server((200,content,{'Content-Disposition':"attachment; filename*=UTF-8''contract.xlsx",'Set-Cookie':'secret=private'})) as (url,calls):
        monkeypatch.setenv('LXE_DATA_SERVER_URL',url)
        status,actual,headers=erp_http.request_bytes('GET','/api/v1/erp/contracts/fixture/download',operation='download')
    assert status==200 and actual==content
    assert headers['Content-Disposition'].endswith('contract.xlsx')
    assert 'Set-Cookie' not in headers
    assert_native(calls)


def test_packing_confirmation_is_not_a_transport_error(monkeypatch):
    body={'response_schema':'lxe.erp.packing-preview.v1','status':'confirmation_required','quote_id':'fixture'}
    with server((409,body,{})) as (url,calls):
        result=erp_packing_upload._request_json('POST','/api/v1/erp/packing-snapshots/preview',
            base_url=url,timeout=30,json_payload={},accepted_statuses={200,409})
    assert result==body
    assert_native(calls)


@pytest.mark.parametrize('status',[401,403])
def test_actual_denials_preserve_error_and_do_not_retry(monkeypatch,status):
    with server((status,{'detail':{'code':'business_capability_denied','message':'actual denial','token':'hidden'}},{})) as (url,calls):
        monkeypatch.setenv('LXE_DATA_SERVER_URL',url)
        with pytest.raises(erp_http.ErpHttpError,match='actual denial') as caught:
            erp_http.request_json('POST','/api/v1/erp/purchase-batches/import',operation='import',json_payload={})
        assert caught.value.code=='business_capability_denied'
        with pytest.raises(official_api.OfficialApiError,match='actual denial') as caught:
            asyncio.run(official_api.post_json('shops/list',{},context='shop'))
        assert 'hidden' not in str(caught.value)
    assert len(calls)==2
    assert_native(calls)


def test_async_cookie_redirect_and_session_lifecycle():
    async def run(url):
        async with AsyncCloudClient(url) as client:
            session=client._session
            first=await client.request_json('POST','/example',json_body={})
            second=await client.request_json('POST','/example',json_body={})
            assert first.status_code==200 and second.status_code==302
        assert session.closed
    def responses(path,count):
        if count==1: return 200,{'code':200},{'Set-Cookie':'secret=private'}
        return 302,b'moved',{'Location':'http://127.0.0.1:1/must-not-call'}
    with server(responses) as (url,calls): asyncio.run(run(url))
    assert len(calls)==2
    assert_native(calls)


def test_async_cancel_does_not_block_loop_or_leave_session_open():
    started=threading.Event(); release=threading.Event()
    def responses(path,count):
        started.set(); release.wait(3)
        return 200,{'code':200},{}
    async def run(url):
        async with AsyncCloudClient(url) as client:
            session=client._session
            task=asyncio.create_task(client.request_json('POST','/slow',json_body={}))
            for _ in range(100):
                if started.is_set(): break
                await asyncio.sleep(0.01)
            assert started.is_set()
            task.cancel()
            with pytest.raises(asyncio.CancelledError): await task
            release.set()
        assert session.closed
    with server(responses) as (url,calls):
        try: asyncio.run(run(url))
        finally: release.set()
    assert len(calls)==1


def test_async_large_json_and_429_retry_header(monkeypatch):
    sleeps=[]
    async def sleep(delay): sleeps.append(delay)
    monkeypatch.setattr(official_api.asyncio,'sleep',sleep)
    body={'code':200,'data':{'items':['x'*1500000]}}
    with server(lambda path,count: (429,{'detail':'limited'},{'Retry-After':'2'}) if count==1 else (200,body,{})) as (url,calls):
        monkeypatch.setenv('LXE_DATA_SERVER_URL',url)
        assert asyncio.run(official_api.post_json('shops/list',{},context='shop'))==body
    assert sleeps==[2] and len(calls)==2
    assert_native(calls)


def test_business_failure_429_is_not_retried(monkeypatch):
    with server((429,{'code':500,'message':'actual application expired'},{})) as (url,calls):
        monkeypatch.setenv('LXE_DATA_SERVER_URL',url)
        with pytest.raises(official_api.OfficialApiError,match='actual application expired'):
            asyncio.run(official_api.post_json('shops/list',{},context='shop'))
    assert len(calls)==1
