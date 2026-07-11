# Context Assembly

状态：Current

每个 turn 固定 provider snapshot 与动态 skill prompt。每个 step 重新取得当前 `ToolExposureState.schemas()`，所以 tool_search、skill activation、connector 或 MCP 状态只在约定的下一边界生效。

`ContextPipeline.prepare()` replay canonical history，加入当前输入，裁剪 tool result，老化已处理图片，估算 system/messages/tools/image token，并在 90% soft threshold 前执行安全压缩。调用 provider 前始终校验 tool-use closure。
