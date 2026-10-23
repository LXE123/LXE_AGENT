# 模型目录与选择

模型目录描述“有哪些模型、通过什么协议调用、支持哪些能力”，凭据单独管理。Runtime 根据所选目录和凭据创建 Provider；它不把一份模型 ID 清单写死在执行循环里。

## 本地与公司模型

| 来源 | 定义在哪里 | 如何使用 |
| --- | --- | --- |
| 本地模型 | [`config/llm/providers/`](../../../config/llm/providers) | 个人凭据配合本地定义；独立 CLI 也使用本地目录 |
| 公司模型 | 经客户端校验的云端模型描述 | Desktop 同步定义与对应凭据，再将结构化状态传给 Gateway 和 agentcli |

两类来源分别解析。公司模型不可用时返回配置或授权错误，不自动换用个人 Key 或本地默认模型。设备同步、加密缓存、下架与断网处理统一见 [云端接入手册](../../desktop/cloud-access.md)。

## 定义与校验

模型定义包含供应商和模型标识、展示名称、协议与地址、上下文窗口、输出上限、图片输入能力、thinking／effort 选项及协议兼容参数。目录中的认证环境变量名用于识别凭据配置，不包含实际 Key。

本地解析由 [`llm-provider-catalog.ts`](../../../packages/foundation/core/src/llm-provider-catalog.ts) 负责。公司模型 v3 使用 [`managed-model-definition.ts`](../../../packages/foundation/core/src/managed-model-definition.ts) 的严格契约：

- 模型 ID 可以尚未出现在本地目录中；供应商、协议和地址仍限于客户端已经支持的路线。
- 字段、数值范围、输入类型与推理参数必须通过校验，不能下发脚本或任意请求字段。
- `compat` 的缺省值是本项目行为，不自动跟随外部实现；原始参考保留在 [`pi-compat-reference.txt`](pi-compat-reference.txt)。

Desktop 优先使用 v3，兼容 v2 和旧格式。定义版本与凭据版本分开处理，修改模型参数不等于重新领取 Key。管理员只改默认项时，客户端保留仍有效的用户选择；同步细节由云端接入手册维护。

## 选择与生效

每个会话保存自己的 provider、model、凭据来源和推理选项；全局偏好用于新会话。持久化顺序、并发版本与重启恢复见 [会话模型与 effort](../runtime/session-models.md)。

一轮开始时取得模型配置快照，普通请求、重试与摘要使用同一轮的 Provider。凭据由该 Provider 首次使用时解析并复用；公司状态随快照固定，本地 Key 在首次解析时从认证配置读取。更新配置供后续 turn 使用，不切换正在流式输出的请求。

[`provider.ts`](../../../packages/agent/runtime/src/providers/provider.ts) 校验目标并组装 descriptor，随后由 [LLM 适配层](README.md) 选择协议实现。上下文窗口和输出上限来自当前 descriptor；它们与 Provider 的连接／流事件空闲超时是不同参数。

认证配置不进入模型上下文。定义文件不保存 Key，`model_selection` 和 `turn_context` 也不保存 Key；桌面与独立 CLI 的配置入口分别见 [Desktop](../../desktop/README.md#桌面配置与安全) 和 [CLI exec](../runtime/agent_cli_exec.md)。

## 修改与发布

新增本地模型时更新对应定义；若只是已支持协议下的能力参数变化，不必在 turn 循环增加供应商分支。新协议或新请求行为应进入适配层，并验证受影响的消息、工具、图片或推理请求。

公司模型按“兼容的云端接口 → 支持该契约的客户端 → 发布新目标／参数”的顺序上线；客户端契约之外的新供应商或协议仍需要代码支持。真实供应商调用属于独立验证，不能从目录解析或本地模拟测试通过推断线上可用。

核对入口：[`目录测试`](../../../packages/foundation/core/test/llm-provider-catalog.test.ts)、[`Provider 测试`](../../../packages/agent/runtime/test/providers/provider.test.ts)及对应协议测试；按实际改动范围选择验证。审查流程统一见 [PR 审查规范](../../pr-review.md)。
