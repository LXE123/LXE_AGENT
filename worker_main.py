import argparse

from shared.config import config
from shared.infra.net import bootstrap_network_policy
from shared.logging import logger


bootstrap_network_policy(label="worker", emit=logger.info)

from workers.main import main


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="agent-worker")
    parser.add_argument("--worker-id", default="")
    parser.add_argument("--dashboard-host", default=str(config.WORKER_DASHBOARD_HOST))
    parser.add_argument("--dashboard-port", type=int, default=int(config.WORKER_DASHBOARD_PORT))
    parser.add_argument("--gateway-ipc-url", default=f"http://{config.GATEWAY_IPC_HOST}:{int(config.GATEWAY_IPC_PORT)}")
    parser.add_argument("--gateway-pid", type=int, default=0)
    args = parser.parse_args()
    main(
        worker_id=str(args.worker_id or "").strip(),
        dashboard_host=str(args.dashboard_host or "").strip(),
        dashboard_port=int(args.dashboard_port),
        gateway_ipc_url=str(args.gateway_ipc_url or "").strip(),
        gateway_pid=int(args.gateway_pid or 0),
    )
