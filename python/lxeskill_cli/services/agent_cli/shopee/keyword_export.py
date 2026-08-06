"""`lxeskill shopee keywords export` — 全量抓取海鹰搜索量并生成 Excel 报表。"""
from __future__ import annotations

from typing import Any, Callable

import requests

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.agent_cli.shopee._shared import (
    CredentialsNotConfiguredError,
    load_default_keywords,
    resolve_countries,
    resolve_credentials,
    unique_nonempty,
)
from services.agent_cli.shopee.haiying_client import (
    AuthenticationError,
    HaiyingClient,
    fetch_all_pages,
)
from services.agent_cli.shopee.report import (
    REPORT_FILE_NAME,
    build_excel,
    verify_workbook,
)
from shared.datasets import dataset_dir


def _report_path() -> Any:
    return dataset_dir("shopee_keyword_search", REPORT_FILE_NAME)


def run_with_events(
    arguments: dict[str, Any],
    on_event: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    keywords: list[str] = []
    try:
        keywords = unique_nonempty(arguments.get("keywords") or [])
        keyword_source = "arguments"
        if not keywords:
            keywords, keyword_source = load_default_keywords()
        if not keywords:
            raise ValueError("关键词列表为空")
        countries = resolve_countries(arguments.get("countries"))

        username, password, credential_source = resolve_credentials()
        client = HaiyingClient(username, password)
        combined: dict[str, dict[str, dict[str, int | float | None]]] = {}
        summary_countries: dict[str, dict[str, dict[str, int]]] = {}
        try:
            on_event({"stage": "login", "message": "海鹰登录中"})
            client.login()
            total_queries = len(countries) * len(keywords)
            completed = 0
            for country in countries:
                country_key = f"{country['name']}({country['code']})"
                country_result: dict[str, dict[str, int | float | None]] = {}
                country_stats: dict[str, dict[str, int]] = {}
                for keyword in keywords:
                    completed += 1
                    on_event(
                        {
                            "stage": "fetch_query",
                            "current": completed,
                            "total": total_queries,
                            "country": country_key,
                            "keyword": keyword,
                        }
                    )
                    data, stats = fetch_all_pages(client, country, keyword)
                    country_result[keyword] = data
                    country_stats[keyword] = stats
                combined[country_key] = country_result
                summary_countries[country_key] = country_stats
        finally:
            client.close()

        output_path = _report_path()
        on_event({"stage": "build_excel", "path": str(output_path)})
        build_excel(output_path, combined)
        verify_workbook(output_path, len(countries))

        totals = {
            "countries": len(countries),
            "input_keywords": len(keywords),
            "queries": len(countries) * len(keywords),
            "raw_rows": sum(
                item["raw_rows"]
                for country_stats in summary_countries.values()
                for item in country_stats.values()
            ),
            "unique_keyword_pairs": sum(
                len(keyword_map)
                for country_map in combined.values()
                for keyword_map in country_map.values()
            ),
            "pages": sum(
                item["pages"]
                for country_stats in summary_countries.values()
                for item in country_stats.values()
            ),
        }
        return {
            "success": True,
            "excel_path": str(output_path),
            "keywords": keywords,
            "keyword_source": keyword_source,
            "countries": [country["name"] for country in countries],
            "credential_source": credential_source,
            "totals": totals,
        }
    except CredentialsNotConfiguredError as exc:
        return {"success": False, "error_kind": "credentials_not_configured", "exception": _exception_text(exc)}
    except AuthenticationError as exc:
        return {"success": False, "error_kind": "authentication_failed", "exception": _exception_text(exc)}
    except requests.RequestException as exc:
        return {"success": False, "error_kind": "network_error", "exception": _exception_text(exc)}
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "keywords": keywords,
            "exception": f"{type(exc).__name__}: {_exception_text(exc)}",
        }


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    return run_with_events(arguments, lambda _event: None)
