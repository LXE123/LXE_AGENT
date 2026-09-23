"""Protocol extracted from PR #65; tokens are scoped to this client only."""
from __future__ import annotations

import json
import re
import time
from datetime import datetime
from urllib.parse import quote, quote_plus, urlsplit

import requests

BASE_URL = "https://tms.mabangerp.com/tmsapi"
FIELDS = ["stockSku", "sale3", "sale1", "availableinventory", "sale2", "warehouse",
          "stockQuantity", "allotShippingQuantity", "stockCost", "purchasePrice", "lastInTime", "sale5"]
FILTERS = {"isConfirm": 1, "classId": None, "orderBys": "2", "status": 1,
           "gridproperty": -1, "if_produce": "-1", "providerId": "", "stockQuantity": -1}


def diagnostic(value, secrets=()):
    text = json.dumps(value, ensure_ascii=False, default=str) if isinstance(value, (dict, list)) else str(value)
    for secret in sorted(filter(None, secrets), key=len, reverse=True):
        for form in (secret, quote(secret, safe=""), quote_plus(secret), json.dumps(secret, ensure_ascii=False)[1:-1]):
            text = text.replace(form, "[REDACTED]")
    text = re.sub(r'https?://[^\s\"\'<>]+', '[REDACTED_URL]', text)
    text = re.sub(r'''(?i)(["']?(?:[\w-]*token|authorization|cookie|set-cookie|pwd|password|secret|signature|captcha)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)''', r'\1[REDACTED]', text)
    return text if len(text) <= 4000 else text[:4000] + " … [truncated]"


class TmsError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


class TmsClient:
    def __init__(self, account, password, *, session=None, clock=time.monotonic, sleeper=time.sleep):
        self.account, self.password, self.token = account, password, ""
        self.session = session or requests.Session()
        self.clock, self.sleeper = clock, sleeper
        self.deadline = clock() + 900
        self.last_request = None

    def safe(self, value):
        return diagnostic(value, (self.account, self.password, self.token))

    def check_budget(self):
        if self.clock() >= self.deadline:
            raise TmsError("runtime_limit", "马帮 TMS 导出达到 15 分钟上限")

    def pace(self):
        self.check_budget()
        if self.last_request is not None:
            self.sleeper(max(0, 2 - (self.clock() - self.last_request)))
        self.check_budget()
        self.last_request = self.clock()

    def post(self, path, payload):
        attempts = 3 if path == "/findMyStockwarehouseList" else 1
        for attempt in range(attempts):
            self.pace()
            headers = {"Content-Type": "application/json;charset=UTF-8", "lang": "zh_CN"}
            if path == "/login":
                headers["menu-path"] = "#/login"
            else:
                headers["token"] = self.token
            try:
                response = self.session.post(BASE_URL + path, json=payload, headers=headers,
                                             timeout=(5, 30), allow_redirects=False)
            except requests.RequestException as exc:
                if attempt + 1 < attempts and isinstance(exc, (requests.Timeout, requests.ConnectionError)):
                    self.sleeper(2 ** attempt)
                    continue
                raise TmsError("network_error", self.safe(f"{path}: {type(exc).__name__}: {exc}")) from exc
            try:
                if response.status_code in {408, 500, 502, 503, 504} and attempt + 1 < attempts:
                    self.sleeper(2 ** attempt)
                    continue
                if response.status_code != 200:
                    raise TmsError(f"http_{response.status_code}", self.safe(f"{path}: HTTP {response.status_code}: {response.text}"))
                try:
                    body = response.json()
                except ValueError as exc:
                    raise TmsError("invalid_json", self.safe(f"{path}: {exc}; body={response.text}")) from exc
                if not isinstance(body, dict) or body.get("code") != "200":
                    raise TmsError("remote_error", self.safe({"operation": path, "response": body}))
                return body
            finally:
                response.close()
        raise AssertionError("unreachable")

    def login(self):
        body = self.post("/login", {"userName": self.account, "pwd": self.password,
                                    "local_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
        data = body.get("data")
        token = data.get("apiToken") if isinstance(data, dict) else None
        if not isinstance(token, str) or not token.strip():
            raise TmsError("missing_token", self.safe({"reason": "登录响应缺少有效 apiToken", "response": body}))
        self.token = token.strip()

    def list_page(self, page):
        return self.post("/findMyStockwarehouseList", {**FILTERS, "page": page, "pageSize": 1000})

    def export(self, ids):
        body = self.post("/exportStockwarehouse", {"startNum": None, "pageSize": 1000,
            "classId": None, "gridproperty": -1, "idsList": ids, "isCombo": 1,
            "ischecked": False, "orderBys": "2", "status": 1, "stockValueArr": FIELDS})
        pop = body.get("pop") or (body.get("data") or {}).get("pop")
        if isinstance(pop, dict):
            pop = next((pop[k] for k in ("url", "fileUrl", "downloadUrl", "path") if isinstance(pop.get(k), str)), None)
        if not isinstance(pop, str) or not pop.strip():
            raise TmsError("missing_download_url", self.safe({"reason": "导出响应缺少下载地址", "response": body}))
        return pop

    def download(self, url):
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or parsed.hostname != "tms-cos.mabangerp.com"
                or parsed.username or parsed.password or parsed.port not in (None, 443)):
            raise TmsError("invalid_download_url", "平台返回的下载地址不属于允许的 HTTPS 文件域名")
        self.pace()
        # A separate request prevents platform cookies/token from reaching the download host.
        try:
            with requests.get(url, timeout=(5, 30), stream=True, allow_redirects=False) as response:
                if response.status_code != 200:
                    raise TmsError(f"download_http_{response.status_code}", self.safe(f"HTTP {response.status_code}: {response.text}"))
                chunks, size = [], 0
                for chunk in response.iter_content(65536):
                    self.check_budget()
                    size += len(chunk)
                    if size > 50_000_000:
                        raise TmsError("download_size_limit", "下载文件超过 50 MB")
                    chunks.append(chunk)
                return b"".join(chunks)
        except requests.RequestException as exc:
            raise TmsError("download_network_error", self.safe(f"{type(exc).__name__}: {exc}")) from exc

    def close(self):
        self.token = ""
        self.session.close()
