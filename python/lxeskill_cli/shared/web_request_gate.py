"""Discardable CLI request bookkeeping, shared across sessions/processes.

Stores hashes/timestamps only, never remote business state or credentials.
"""
from __future__ import annotations

from hashlib import sha256
from email.utils import parsedate_to_datetime
import json
import math
import os
from pathlib import Path
import time
from typing import Any, Callable

from shared.process_lock import InterProcessLockTimeout, interprocess_lock
from shared.repository import state_root

COMMAND_GAP = 0.5
DUPLICATE_SECONDS = 60.0
COOLDOWN_SECONDS = 900.0
PROTECTED = {
    'services.commands.logistics.forwarders.jiufang_query',
    'services.commands.logistics.login',
}


def _path() -> Path:
    return state_root() / 'tmp' / 'lxeskill' / 'fba-web-requests.json'


def _save(path: Path, state: dict) -> None:
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state), encoding='utf-8')
    os.replace(temporary, path)


def _blocked(code: str, seconds: float, **details: Any) -> dict:
    error = {'code': code, 'message': f'Local request protection: {code}; no remote request sent',
             'retry_after_seconds': max(1, math.ceil(seconds)), **details}
    return {'success': False, 'finished': False, 'request_sent': False, 'auth_refresh_required': False,
            'error': error, 'exception': error['message'], 'notice': '', 'file_path': [],
            'data': {'request_sent': False, 'problems': [error]}}


def _risk(value: Any) -> int | str | None:
    if isinstance(value, dict):
        if value.get('http_status') in (403, 429):
            return value['http_status']
        if value.get('code') in ('captcha_required', 'verification_required'):
            return value['code']
        for item in value.values():
            found = _risk(item)
            if found is not None:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _risk(item)
            if found is not None:
                return found
    return None


def _retry_after(value: Any, now: float) -> float:
    """Honor actual server delta/date headers, never shorten the local floor."""
    delays = [COOLDOWN_SECONDS]
    if isinstance(value, dict):
        raw = value.get('retry_after')
        if isinstance(raw, str):
            try:
                delays.append(float(raw) if raw.isdigit() else parsedate_to_datetime(raw).timestamp() - now)
            except (ValueError, TypeError, OverflowError):
                pass
        delays.extend(_retry_after(item, now) for item in value.values() if isinstance(item, (dict, list)))
    elif isinstance(value, list):
        delays.extend(_retry_after(item, now) for item in value)
    return max(delays)


def invoke(module: str, arguments: dict, run: Callable[[], dict]) -> dict:
    if module not in PROTECTED or arguments.get('plan_only') is True:
        return run()
    return run_request(module, arguments, run)


def run_request(key: str, arguments: dict, run: Callable[[], dict], *, deduplicate: bool = True) -> dict:
    """Use the same pacing, duplicate history and cooldown for installed scripts."""
    normalized = {k: v for k, v in arguments.items() if k not in ('target_handle', 'timeout_sec')}
    for key in ('shipment_ids', 'tracking_numbers'):
        if isinstance(normalized.get(key), list):
            normalized[key] = sorted(normalized[key])
    fingerprint = sha256(json.dumps([key, normalized], sort_keys=True).encode()).hexdigest()
    path = _path()
    try:
        # No unbounded queue when AI starts parallel CLI calls.
        with interprocess_lock(path.with_suffix('.lock'), timeout_seconds=0):
            state = json.loads(path.read_text()) if path.exists() else {}
            now = time.time()
            if state.get('cooldown_until', 0) > now:
                return _blocked('source_cooldown', state['cooldown_until'] - now,
                                observed_signal=state.get('observed_signal'))
            recent = {k: t for k, t in state.get('recent', {}).items() if now - t < DUPLICATE_SECONDS}
            if deduplicate and fingerprint in recent:
                return _blocked('recent_query', recent[fingerprint] + DUPLICATE_SECONDS - now)
            delay = max(0, min(COMMAND_GAP, state.get('finished_at', 0) + COMMAND_GAP - now))
            if delay:
                time.sleep(delay)
            if deduplicate:
                recent[fingerprint] = time.time()
            state['recent'] = recent
            # Reserve before execution, so crashes cannot immediately repeat.
            state['finished_at'] = time.time()
            _save(path, state)
            try:
                payload = run()
                signal = _risk(payload)
                if signal is not None:
                    cooldown = _retry_after(payload, time.time())
                    state.update(cooldown_until=time.time() + cooldown, observed_signal=signal)
                    payload['request_protection'] = {'cooldown_seconds': cooldown,
                                                     'observed_signal': signal}
            except Exception as exc:
                state['finished_at'] = time.time()
                try:
                    _save(path, state)
                except Exception as write_error:
                    raise RuntimeError(f'{type(exc).__name__}: {exc}; request bookkeeping: {type(write_error).__name__}: {write_error}') from exc
                raise
            state['finished_at'] = time.time()
            try:
                _save(path, state)
            except Exception as exc:
                # Do not turn a completed write into an apparent failed submit.
                payload['request_bookkeeping_error'] = f'{type(exc).__name__}: {exc}'
            return payload
    except InterProcessLockTimeout:
        return _blocked('request_in_progress', COMMAND_GAP)
