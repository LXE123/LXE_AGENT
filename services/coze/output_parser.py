import json


def extract_output_content(raw_output_str):
    if not raw_output_str:
        return "（无内容返回）"

    try:
        output_data = json.loads(raw_output_str)
        priority_keys = ["输出文本发送至钉钉", "output"]
        parts = [str(output_data[key]) for key in priority_keys if output_data.get(key)]
        if parts:
            return "\n\n".join(parts)
        return json.dumps(output_data, ensure_ascii=False, indent=2)
    except json.JSONDecodeError:
        return raw_output_str
    except Exception:
        return raw_output_str
