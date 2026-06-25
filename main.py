import asyncio
import os
import signal
import sys
import threading
import uuid

from shared.llm.agent_planner import log_active_agent_planner_summary
from gateway.app import GatewayApp
from gateway.planned_stop import (
    clear_gateway_status,
    request_gateway_stop,
    run_planned_stop_watcher,
    write_gateway_status,
)
from shared.infra.net import bootstrap_network_policy
from shared.logging import logger


bootstrap_network_policy(label="gateway", emit=logger.info)


async def _run_gateway() -> None:
    log_active_agent_planner_summary()
    app = GatewayApp.from_config()
    loop = asyncio.get_running_loop()
    boot_id = uuid.uuid4().hex
    watcher_stop = threading.Event()
    watcher_thread = threading.Thread(
        target=run_planned_stop_watcher,
        kwargs={
            "stop_event": watcher_stop,
            "boot_id": boot_id,
            "loop": loop,
            "request_shutdown": app.request_shutdown,
        },
        name="gateway:planned-stop",
        daemon=True,
    )
    shutdown_stage = 0
    watcher_started = False

    def _request_shutdown() -> None:
        nonlocal shutdown_stage
        shutdown_stage += 1
        if shutdown_stage == 1:
            logger.info("🛑 [Gateway] 收到停止信号，开始优雅关闭...")
            try:
                loop.call_soon_threadsafe(app.request_shutdown)
            except RuntimeError:
                app.request_shutdown()
            return
        logger.warning("💥 [Gateway] 第二次停止信号，立即强制退出。")
        os._exit(130)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _request_shutdown)
        except (NotImplementedError, RuntimeError, ValueError):
            pass

    try:
        write_gateway_status(boot_id)
        watcher_thread.start()
        watcher_started = True
        await app.start()
        await app.wait_forever()
    finally:
        watcher_stop.set()
        if watcher_started:
            watcher_thread.join(timeout=2.0)
        clear_gateway_status(boot_id)
        await app.stop()


def _stop_gateway() -> int:
    result = request_gateway_stop(timeout_s=30.0)
    print(result.message)
    return 0 if result.success else 1


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1].strip().lower() == "stop":
        return _stop_gateway()
    try:
        asyncio.run(_run_gateway())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
