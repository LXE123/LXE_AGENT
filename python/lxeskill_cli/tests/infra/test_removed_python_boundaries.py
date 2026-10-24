from __future__ import annotations

import ast
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]

REMOVED_SYMBOLS = {
    "python/lxeskill_cli/shared/db/shared_state_dto.py": ("AgentSessionState", "ResponseRouteContext"),
    "python/lxeskill_cli/shared/db/sqlite/bootstrap.py": (
        "init_schema",
        "_create_agent_sessions",
        "_create_pending_events",
        "_create_response_routes",
        "_create_turn_usage",
    ),
    "python/lxeskill_cli/services/commands/browser/amazon_fba/_shared.py": (
        "resolve_response_route_id",
        "send_selected_result_files",
    ),
}

PROTECTED_SYMBOLS = {
    "python/lxeskill_cli/services/browser/workflows/amazon_fba_login_verify.py": (
        "run_login_verify_workflow",
    ),
    "python/lxeskill_cli/services/mabang/amazon/fba/amazon_fba_inventory.py": (
        "build_amazon_fba_inventory_snapshot",
    ),
    "python/lxeskill_cli/services/commands/mabang/fill_customs_declaration.py": (
        "INPUT_HEADERS",
        "SOURCE_WORKSHEET_NAME",
    ),
    "python/lxeskill_cli/services/commands/mabang/fill_invoice_template.py": (
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


def test_python_agent_state_and_routing_symbols_stay_removed() -> None:
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
