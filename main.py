import asyncio
import os
import signal

from shared.llm.agent_planner import bootstrap_agent_planner_selection, log_active_agent_planner_summary
from gateway.app import GatewayApp
from shared.infra.net import bootstrap_network_policy
from shared.logging import logger


bootstrap_network_policy(label="gateway", emit=logger.info)


async def _run_gateway() -> None:
    bootstrap_agent_planner_selection()
    log_active_agent_planner_summary()
    app = GatewayApp.from_config()
    loop = asyncio.get_running_loop()
    shutdown_stage = 0

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
            signal.signal(sig, lambda *_args, _shutdown=_request_shutdown: _shutdown())

    try:
        await app.start()
        await app.wait_forever()
    finally:
        await app.stop()


def main():
    try:
        asyncio.run(_run_gateway())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
