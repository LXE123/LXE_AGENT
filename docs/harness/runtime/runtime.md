在敲定 `runtime` 的具体结构之前，我必须给 `runtime` 下一个定义。

## 核心定义

> **runtime 就是 agent loop 的控制参数。**

---

## 定位与职责

首先，runtime 在 agent loop 中可以看做是**控制面板上的具体参数**，它只记录协调 `会话/turn` 的执行、取消、恢复所必需的少量控制状态。

| 特性 | 说明 |
|-----|------|
| 属性数量 | 较少 |
| 核心要求 | **安全性、一致性、可靠性** |

每一个 session 都会有着一个**独立的 runtime**。

---

## 首批 Runtime 字段

```json
{
  "active_turn_id": "",
  "active_turn_started_at": 0,
  "stop_turn_id": "",
  "stop_requested_at": 0,
  "session_activity_at": 0, 
  "clear_pending": false,
  "clear_requested_at": 0
}
```

---

## 分离出的属性去处（20260413）

以下是从 runtime 中分离出来的属性去处：

### 1. `pending_events` 队列

用来存储 session 的后台任务完成事件；每个 session 最多 10 个（满了不再 [-N:] 静默截断，而是 fail loud：append 失败并明确打 ERROR。）。
- 只有“后台任务已经结束，并且这个结果需要 agent 在之后某一轮看到/处理”时，才进入 pending_events。
- pending_events 只会存放已完成的后台任务

```json
agent_sessions.pending_events = [
    {
    "event_id": "evt_xxx",
    "job_id": "exec_xxx",
    "created_at": 1776048466,
    "text": "后台任务已完成：xxx"
    }
]
```

- 字段解释：
job_id: 目前等于 ExecSession.id。
created_at: 使用 Unix 秒级时间戳，和当前代码 int(time.time()) 保持一致。
text: 由后台任务完成时生成，是给 agent 读取的完成摘要。

---

### 2. `browser_state` (因为只能启动一个紫鸟浏览器，所以可以看成全局状态)
| 模块 | 存储内容 |
|-----|---------|
| `ziniao_browser` | 业务/浏览器会话状态，比如当前店铺、当前页面、下载路径、店铺入口页 |

- ziniao_browser 的字段：
```json
{
  "browser_state": {
    "ziniao_browser": {
      "store_connection": {
        "store_ref": "",
        "store_name": "",
        "debugging_port": 0,
        "browser_path": "",
        "launcher_page": "",
        "download_path": "",
        "current_url": ""
      }
    }
  }
}
```


---

## 拆分后的整体结构

```jsonc
{
    "runtime": {...},          // agent loop 控制面
    "pending_events": [...],     // agent inbox
    "browser_state": {...}     // 紫鸟/浏览器业务会话状态
}
```

存在 SQLite 的 `agent_sessions` / `agent_contexts` 中
```python
# SQLite TEXT columns storing JSON.
agent_sessions.state_data       # JSON object: runtime 控制态
agent_sessions.pending_events   # JSON list: 事件队列（异步、一次性消费）
agent_contexts.context_data     # JSON object: messages 等持久上下文
```

---

runtime API
panding_events API


---

resident:

session_id                  # PK，当前 resident 仍按 session 启动
browser_slot                # unique nullable
control_port                # unique nullable，紫鸟 client 控制端口
service_pid                 # resident 进程 pid
service_port                # resident socket port
ziniao_client_path
ziniao_client_pid
core_updated
resident_code_signature
started_at
heartbeat_at
updated_at
