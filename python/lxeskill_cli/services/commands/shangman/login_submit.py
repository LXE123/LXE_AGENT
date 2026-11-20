from services.shangman.workflow import run_action


def run(arguments):
    return run_action("submit", arguments)
