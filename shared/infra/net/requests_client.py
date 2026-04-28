from __future__ import annotations

import threading
from dataclasses import dataclass
from enum import Enum
from typing import Dict, Mapping

import requests
from requests.adapters import HTTPAdapter


class RequestsPurpose(str, Enum):
    DINGTALK = "dingtalk"
    LLM = "llm"
    OCR = "ocr"
    EXTERNAL = "external"
    LOCAL_SERVICE = "local_service"


@dataclass(frozen=True)
class RequestsSessionOptions:
    pool_connections: int
    pool_maxsize: int
    timeout_s: float
    headers: Mapping[str, str] | None = None


class ManagedRequestsSession(requests.Session):
    def __init__(self, *, default_timeout_s: float) -> None:
        super().__init__()
        self._default_timeout_s = float(default_timeout_s)
        self.trust_env = False

    def request(self, method, url, **kwargs):
        kwargs.setdefault("timeout", self._default_timeout_s)
        return super().request(method, url, **kwargs)


_SESSION_OPTIONS: Dict[RequestsPurpose, RequestsSessionOptions] = {
    RequestsPurpose.DINGTALK: RequestsSessionOptions(
        pool_connections=32,
        pool_maxsize=32,
        timeout_s=30,
        headers={"User-Agent": "RobotCoze-DingTalk/1.0"},
    ),
    RequestsPurpose.LLM: RequestsSessionOptions(
        pool_connections=16,
        pool_maxsize=16,
        timeout_s=30,
        headers={"User-Agent": "RobotCoze-LLM/1.0"},
    ),
    RequestsPurpose.OCR: RequestsSessionOptions(
        pool_connections=8,
        pool_maxsize=8,
        timeout_s=30,
        headers={"User-Agent": "RobotCoze-OCR/1.0"},
    ),
    RequestsPurpose.EXTERNAL: RequestsSessionOptions(
        pool_connections=16,
        pool_maxsize=16,
        timeout_s=30,
        headers={"User-Agent": "RobotCoze-External/1.0"},
    ),
    RequestsPurpose.LOCAL_SERVICE: RequestsSessionOptions(
        pool_connections=8,
        pool_maxsize=8,
        timeout_s=120,
        headers={"User-Agent": "RobotCoze-LocalService/1.0"},
    ),
}


def _normalize_purpose(value: RequestsPurpose | str) -> RequestsPurpose:
    if isinstance(value, RequestsPurpose):
        return value
    return RequestsPurpose(str(value or "").strip().lower())


def _build_session(options: RequestsSessionOptions) -> ManagedRequestsSession:
    session = ManagedRequestsSession(default_timeout_s=options.timeout_s)
    adapter = HTTPAdapter(
        pool_connections=options.pool_connections,
        pool_maxsize=options.pool_maxsize,
        max_retries=0,
    )
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update(dict(options.headers or {}))
    return session


class RequestsSessionRegistry:
    _sessions: Dict[RequestsPurpose, ManagedRequestsSession] = {}
    _lock = threading.Lock()

    @classmethod
    def get(cls, purpose: RequestsPurpose | str) -> ManagedRequestsSession:
        normalized = _normalize_purpose(purpose)
        with cls._lock:
            session = cls._sessions.get(normalized)
            if session is None:
                session = _build_session(_SESSION_OPTIONS[normalized])
                cls._sessions[normalized] = session
            return session

    @classmethod
    def close_all(cls) -> None:
        with cls._lock:
            sessions = list(cls._sessions.values())
            cls._sessions.clear()
        for session in sessions:
            try:
                session.close()
            except Exception:
                pass


class RequestsSessionProxy:
    def __init__(self, purpose: RequestsPurpose) -> None:
        self._purpose = purpose

    def __getattr__(self, name: str):
        return getattr(RequestsSessionRegistry.get(self._purpose), name)


def get_requests_session(purpose: RequestsPurpose | str) -> ManagedRequestsSession:
    return RequestsSessionRegistry.get(purpose)


dingtalk_requests_session = RequestsSessionProxy(RequestsPurpose.DINGTALK)
llm_requests_session = RequestsSessionProxy(RequestsPurpose.LLM)
ocr_requests_session = RequestsSessionProxy(RequestsPurpose.OCR)
external_requests_session = RequestsSessionProxy(RequestsPurpose.EXTERNAL)
local_service_requests_session = RequestsSessionProxy(RequestsPurpose.LOCAL_SERVICE)


def close_all_requests_sessions() -> None:
    RequestsSessionRegistry.close_all()


__all__ = [
    "ManagedRequestsSession",
    "RequestsPurpose",
    "RequestsSessionRegistry",
    "close_all_requests_sessions",
    "dingtalk_requests_session",
    "external_requests_session",
    "get_requests_session",
    "llm_requests_session",
    "local_service_requests_session",
    "ocr_requests_session",
]
