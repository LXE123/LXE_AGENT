from __future__ import annotations

import importlib
import json
import os


def main() -> int:
    if os.environ.pop("LXESKILL_INTERNAL_IMPORT_SMOKE", "") == "1":
        from lxeskill.business import load_catalog

        modules = sorted(
            str(entry.get("module") or "").strip()
            for entry in load_catalog().values()
            if str(entry.get("module") or "").strip()
        )
        for module in modules:
            importlib.import_module(module)
        importlib.import_module("browser_auth_service.service")
        importlib.import_module("services.browser.tools.client")
        print(json.dumps({"ok": True, "modules": len(modules)}, separators=(",", ":")))
        return 0

    if os.environ.pop("LXESKILL_INTERNAL_PLAYWRIGHT_CLI", "") == "1":
        from playwright.__main__ import main as playwright_main

        playwright_main()
        return 0

    from lxeskill.cli import main as lxeskill_main

    return lxeskill_main()


if __name__ == "__main__":
    raise SystemExit(main())
