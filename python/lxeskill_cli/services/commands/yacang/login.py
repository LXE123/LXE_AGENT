from services.yacang.workflow import login_action


def run(arguments):
    action = arguments.get("action")
    try:
        if action not in ("prepare", "submit", "status", "clear"):
            raise ValueError("action must be prepare, submit, status or clear")
        fields = {"challenge_id", "captcha_code"} if action == "submit" else set()
        unknown = set(arguments) - {"action"} - fields
        if unknown:
            raise ValueError(f"Unsupported options for {action}: {', '.join(sorted(unknown))}")
        for field in fields:
            value = arguments.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"submit requires --{field.replace('_', '-')}")
    except ValueError as exc:
        return {"success": False, "status": "failed", "login_succeeded": False, "persisted": False,
                "error": {"code": "invalid_arguments", "message": str(exc)}}
    return login_action(action, {field: arguments[field] for field in fields})
