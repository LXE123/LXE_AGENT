from __future__ import annotations

from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]

REMOVED_PATHS = (
    "python/lxeskill_cli/shared/db/sqlite/_agent_storage.py",
    "python/lxeskill_cli/shared/db/sqlite/response_route_state.py",
    "python/lxeskill_cli/shared/db/sqlite/session_messages.py",
    "python/lxeskill_cli/shared/db/sqlite/session_transcripts.py",
    "python/lxeskill_cli/shared/media",
    "python/lxeskill_cli/services/agent_cli/browser/amazon_fba/login_verify.py",
    "python/lxeskill_cli/services/agent_cli/mabang/build_amazon_fba_inventory_snapshot.py",
    "python/lxeskill_cli/services/agent_cli/mabang/build_store_unlinked_shipments_snapshot.py",
    "python/lxeskill_cli/services/agent_cli/mabang/generate_purchase_summary_workbook.py",
    "skills/replenishment-amazon-fba-inventory-snapshot",
)

REMOVED_SYMBOLS = {
    "python/lxeskill_cli/shared/db/shared_state_dto.py": (
        "class AgentSessionState:",
        "class ResponseRouteContext:",
    ),
    "python/lxeskill_cli/shared/db/sqlite/bootstrap.py": (
        "def init_schema(",
        "def _create_agent_sessions(",
        "def _create_pending_events(",
        "def _create_response_routes(",
        "def _create_turn_usage(",
    ),
    "python/lxeskill_cli/shared/db/store_sessions_client.py": (
        "def init_schema(",
    ),
}


def test_removed_python_dead_code_stays_removed() -> None:
    remaining = [path for path in REMOVED_PATHS if (REPOSITORY_ROOT / path).exists()]
    assert remaining == []


def test_removed_python_compatibility_symbols_stay_removed() -> None:
    leftovers: list[str] = []
    for relative_path, symbols in REMOVED_SYMBOLS.items():
        content = (REPOSITORY_ROOT / relative_path).read_text(encoding="utf-8")
        leftovers.extend(
            f"{relative_path}: {symbol}"
            for symbol in symbols
            if symbol in content
        )
    assert leftovers == []
