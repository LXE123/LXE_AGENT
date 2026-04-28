from __future__ import annotations

from contextlib import contextmanager
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from shared.config import config
from shared.logging import logger


REQUIRED_DRIVER = "postgresql+psycopg"


def _mask_database_url(database_url: str) -> str:
    try:
        return make_url(database_url).render_as_string(hide_password=True)
    except Exception:
        return "<masked>"


def _validate_pricing_database_url(database_url: str) -> None:
    url = make_url(database_url)
    if url.drivername == REQUIRED_DRIVER:
        return
    raise ValueError(
        "PRICING_DATABASE_URL must use postgresql+psycopg://. "
        f"Got driver {url.drivername!r} from {_mask_database_url(database_url)}. "
        "Update postgresql:// or postgresql+psycopg2:// URLs to "
        "postgresql+psycopg://."
    )


DATABASE_URL = str(config.PRICING_DATABASE_URL)
_engine = None
_session_factory = None


def get_engine():
    global _engine, _session_factory
    if _engine is None:
        _validate_pricing_database_url(DATABASE_URL)
        logger.info(
            f"🗄️ [FBA Pricing DB] 链接物流报价数据: {_mask_database_url(DATABASE_URL)}"
        )
        _engine = create_engine(
            DATABASE_URL,
            pool_pre_ping=True,
            pool_size=10,
            max_overflow=5,
            echo=False,
        )
        _session_factory = sessionmaker(autocommit=False, autoflush=False, bind=_engine)
    return _engine


def _get_session_factory():
    global _session_factory
    if _session_factory is None:
        get_engine()
    return _session_factory


@contextmanager
def session_scope():
    session = _get_session_factory()()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def dispose() -> None:
    global _engine, _session_factory
    if _engine is None:
        return
    _engine.dispose()
    _engine = None
    _session_factory = None
