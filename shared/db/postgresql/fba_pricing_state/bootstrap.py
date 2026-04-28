from services.amazon.amazon_logistic.pricing_schema import ensure_pricing_schema_with_engine

from .engine import get_engine


def ensure_schema(include_indexes: bool = True) -> None:
    ensure_pricing_schema_with_engine(get_engine(), include_indexes=include_indexes)
