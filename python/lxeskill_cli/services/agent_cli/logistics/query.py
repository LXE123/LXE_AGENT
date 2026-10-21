"""Route one explicit shipment through a configured account and fixed adapters."""
from __future__ import annotations

import os
import re

from . import feiwo_query, jiufang_query, tiantai_query, wesa_query, yuntuo_query
from .login import ensure_login
from .login_worker import LOGIN_HOSTS
from .common import diagnostic, safe_output
from .profiles import selected_profile
from .provider_registry import PROVIDER_BY_ID

ADAPTERS = {"wesa": wesa_query, "feiwo": feiwo_query, "yuntuo": yuntuo_query,
            "tiantai": tiantai_query, "jiufang": jiufang_query}


def run(arguments):
    result = {"success": False, "auth_refresh_required": False, "request_succeeded": False}
    try:
        allowed = {"profile_id", "store_id", "fba", "account_name", "expected_warehouse", "page", "identifier_kind", "login_mode"}
        if not isinstance(arguments, dict) or set(arguments) - allowed:
            raise ValueError("Unexpected logistics query arguments")
        if not isinstance(arguments.get("fba"), str) or not wesa_query.FBA_PATTERN.fullmatch(arguments["fba"]) or len(arguments["fba"]) > 64:
            raise ValueError("fba must be one complete uppercase FBA identifier")
        profile, revision = selected_profile(arguments.get("profile_id"))
        provider = profile["provider_id"]
        spec = PROVIDER_BY_ID[provider]
        result.update(profile_id=profile["profile_id"], profile_name=profile["display_name"],
                      provider=provider, settings_revision=revision, fba=arguments["fba"])
        args = {key: arguments[key] for key in ("fba", "expected_warehouse") if key in arguments}
        if spec.requires_store:
            if not os.environ.get("LXE_AGENT_SESSION_ID", "").strip():
                raise ValueError("LXE_AGENT_SESSION_ID is required; run in the LXE_Agent execution session")
            store = arguments.get("store_id")
            if not isinstance(store, str) or not store.strip() or len(store) > 256:
                raise ValueError("Browser providers require an explicit running store_id for this task")
            args["store_id"] = store
        elif "store_id" in arguments:
            raise ValueError("Public HTTP queries do not accept store_id")
        mode = arguments.get("login_mode", "auto" if provider in LOGIN_HOSTS and profile["credential_id"] is not None else "reuse")
        if mode not in ("auto", "reuse"):
            raise ValueError("login_mode must be auto or reuse")
        auto_login = mode == "auto"
        if auto_login and provider not in LOGIN_HOSTS:
            raise ValueError("Automatic login is not verified for this logistics provider; reuse the verified existing query page")
        if spec.requires_account_name:
            company = arguments.get("account_name")
            if company is not None and (not isinstance(company, str) or not 2 <= len(company.strip()) <= 200):
                raise ValueError("account_name must be the company confirmed on the current page")
            if company is None and not auto_login:
                raise ValueError("account_name must be the company confirmed on the current page; login_username is not a company name")
            if company is not None:
                args["account_name"] = company.strip()
        elif "account_name" in arguments:
            raise ValueError("This provider does not accept account_name")
        if "page" in arguments:
            if provider not in ("wesa", "tiantai"):
                raise ValueError("Only Wesa and TianTai support an explicit page")
            if type(arguments["page"]) is not int or not 1 <= arguments["page"] <= 1000:
                raise ValueError("page must be an integer between 1 and 1000")
            args["page"] = arguments["page"]
        if "identifier_kind" in arguments:
            if provider != "jiufang":
                raise ValueError("Only Jiufang accepts identifier_kind")
            if arguments["identifier_kind"] not in ("auto", "shipment", "box"):
                raise ValueError("identifier_kind must be auto, shipment or box")
            args["identifier_kind"] = arguments["identifier_kind"]
        warehouse = args.get("expected_warehouse", "")
        if not isinstance(warehouse, str) or (warehouse and not re.fullmatch(r"[A-Z0-9]{2,12}", warehouse)):
            raise ValueError("expected_warehouse must be an uppercase warehouse code")
        if auto_login:
            authentication = ensure_login(profile, revision, args["store_id"])
            result["login"] = authentication
            if authentication.get("success") is not True:
                result["error"] = authentication.get("error", {"code": "login_not_ready", "message": diagnostic(authentication)})
                return safe_output(result)
            _, current_revision = selected_profile(profile["profile_id"])
            if current_revision != revision:
                raise ValueError("Logistics settings changed during login; reload profiles before querying")
            if spec.requires_account_name and "account_name" not in args:
                raise ValueError("Login completed. Confirm the current company in a fresh snapshot and pass account_name; company identity is not uniquely verified")
        # Preserve the adapter payload intact: its errors, warnings, missing
        # fields, identity and pagination remain authoritative.
        payload = ADAPTERS[provider].run(args)
        if not isinstance(payload, dict) or type(payload.get("success")) is not bool:
            raise ValueError("Logistics adapter returned an invalid result envelope")
        result.update(success=payload["success"], request_succeeded=payload.get("request_succeeded", False),
                      result=payload)
        if not payload["success"] and "error" in payload:
            result["error"] = payload["error"]
    except Exception as exc:
        result["error"] = {"code": "logistics_query_failed", "message": diagnostic(f"{type(exc).__name__}: {exc}")}
    return safe_output(result)
