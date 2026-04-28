import os
import socket

from shared.config import config


HOSTNAME = socket.gethostname()
PID = os.getpid()


def gateway_identity_text(gateway_id: str = "") -> str:
    safe_gateway_id = str(gateway_id or config.GATEWAY_ID).strip()
    return f"gateway_id={safe_gateway_id} host={HOSTNAME} pid={PID}"
