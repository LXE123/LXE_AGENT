# robot_coze/coze/coze_service.py
import json
import time
import asyncio
from shared.config import config
from services.coze.output_parser import extract_output_content
from shared.logging import logger
from shared.infra.net import external_http_session

# 🟢 常量提取
HEADERS = {"Authorization": config.COZE_AUTH_TOKEN, "Content-Type": "application/json"}
BASE_URL = config.COZE_BASE_URL

async def _coze_request(method, endpoint, payload=None):
    """
    内部私有方法：统一处理异步 HTTP 请求与基础异常
    """
    url = f"{BASE_URL}/{endpoint}"
    try:
        async with external_http_session.request(method, url, headers=HEADERS, json=payload) as response:
            # 读取 response body，避免后续重复读取时丢失内容。
            await response.read()
            return response
            
    except Exception as e:
        logger.error(f"❌ 请求异常 [{endpoint}]: {e}")
        return None

async def poll_coze_result(execute_id, user_id):
    """
    轮询 Coze 结果 (Linearized Logic)
    """
    logger.info(f"🔄 轮询开始: {execute_id}")
    start_time = time.time()
    debug_logged = False

    while time.time() - start_time <= config.POLL_TIMEOUT:
        res = await _coze_request("GET", f"workflows/{config.COZE_WORKFLOW_ID}/run_histories/{execute_id}")
        
        # 1. 网络层校验
        if not res or res.status != 200:
            await asyncio.sleep(2)
            continue

        # 2. 数据层校验
        try:
            res_json = await res.json()
        except:
            await asyncio.sleep(2)
            continue

        data = res_json.get("data")
        if not data:
            await asyncio.sleep(2)
            continue
            
        latest = data[0]
        status = latest.get("execute_status")
        
        # 3. 调试日志（只打印一次）
        if not debug_logged and (url := latest.get("debug_url")):
            logger.info(f"🔗 [调试链接] {url}")
            debug_logged = True

        # 4. 终态判断
        if status == "Success":
            content = extract_output_content(latest.get("output", ""))
            logger.info(f"[Coze 完成] {content[:50]}...")
            return "FINISHED", content, None
            
        if status == "Fail":
            return "FAIL", f"❌ 失败: {latest.get('error_message')}", None

        # 5. 中断处理 (Interruption)
        if interrupt := latest.get("interrupt_data"):
            logger.info("⏸️ 工作流中断，等待输入...")
            session_payload = {
                "execute_id": execute_id,
                "event_id": interrupt.get("event_id"),
                "interrupt_type": interrupt.get("type")
            }
            # 确保有提示文本
            content = extract_output_content(latest.get("output", "")) or "🤖 需要更多信息..."
            return "INTERRUPTED", content, session_payload

        # 未完成，继续等待
        await asyncio.sleep(2)

    return "FAIL", "❌ 等待超时", None

async def start_new_workflow(user_input, user_id):
    """
    启动新工作流
    """
    logger.info(f"🚀 [启动] User: {user_id} | Input: {user_input[:20]}...")
    
    res = await _coze_request("POST", "workflow/run", {
        "workflow_id": config.COZE_WORKFLOW_ID,
        "parameters": {"input": user_input},
        "is_async": True
    })

    if not res: 
        return "FAIL", "网络请求异常", None

    try:
        res_json = await res.json()
    except:
        return "FAIL", "响应解析异常", None

    if res_json.get("code") != 0:
        msg = res_json.get('msg')
        logger.error(f"❌ [启动被拒] {msg}")
        return "FAIL", f"启动失败: {msg}", None

    execute_id = res_json.get("execute_id")
    logger.info(f"✅ [启动成功] ExecuteID: {execute_id}")
    return await poll_coze_result(execute_id, user_id)

async def resume_workflow(user_id, session_data):
    """
    恢复工作流
    """
    logger.info(f"⏯️ [恢复] User: {user_id} | EventID: {session_data['event_id']}")
    
    res = await _coze_request("POST", "workflows/resume", {
        "workflow_id": config.COZE_WORKFLOW_ID,
        "event_id": session_data["event_id"],
        "interrupt_type": session_data["interrupt_type"],
        "resume_data": json.dumps({})
    })

    if not res:
        return "FAIL", "网络请求异常", None
        
    if res.status != 200:
        text = await res.text()
        logger.error(f"❌ [恢复失败] {text}")
        return "FAIL", f"恢复失败: {text}", None

    logger.info("✅ [恢复提交] 进入轮询...")
    return await poll_coze_result(session_data["execute_id"], user_id)
