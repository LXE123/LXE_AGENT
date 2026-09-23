"""PR #65's Yacang HTTP protocol, without ambient auth or automatic submits."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlsplit
import requests
from .contracts import REPORTS, export_parameters
from .errors import YacangError, safe_remote_detail

API_ORIGIN = "https://api-oms.seaya.cn"
WEB_ORIGIN = "http://m.seaya.cn"
DOWNLOAD_HOST = "oss-accelerate.seaya.cn"
MAX_XLSX_BYTES = 50 * 1024 * 1024


def trusted_download(url):
    try:
        p = urlsplit(url)
        return (p.scheme == "https" and p.hostname == DOWNLOAD_HOST and p.port in (None, 443)
                and not p.username and not p.password and not p.fragment and p.path.lower().endswith(".xlsx")
                and not any(ord(c) < 33 for c in url))
    except (TypeError, ValueError):
        return False


class YacangClient:
    def __init__(self, credentials, state):
        self.credentials, self.state = credentials, state
        self.session = requests.Session()
        self.session.trust_env = False
        self.token = ""
        self.secrets = [credentials.mobile, credentials.password]

    def close(self):
        self.session.close()
        self.token = ""
        self.secrets.clear()

    def diagnostic(self, value):
        return safe_remote_detail(value, secrets=tuple(self.secrets))

    @staticmethod
    def _body(response):
        body = bytearray()
        for chunk in response.iter_content(65536):
            body.extend(chunk)
            if len(body) > 2 * 1024 * 1024:
                return body.decode(errors="replace") + " [response exceeds 2 MiB; truncated]"
        return body.decode("utf-8", errors="replace")

    def _http_error(self, status, detail, purpose):
        code = {401: "login_required", 403: "forbidden", 429: "rate_limited"}.get(status)
        if status == 429:
            self.state.cooldown()
        if code or status != 200:
            raise YacangError(purpose, self.diagnostic(detail), code=code or ("submit_unknown" if purpose == "submit" and status >= 500 else "http_error"),
                              scope="global" if code or purpose in {"auth", "submit", "queue"} else "local")

    def request(self, method, path, *, purpose, params=None, body=None):
        for attempt in range(2 if purpose == "queue" else 1):
            try:
                self.session.cookies.clear()
                headers = {"Accept": "application/json", "Origin": WEB_ORIGIN, "Referer": WEB_ORIGIN + "/"}
                if self.token:
                    headers["token"] = self.token
                with self.state.request_slot(), self.session.request(method, API_ORIGIN + path, params=params, json=body,
                        headers=headers, timeout=(10, 60), allow_redirects=False, stream=True) as response:
                    raw = self._body(response)
                    status = response.status_code
            except requests.RequestException as exc:
                if purpose == "queue" and attempt == 0:
                    time.sleep(3)
                    continue
                raise YacangError(purpose, self.diagnostic(f"{type(exc).__name__}: {exc}"), code="submit_unknown" if purpose == "submit" else "network_error", scope="global") from None
            if purpose == "queue" and status >= 500 and attempt == 0:
                time.sleep(3)
                continue
            detail = f"{path}: HTTP {status}: {raw or '[empty response]'}"
            try:
                payload = json.loads(raw)
            except ValueError as exc:
                self._http_error(status, detail, purpose)
                raise YacangError(purpose, self.diagnostic(f"{detail}; {exc}"), code="submit_unknown" if purpose == "submit" else "invalid_response", scope="global") from None
            if path == "/sys/customer/verify" and isinstance(payload, dict) and isinstance(payload.get("data"), dict):
                self.secrets.extend(str(payload["data"][k]) for k in ("key", "code") if payload["data"].get(k) is not None)
            self._http_error(status, detail, purpose)
            if not isinstance(payload, dict) or "status" not in payload:
                raise YacangError(purpose, self.diagnostic(detail), code="submit_unknown" if purpose == "submit" else "invalid_response", scope="global")
            if payload.get("status") not in (0, 1):
                if payload.get("status") in (401, 403, 429):
                    self._http_error(payload["status"], detail, purpose)
                raise YacangError(purpose, self.diagnostic(detail), code="submit_unknown" if purpose == "submit" else "invalid_response", scope="global")
            if payload.get("status") != 1:
                message = self.diagnostic(detail)
                needs_date = purpose == "submit" and any(v in raw for v in ("create_time", "创建日期", "创建时间")) and any(v in raw for v in ("必填", "不能为空", "required"))
                raise YacangError(purpose, message, code="date_range_required" if needs_date else "remote_error", scope="global" if purpose != "download" else "local")
            return payload

    def login(self):
        payload = self.request("GET", "/sys/customer/verify", purpose="auth")
        data = payload.get("data")
        if isinstance(data, dict):
            # Register even a partial response before emitting diagnostics.
            self.secrets.extend(str(data[k]) for k in ("key", "code") if data.get(k) is not None)
        if not isinstance(data, dict) or not str(data.get("key") or "").strip() or not str(data.get("code") or "").strip():
            raise YacangError("验证码", self.diagnostic(f"缺少 data.key/code: {payload}"), code="invalid_captcha", scope="global")
        payload = self.request("POST", "/sys/customer/loginV3", purpose="auth", body={
            "mobile": self.credentials.mobile, "password": self.credentials.password,
            "verify_code": str(data["code"]), "key": str(data["key"]), "lang": "zh-cn"})
        token = payload.get("data", {}).get("token") if isinstance(payload.get("data"), dict) else None
        if not isinstance(token, str) or not token.strip():
            raise YacangError("登录", self.diagnostic(f"缺少 data.token: {payload}"), code="invalid_login", scope="global")
        self.token = token
        self.secrets.append(token)

    def list_downloads(self):
        rows = []
        for page in range(1, 21):
            payload = self.request("GET", "/sys/customer/downPath/list", purpose="queue", params={"page": page, "limit": 50})
            batch = payload.get("data", {}).get("list") if isinstance(payload.get("data"), dict) else None
            if not isinstance(batch, list) or any(not isinstance(r, dict) or not r.get("id") for r in batch):
                raise YacangError("导出队列", self.diagnostic(f"缺少有效 data.list/id: {payload}"), code="queue_unknown", scope="global")
            if set(str(r['id']) for r in batch) & set(str(r['id']) for r in rows):
                raise YacangError("导出队列", "分页返回重复任务 ID", code="queue_unknown", scope="global")
            rows.extend(batch)
            if len(batch) < 50:
                return rows
        raise YacangError("导出队列", "超过 20 页，无法完整核对任务", code="queue_unknown", scope="global")

    def submit(self, task):
        self.request("GET", REPORTS[task["report"]][1], purpose="submit", params=export_parameters(task))

    def download(self, url, destination: Path):
        if not trusted_download(url):
            raise YacangError("下载", self.diagnostic(f"不支持的下载地址: {url}"), code="invalid_download_url")
        self.secrets.append(url)
        self.session.cookies.clear()
        try:
            with self.state.request_slot(), self.session.get(url, headers={"Origin": WEB_ORIGIN, "Referer": WEB_ORIGIN + "/"},
                    timeout=(10, 120), allow_redirects=False, stream=True) as response:
                if response.status_code != 200:
                    self._http_error(response.status_code, f"HTTP {response.status_code}: {self._body(response)}", "download")
                size, digest = 0, hashlib.md5(usedforsecurity=False)
                with destination.open("xb") as output:
                    for chunk in response.iter_content(65536):
                        size += len(chunk)
                        if size > MAX_XLSX_BYTES:
                            raise YacangError("下载", "文件超过 50 MiB", code="file_too_large")
                        digest.update(chunk)
                        output.write(chunk)
                expected = response.headers.get("Content-MD5")
                if expected and expected != base64.b64encode(digest.digest()).decode():
                    raise YacangError("下载", "Content-MD5 校验失败", code="checksum_mismatch")
        except requests.RequestException as exc:
            destination.unlink(missing_ok=True)
            raise YacangError("下载", self.diagnostic(f"{type(exc).__name__}: {exc}"), code="network_error") from None
        except Exception:
            destination.unlink(missing_ok=True)
            raise
