"""Reuse ordinary host transport or the bound browser for temporary responses."""
from contextlib import contextmanager

from browser_auth_service.binding import launch_chromium, page_host_connection
from browser_auth_service.host import HostContext


class PageContext(HostContext):
    def __init__(self, connection, session_id):
        self._connect(connection)
        self.session_id = self.call("open", chat_session_id=session_id)["session_id"]

    def call(self, operation, **arguments):
        return self._request("/v1/browser", operation, arguments,
                             timeout_ms=arguments.get("timeout", 30000))


class PageResponses:
    def __init__(self, page):
        self.page = page

    def call(self, operation, *, url, response_url, method="POST", timeout=30000):
        if operation != "navigate_capture":
            raise ValueError(f"Unsupported temporary operation: {operation}")
        with self.page.expect_response(
            lambda response: response.url.split("?")[0] == response_url.split("?")[0]
            and response.request.method == method, timeout=timeout,
        ) as capture:
            self.page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        response = capture.value
        return dict(url=response.url, method=response.request.method, status=response.status, body=response.text())


@contextmanager
def temporary_browser(session_id):
    connection = page_host_connection()
    if connection:
        context = PageContext(connection, session_id)
        try:
            yield context, "electron_host"
        finally:
            context.close()
    else:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            browser = launch_chromium(playwright, headless=False)
            try:
                context = browser.new_context()
                try:
                    yield PageResponses(context.new_page()), "bound_chromium"
                finally:
                    context.close()
            finally:
                browser.close()
