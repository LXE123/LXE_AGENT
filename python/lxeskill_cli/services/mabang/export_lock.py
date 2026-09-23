"""Serialize exports whose filters live in the ERP account session."""
from hashlib import sha256
from shared.process_lock import interprocess_lock
from shared.repository import state_root
from services.mabang import config


def account_digest(account: str) -> str:
    return sha256(account.strip().encode()).hexdigest()


def warehouse_export_lock(account: str | None = None):
    identity = account if account is not None else config.MABANG_ACCOUNT
    return interprocess_lock(state_root() / 'db/lxeskill/mabang' / f'warehouse-{account_digest(identity)}.lock', timeout_seconds=0)
