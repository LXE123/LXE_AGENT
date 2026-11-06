"""Private, disposable authentication state owned by lxeskillCLI."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import time
import uuid
from pathlib import Path

from shared.repository import state_root
from shared.workspace import artifact_path
from shared.process_lock import interprocess_lock
from .contracts import Credentials
from .errors import YacangError


def _restrict_permissions(path: Path, mode: int) -> None:
    # Windows chmod only controls the read-only attribute; state inherits the app data ACL there.
    if os.name != "nt":
        os.chmod(path, mode)


def _atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    _restrict_permissions(path.parent, 0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            _restrict_permissions(temporary, 0o600)
            json.dump(payload, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            original = sys.exception()
            try:
                temporary.unlink(missing_ok=True)
            except OSError as cleanup:
                if original is None:
                    raise
                raise YacangError("登录态", f"{type(original).__name__}: {original}; 清理临时文件失败: {type(cleanup).__name__}: {cleanup}", code="auth_state_unavailable", scope="global") from original


class YacangAuthState:
    def __init__(self, credentials: Credentials):
        self.credentials = credentials
        self.account_id = credentials.account_id
        root = state_root() / "db" / "lxeskill" / "yacang-auth"
        self.root = root / self.account_id
        self.session_path = self.root / "session.json"
        self.fingerprint = hashlib.sha256((credentials.mobile + "\0" + credentials.password).encode()).hexdigest()
        self.images = artifact_path("yacang", "login") / self.account_id

    def lock(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        _restrict_permissions(self.root, 0o700)
        return interprocess_lock(self.root / "auth.lock", timeout_seconds=10)

    def _read_session(self) -> dict | None:
        if not self.session_path.exists():
            return None
        try:
            value = json.loads(self.session_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise YacangError("登录态", f"无法读取本地登录态: {type(exc).__name__}: {exc}", code="auth_state_unavailable", scope="global") from None
        if not isinstance(value, dict):
            raise YacangError("登录态", f"本地登录态应为对象，实际为 {type(value).__name__}", code="auth_state_unavailable", scope="global")
        fingerprint = value.get("fingerprint")
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            raise YacangError("登录态", "本地登录态 fingerprint 缺失或格式无效", code="auth_state_unavailable", scope="global")
        if fingerprint != self.fingerprint:
            # An older process must not delete a newer credential's session.
            return None
        if not isinstance(value.get("token"), str) or not value["token"].strip():
            raise YacangError("登录态", "本地登录态 token 缺失或格式无效", code="auth_state_unavailable", scope="global")
        return value

    def _epoch(self) -> str:
        path = self.root / "epoch.json"
        if not path.exists():
            return ""
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            epoch = value["epoch"]
            if not isinstance(epoch, str):
                raise ValueError("epoch is not a string")
            return epoch
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise YacangError("登录态", f"无法读取本地登录代次: {type(exc).__name__}: {exc}", code="auth_state_unavailable", scope="global") from None

    def epoch(self) -> str:
        with self.lock():
            return self._epoch()

    def prepare(self, key: str, image: bytes, *, epoch: str | None = None) -> dict:
        with self.lock():
            if epoch is not None and epoch != self._epoch():
                raise YacangError("登录态", "本地登录态已清除，不保存正在获取的验证码", code="login_cleared", scope="global")
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.images.mkdir(parents=True, exist_ok=True, mode=0o700)
            _restrict_permissions(self.root, 0o700)
            _restrict_permissions(self.images, 0o700)
            self._cleanup_challenges()
            challenge_id = "challenge-" + uuid.uuid4().hex
            expires_at = time.time() + 300
            image_path = self.images / f"{challenge_id}.jpg"
            created = False
            try:
                with image_path.open("xb") as stream:
                    created = True
                    _restrict_permissions(image_path, 0o600)
                    stream.write(image)
                _atomic_json(self.root / f"{challenge_id}.json", {
                    "key": key, "expires_at": expires_at, "fingerprint": self.fingerprint,
                })
            except Exception as exc:
                if created:
                    try:
                        image_path.unlink(missing_ok=True)
                    except OSError as cleanup:
                        raise YacangError("验证码", f"{type(exc).__name__}: {exc}; 清理图片失败: {type(cleanup).__name__}: {cleanup}", code="challenge_save_failed", scope="global") from None
                raise
            return {"challenge_id": challenge_id, "image_path": str(image_path.resolve()), "expires_at": expires_at}

    def _cleanup_challenges(self) -> None:
        for path in self.root.glob("challenge-*.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                expired = payload.get("expires_at", 0) <= time.time()
            except (ValueError, AttributeError, TypeError):
                expired = True
            if expired:
                path.unlink(missing_ok=True)
                (self.images / f"{path.stem}.jpg").unlink(missing_ok=True)
        for image in self.images.glob("challenge-*.jpg"):
            if not (self.root / f"{image.stem}.json").exists():
                image.unlink(missing_ok=True)

    def consume(self, challenge_id: str) -> tuple[str, str]:
        if not re.fullmatch(r"challenge-[a-f0-9]{32}", challenge_id):
            raise YacangError("验证码", "challenge_id 格式无效", code="invalid_challenge", scope="global")
        with self.lock():
            path = self.root / f"{challenge_id}.json"
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                raise YacangError("验证码", "验证码不存在或已经提交，请重新获取", code="challenge_unavailable", scope="global") from None
            except (OSError, ValueError) as exc:
                raise YacangError("验证码", f"无法读取验证码状态: {type(exc).__name__}: {exc}", code="challenge_unavailable", scope="global") from None
            # Consume before network I/O; an uncertain response must never replay a challenge.
            path.unlink(missing_ok=True)
            (self.images / f"{challenge_id}.jpg").unlink(missing_ok=True)
            if payload.get("fingerprint") != self.fingerprint:
                raise YacangError("验证码", "雅仓凭据已变更，请重新获取验证码", code="credentials_changed", scope="global")
            if payload.get("expires_at", 0) <= time.time():
                raise YacangError("验证码", "本地验证码已过期，请重新获取", code="challenge_expired", scope="global")
            key = payload.get("key")
            if not isinstance(key, str) or not key:
                raise YacangError("验证码", "本地验证码状态无效，请重新获取", code="challenge_unavailable", scope="global")
            return key, self._epoch()

    def save_session(self, token: str, *, epoch: str | None = None) -> dict:
        with self.lock():
            if epoch is not None and epoch != self._epoch():
                raise YacangError("登录态", "本地登录态已清除，不保存正在完成的旧登录", code="login_cleared", scope="global")
            now = time.time()
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            _atomic_json(self.session_path, {"token": token, "fingerprint": self.fingerprint, "saved_at": now})
            return {"saved_at": now}

    def session(self) -> str:
        with self.lock():
            value = self._read_session()
            token = value.get("token") if value else None
            if not isinstance(token, str) or not token:
                raise YacangError("登录", "雅仓登录态缺失，请先运行雅仓登录 Skill", code="login_required", scope="global")
            return token

    def status(self) -> dict:
        with self.lock():
            value = self._read_session()
            authenticated = bool(value and isinstance(value.get("token"), str) and value["token"])
            return {"authenticated": authenticated, "online_verified": False,
                    "status": "available" if authenticated else "missing", "saved_at": value.get("saved_at") if authenticated else None}

    def invalidate(self, rejected_token: str) -> None:
        with self.lock():
            value = self._read_session()
            if value and value.get("token") == rejected_token:
                self.session_path.unlink(missing_ok=True)

    def clear(self) -> None:
        with self.lock():
            _atomic_json(self.root / "epoch.json", {"epoch": uuid.uuid4().hex})
            self.session_path.unlink(missing_ok=True)
            for path in self.root.glob("challenge-*.json"):
                path.unlink(missing_ok=True)
            if self.images.exists():
                for path in self.images.glob("challenge-*.jpg"):
                    path.unlink(missing_ok=True)
