import json


def convert_json_values_to_string(obj: dict) -> dict:
    return {
        key: (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
        for key, value in obj.items()
    }
