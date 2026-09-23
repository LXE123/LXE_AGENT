from __future__ import annotations
import asyncio
import json
import time
from urllib.parse import urlsplit
import aiohttp
from shared.infra.net import erp_http_session, external_http_session
from services.mabang.cookies import build_cookie_header, extract_named_cookies
from services.mabang.auth_constants import MABANG_MEMCACHE_COOKIE_NAME
from services.mabang.export_common import request_headers
from .contracts import inventory_form, allocation_form, _export_form_data
from .errors import BrazilError, diagnostic

AMZ = 'https://private-amz.mabangerp.com'
PRIVATE = 'https://private.mabangerp.com'
MAX_BYTES = 100_000_000


class BrazilClient:
    def __init__(self, context):
        self.context = context
        self.cookie = build_cookie_header(context.cookies_by_domain, request_host='private-amz.mabangerp.com')
        self.private_cookie = build_cookie_header(context.cookies_by_domain, request_host='private.mabangerp.com', extra_cookies={'exportv2': '2'})
        self.memcache = extract_named_cookies(context.cookies_by_domain, (MABANG_MEMCACHE_COOKIE_NAME,)).get(MABANG_MEMCACHE_COOKIE_NAME, '')
        self.secrets = [context.account, context.free_token, context.wms_cookie_header, self.cookie, self.private_cookie, self.memcache]
        self.secrets.extend(str(c.get('value', '')) for items in context.cookies_by_domain.values() for c in items)
        self.last_request = 0.0
        if not self.cookie:
            raise BrazilError('login_required', '已有登录态缺少 private-amz Cookie，需要恢复马帮 ERP 认证')

    def diagnostic(self, value):
        return diagnostic(value, self.secrets)

    async def request(self, base, mod, *, data=None, json_result=True, query=False, external_url=None):
        url = external_url or f'{base}/index.php?mod={mod}'
        headers = {} if external_url else request_headers(self.private_cookie if base == PRIVATE else self.cookie, origin=base, referer=base+'/')
        session = external_http_session if external_url else erp_http_session
        attempts = 3 if query else 1
        for attempt in range(attempts):
            await asyncio.sleep(max(0, 1 - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            try:
                method = session.get if data is None else session.post
                kwargs = {'headers': headers, 'allow_redirects': False, 'timeout': aiohttp.ClientTimeout(total=60)}
                if data is not None:
                    kwargs['data'] = data
                async with method(url, **kwargs) as response:
                    chunks, size = [], 0
                    async for chunk in response.content.iter_chunked(65536):
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise BrazilError('response_too_large', f'{mod}: 响应超过 {MAX_BYTES} 字节')
                        chunks.append(chunk)
                    body = b''.join(chunks)
                    text = body.decode('utf-8', errors='replace')
                    if response.status != 200:
                        code = {401:'login_required',403:'forbidden',429:'rate_limited'}.get(response.status,'http_error')
                        raise BrazilError(code, self.diagnostic(f'{mod}: HTTP {response.status}; {text}'))
                    if not json_result:
                        return body
                    try:
                        payload = json.loads(text)
                    except ValueError as exc:
                        raise BrazilError('non_json', self.diagnostic(f'{mod}: {exc}; {text}')) from exc
                    if not isinstance(payload, dict) or payload.get('success') is not True:
                        raise BrazilError('remote_error', self.diagnostic(f'{mod}: {payload}'))
                    return payload
            except (aiohttp.ClientError, TimeoutError) as exc:
                if attempt + 1 == attempts:
                    code = 'query_failed' if query else 'submission_unknown' if data is not None else 'download_failed'
                    raise BrazilError(code, self.diagnostic(f'{mod}: {type(exc).__name__}: {exc}')) from exc
                await asyncio.sleep(attempt + 1)

    async def inventory_search(self):
        form = inventory_form() + [('rowsPerPage', '50')]
        return await self.request(AMZ, 'warehouse.searchwarehousestock', data=form, query=True)

    async def inventory_page(self):
        return await self.request(AMZ, 'warehouse.getSearchWarehouseStockPage', data={'page':'1','rowsPerPage':'50'}, query=True)

    async def inventory_download(self):
        return await self.request(AMZ, 'warehouse.doexportwarehousestock&flag=1&showRmbColumn=0', json_result=False)

    async def allocation_search(self, kind, page):
        form = [(k, str(page) if k == 'page' else v) for k,v in allocation_form(kind)]
        return await self.request(AMZ, 'warehouseallocation.searchallocation', data=form, query=True)

    async def allocation_download(self, ids):
        if not self.private_cookie or not self.memcache:
            raise BrazilError('login_required', '已有马帮登录态缺少调拨导出所需认证材料')
        form = _export_form_data(memcache_key=self.memcache, order_ids=','.join(ids)+',')
        payload = await self.request(PRIVATE, 'export.doAllocationWarehouseExportFile', data=form)
        url = payload.get('gourl', '')
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname != 'upload.mabangerp.com' or parsed.port not in (None,443) or parsed.username or parsed.password:
            raise BrazilError('invalid_download_url', self.diagnostic(f'导出响应缺少或包含未批准 gourl: {payload}'))
        return await self.request('', '调拨文件下载', external_url=url, json_result=False)
