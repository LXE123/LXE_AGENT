from __future__ import annotations

import os
from typing import Protocol

from services.yacang.errors import YacangError


class LoginClient(Protocol):
    def login(self, mobile: str, password: str) -> None: ...


def login_from_environment(
    client: LoginClient,
    *,
    mobile: str | None = None,
    password: str | None = None,
) -> None:
    if bool(getattr(client, "is_authenticated", False)):
        return
    account = str(mobile if mobile is not None else os.environ.get("LXE_YACANG_MOBILE", "")).strip()
    secret = str(password if password is not None else os.environ.get("LXE_YACANG_PASSWORD", "")).strip()
    if not account or not secret:
        raise YacangError(
            "读取配置",
            "桌面设置中缺少雅仓账号或密码",
            code="YACANG_CREDENTIALS_MISSING",
            scope="global",
        )
    client.login(account, secret)


__all__ = ["login_from_environment"]
