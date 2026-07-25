from __future__ import annotations

import ast
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]

REMOVED_PATHS = (
    "python/lxeskill_cli/lxeskill/bridge.py",
    "python/lxeskill_cli/shared/db/sqlite/_agent_storage.py",
    "python/lxeskill_cli/shared/db/sqlite/response_route_state.py",
    "python/lxeskill_cli/shared/db/sqlite/session_messages.py",
    "python/lxeskill_cli/shared/db/sqlite/session_transcripts.py",
    "python/lxeskill_cli/shared/agent_state.py",
    "python/lxeskill_cli/shared/env_files.py",
    "python/lxeskill_cli/shared/infra/artifact_io.py",
    "python/lxeskill_cli/shared/media",
    "python/lxeskill_cli/services/browser/store/agent_tool_state.py",
    "python/lxeskill_cli/services/agent_cli/browser/amazon_fba/login_verify.py",
    "python/lxeskill_cli/services/agent_cli/mabang/build_amazon_fba_inventory_snapshot.py",
    "python/lxeskill_cli/services/agent_cli/mabang/build_store_unlinked_shipments_snapshot.py",
    "python/lxeskill_cli/services/agent_cli/mabang/generate_purchase_summary_workbook.py",
    "python/lxeskill_cli/services/browser/workflows/registry.py",
    "skills/replenishment-amazon-fba-inventory-snapshot",
)

REMOVED_SYMBOLS = {
    "python/lxeskill_cli/shared/db/shared_state_dto.py": ("AgentSessionState", "ResponseRouteContext"),
    "python/lxeskill_cli/shared/db/sqlite/bootstrap.py": (
        "init_schema",
        "_create_agent_sessions",
        "_create_pending_events",
        "_create_response_routes",
        "_create_turn_usage",
    ),
    "python/lxeskill_cli/shared/db/sqlite/engine.py": ("dispose",),
    "python/lxeskill_cli/shared/db/store_sessions_client.py": ("init_schema",),
    "python/lxeskill_cli/shared/infra/net/aiohttp_client.py": ("get_aiohttp_session",),
    "python/lxeskill_cli/shared/infra/net/requests_client.py": ("get_requests_session",),
    "python/lxeskill_cli/shared/log_retention.py": (
        "ensure_local_log_retention_once",
        "reset_local_log_retention_once_for_tests",
    ),
    "python/lxeskill_cli/lxeskill/cli.py": ("standalone_main",),
    "python/lxeskill_cli/services/agent_cli/browser/amazon_common/own_carrier.py": (
        "_open_phase_3_1_carrier_dropdown",
        "_phase_3_2_ship_date_calendar_day_selected",
        "_read_phase_3_2_ship_date_value",
        "_select_phase_3_2_dropdown_value",
    ),
    "python/lxeskill_cli/services/agent_cli/browser/amazon_common/region_switch.py": (
        "MARKETPLACE_SWITCHER_URL",
    ),
    "python/lxeskill_cli/services/agent_cli/browser/amazon_common/send_to_amazon.py": (
        "SEND_TO_AMAZON_URL",
    ),
    "python/lxeskill_cli/services/agent_cli/browser/amazon_fba/_shared.py": (
        "resolve_response_route_id",
        "send_selected_result_files",
    ),
    "python/lxeskill_cli/services/agent_cli/mabang/fill_invoice_template.py": ("build_invoice_box_rows",),
    "python/lxeskill_cli/services/agent_cli/mabang/generate_restock_workbook.py": (
        "generate_purchase_summary_workbook",
    ),
    "python/lxeskill_cli/services/agent_cli/mabang/shipment_quantity_validation.py": (
        "ConsignmentMskuQuantityRow",
        "read_delivery_msku_components",
    ),
    "python/lxeskill_cli/services/mabang/amazon/fba/consignment_excel.py": (
        "resolve_test_file_dir",
    ),
    "python/lxeskill_cli/services/browser/browser/selenium_runner.py": ("detach",),
    "python/lxeskill_cli/services/browser/browser/seller_central_adapters.py": (
        "seller_central_home_favorite_links",
        "seller_central_landmarks",
        "seller_central_summary_lines",
    ),
    "python/lxeskill_cli/services/browser/browser/snapshot.py": ("summarize_page_landmarks",),
    "python/lxeskill_cli/services/browser/models/models.py": (
        "AgentCommand",
        "AgentResult",
        "ToolArgumentDefinition",
        "ToolDefinition",
        "ToolResult",
    ),
    "python/lxeskill_cli/services/browser/models/protocol.py": (
        "emit_artifact",
        "emit_direct_delivery",
        "emit_result",
    ),
    "python/lxeskill_cli/services/browser/store/ziniao_client.py": ("update_core",),
    "python/lxeskill_cli/services/browser/store/ziniao_config.py": ("is_ziniao_tool_configured",),
    "python/lxeskill_cli/services/browser/store/ziniao_lifecycle.py": (
        "_ClientTracker",
        "register_client",
        "register_store",
        "release_store",
        "run_store_tasks_in_threads",
        "shutdown_client_if_idle",
    ),
    "python/lxeskill_cli/services/browser/tools/models.py": ("payload_dict",),
    "python/lxeskill_cli/services/browser/tools/schema.py": (
        "browser_planner_tool_schemas",
        "browser_tool_reply_kind",
    ),
    "python/lxeskill_cli/services/browser/workflows/amazon_fba_common.py": ("wait_for_snapshot",),
    "python/lxeskill_cli/services/browser/workflows/amazon_fba_shipment_files.py": (
        "prepare_consignment_excel_payload",
    ),
    "python/lxeskill_cli/services/mabang/amazon/fba/msku_detail.py": (
        "load_mskus_from_consignment_excel",
    ),
    "python/lxeskill_cli/services/mabang/amazon/fba/store_msku_replenishment.py": (
        "INVENTORY_SHEETS",
        "replenishment_days",
        "trend_group",
    ),
    "python/lxeskill_cli/services/mabang/amazon/fba/store_resolver.py": (
        "query_field",
        "shop_id",
        "warehouse_id",
    ),
    "python/lxeskill_cli/services/mabang/auth.py": ("ERP_COOKIE_NAMES", "get_erp_cookie_bundle"),
    "python/lxeskill_cli/services/mabang/config.py": (
        "MABANG_FBA_UNLINKED_SHIPMENTS_OUTPUT_DIR",
        "MABANG_STORE_MSKU_ANALYSIS_OUTPUT_DIR",
        "MABANG_STORE_MSKU_REPLENISHMENT_OUTPUT_DIR",
    ),
    "python/lxeskill_cli/services/mabang/cookies.py": ("require_cookie_values",),
}

PROTECTED_SYMBOLS = {
    "python/lxeskill_cli/services/browser/workflows/amazon_fba_login_verify.py": (
        "run_login_verify_workflow",
    ),
    "python/lxeskill_cli/services/mabang/amazon/fba/amazon_fba_inventory.py": (
        "build_amazon_fba_inventory_snapshot",
    ),
    "python/lxeskill_cli/services/agent_cli/mabang/fill_customs_declaration.py": (
        "INPUT_HEADERS",
        "SOURCE_WORKSHEET_NAME",
    ),
    "python/lxeskill_cli/services/agent_cli/mabang/fill_invoice_template.py": (
        "DELIVERY_MSKU_COLUMN",
        "INPUT_HEADERS",
        "MERGE_DETAIL_HEADERS",
        "SKU_SHIP_QTY_COLUMN",
    ),
    "python/lxeskill_cli/services/mabang/amazon/fba/store_msku.py": ("STORE_MSKU_EXPORT_FIELDS",),
    "python/lxeskill_cli/services/mabang/amazon/fba/store_msku_actual_inventory.py": ("OUTPUT_COLUMNS",),
    "python/lxeskill_cli/services/mabang/amazon/fba/store_msku_replenishment.py": ("REPORT_SHEETS",),
}


def _defined_symbols(relative_path: str) -> set[str]:
    source_path = REPOSITORY_ROOT / relative_path
    tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
    symbols = {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
    }
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            symbols.update(alias.asname or alias.name for alias in node.names)
        targets: list[ast.expr] = []
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = list(node.targets) if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            if isinstance(target, ast.Name):
                symbols.add(target.id)
    return symbols


def test_removed_python_dead_code_stays_removed() -> None:
    remaining = [path for path in REMOVED_PATHS if (REPOSITORY_ROOT / path).exists()]
    assert remaining == []


def test_removed_python_compatibility_symbols_stay_removed() -> None:
    leftovers: list[str] = []
    for relative_path, symbols in REMOVED_SYMBOLS.items():
        defined_symbols = _defined_symbols(relative_path)
        leftovers.extend(
            f"{relative_path}: {symbol}"
            for symbol in symbols
            if symbol in defined_symbols
        )
    assert leftovers == []


def test_protected_python_workflows_and_contracts_stay_available() -> None:
    missing: list[str] = []
    for relative_path, symbols in PROTECTED_SYMBOLS.items():
        defined_symbols = _defined_symbols(relative_path)
        missing.extend(
            f"{relative_path}: {symbol}"
            for symbol in symbols
            if symbol not in defined_symbols
        )
    assert missing == []
