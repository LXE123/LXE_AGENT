import logging


logger = logging.getLogger("bot_logger")
logger.setLevel(logging.INFO)

if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("➤ %(asctime)s %(levelname)-8s %(message)s"))
    logger.addHandler(handler)
