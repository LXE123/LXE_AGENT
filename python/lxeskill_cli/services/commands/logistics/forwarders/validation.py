"""Shipment identity and argument rules shared by freight forwarder adapters."""
from __future__ import annotations

import re
from collections.abc import Callable, Collection
from typing import Any

from shared.fba_identifiers import normalize_identifier, validate_fba

from ..provider_registry import SHIPMENT_QUERY_PROVIDERS


def clean_arguments(
    arguments: dict[str, Any], *, allowed: Collection[str], required: Collection[str]
) -> dict[str, Any]:
    unknown = set(arguments) - set(allowed)
    if unknown:
        raise ValueError("Unknown arguments: " + ", ".join(sorted(unknown)))
    for key in required:
        if not isinstance(arguments.get(key), str) or not arguments[key].strip():
            raise ValueError(f"{key} is required")
    return {key: value.strip() if isinstance(value, str) else value for key, value in arguments.items()}


def validate_warehouse(value: Any) -> None:
    if not isinstance(value, str) or (value and not re.fullmatch(r"[A-Z0-9]{2,12}", value)):
        raise ValueError("expected_warehouse must be an uppercase warehouse code")


def validate_page(value: Any) -> int:
    if type(value) is not int or not 1 <= value <= 1000:
        raise ValueError("page must be an integer between 1 and 1000")
    return value


def validate_tracking_query(
    arguments: dict[str, Any], *,
    allowed: Collection[str] = ("store_id", "fba", "expected_warehouse"),
    required: Collection[str] = ("store_id", "fba"),
) -> dict[str, Any]:
    """Validate browser query inputs once; adapters add only protocol options."""
    clean = clean_arguments(
        arguments,
        allowed=allowed,
        required=required,
    )
    if len(clean["store_id"]) > 256:
        raise ValueError("store_id length is invalid")
    validate_fba(clean["fba"])
    if "account_name" in clean and not 2 <= len(clean["account_name"]) <= 200:
        raise ValueError("account_name length is invalid")
    validate_warehouse(clean.get("expected_warehouse", ""))
    return clean


def prepare_query_arguments(
    provider: str, arguments: dict[str, Any],
    validate: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    """Apply shared identifier policy before building any provider request."""
    args = validate(arguments)
    if provider in SHIPMENT_QUERY_PROVIDERS:
        args.update(normalize_identifier(arguments["fba"], args.get("identifier_kind", "auto")))
    return args


def fba_numbers(text: str) -> list[str]:
    """Match complete identifiers, retaining order and excluding prefix matches."""
    return list(dict.fromkeys(re.findall(r"(?<![A-Za-z0-9])FBA[A-Z0-9]{7,}(?![A-Za-z0-9])", text)))
