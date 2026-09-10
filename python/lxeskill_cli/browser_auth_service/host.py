"""Adapter for the limited browser surface used by the Python authentication flow.

The host owns only ephemeral pages. It cannot refresh or persist authentication,
and never receives arbitrary JavaScript or a general CDP command from the CLI.
"""
from __future__ import annotations

import json
import time
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError


class HostBrowserError(PlaywrightError):
    def __init__(self, payload: dict):
        self.remote_exception_type = str(payload.get("exception_type") or "Error")
        super().__init__(str(payload.get("message") or self.remote_exception_type))


class HostContext:
    def __init__(self, connection: tuple[str, str], *, headless: bool):
        self.url, self.token = connection
        self.opener = build_opener(ProxyHandler({}))
        self.session_id = ""
        self.current_url = ""
        self.closed = False
        self.session_id = self.call("open", headless=headless)["session_id"]

    def call(self, operation: str, **arguments):
        request = Request(
            self.url + "/v1/auth-browser",
            data=json.dumps({"operation": operation, "session_id": self.session_id, "arguments": arguments}).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            response = self.opener.open(request, timeout=min(45, max(5, arguments.get("timeout", 30000) / 1000 + 5)))
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise RuntimeError("认证浏览器宿主响应超过 4 MiB")
            payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise RuntimeError("认证浏览器宿主响应必须为 JSON object")
        self.current_url = str(payload.get("current_url") or self.current_url)
        if not payload.get("ok"):
            error = payload.get("error") or {}
            if error.get("exception_type") == "TimeoutError":
                raise PlaywrightTimeoutError(str(error.get("message")))
            raise HostBrowserError(error)
        return payload.get("result")

    def new_page(self):
        return HostPage(self)

    def cookies(self, urls=None):
        return self.call("cookies", urls=urls)

    def storage_state(self):
        return self.call("storage_state")

    def close(self):
        if not self.closed:
            try:
                self.call("close")
            finally:
                self.closed = True


class HostLocator:
    def __init__(self, context, selector):
        self.context, self.selector = context, selector

    @property
    def first(self):
        return self

    def _action(self, action, **arguments):
        return self.context.call("element", selector=self.selector, action=action, **arguments)

    def count(self):
        return self._action("count")

    def fill(self, value):
        return self._action("fill", value=value, timeout=30000)

    def click(self, *, timeout):
        return self._action("click", timeout=timeout)

    def wait_for(self, *, state, timeout):
        if state != "attached":
            raise ValueError("认证浏览器只支持 attached 等待")
        return self._action("wait", timeout=timeout)

    def get_attribute(self, name):
        if name != "href":
            raise ValueError("认证浏览器只读取链接 href")
        return self._action("href")


class HostFrame:
    def __init__(self, context, payload):
        self.context = context
        self.frame_id = payload["id"]
        self.url = payload["url"]

    def evaluate(self, expression, key):
        if expression != "(key) => window.localStorage.getItem(key)":
            raise ValueError("认证浏览器只支持读取 localStorage")
        return self.context.call("read_storage", frame_id=self.frame_id, key=key)


class HostResponse:
    def __init__(self, payload):
        self.url = payload["url"]
        self.status = payload["status"]
        self.request = SimpleNamespace(method=payload["method"])
        self.payload = payload

    def text(self):
        if self.payload.get("body_error"):
            raise HostBrowserError(self.payload["body_error"])
        return self.payload["body"]


class HostResponseCapture:
    def __init__(self, context, predicate, timeout):
        self.context, self.predicate, self.timeout = context, predicate, timeout

    def __enter__(self):
        self.context.call("arm_login_response", timeout=self.timeout)
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            self.value = HostResponse(self.context.call("login_response", timeout=self.timeout))
            if not self.predicate(self.value):
                raise RuntimeError("认证浏览器捕获的登录响应与请求不匹配")


class HostPage:
    def __init__(self, context):
        self.context = context

    @property
    def url(self):
        if not self.context.closed:
            self.context.call("url")
        return self.context.current_url

    def goto(self, url, *, wait_until):
        if wait_until != "domcontentloaded":
            raise ValueError("认证浏览器导航必须等待 DOM 就绪")
        self.context.call("navigate", url=url, timeout=30000)

    def locator(self, selector):
        return HostLocator(self.context, {"css": selector})

    def get_by_role(self, role, *, name):
        return HostLocator(self.context, {"role": role, "name": name})

    def expect_response(self, predicate, *, timeout):
        return HostResponseCapture(self.context, predicate, timeout)

    @property
    def main_frame(self):
        return None  # frames already contains the main frame, once.

    @property
    def frames(self):
        return [HostFrame(self.context, item) for item in self.context.call("frames")]

    def wait_for_timeout(self, timeout_ms):
        time.sleep(timeout_ms / 1000)
