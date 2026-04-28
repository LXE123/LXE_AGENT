# 钉钉卡片文档

当前 agent 仓库只保留通用钉钉卡片协议和发送能力，不再维护单次业务 Workflow 的卡片路由。

## 通用卡片

- `shared.dingtalk.card.general_card.build_general_card_params(...)`
- `shared.dingtalk.card.runtime.card_builder.CardBuilder`
- `shared.platform.outbound_queue.enqueue_card_message(...)`
- `shared.platform.outbound_queue.enqueue_card_file(...)`

## 边界

- 卡片层只负责协议封装、发送、回调基础能力。
- agent 会话状态在 `agent_sessions`、`agent_contexts`。
- 单次业务流程的卡片和回调语义由独立 workflow 仓库维护。
