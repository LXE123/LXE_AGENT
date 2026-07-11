# Runtime Logging and Trace

状态：Current

[`packages/core/src/logging.ts`](/packages/core/src/logging.ts) 提供进程级动态 sink。`LOCAL_LOGS_ENABLED=1` 且 `LOG_FILE` 非空时，Bun JSONL 追加到 `logs/runtime/YYYYMMDD/<LOG_FILE>`；终端级别使用 `LOG_LEVEL`，文件级别使用 `RUNTIME_LOG_LEVEL`，`LOG_LEVELS` 按最长 logger prefix 覆盖。

Gateway 在生产组件创建前配置日志。shutdown、fatal、unhandled rejection 和 uncaught exception 都先记录并 flush。日期目录按 `LOCAL_LOG_RETENTION_DAYS` 清理。

[`packages/runtime/src/trace.ts`](/packages/runtime/src/trace.ts) 支持 `AGENT_STREAM_*` 与 `AGENT_SSE_WIRE_TRACE_*`，目录层级为日期/session/turn/step/attempt。日志与 trace 都会脱敏 token、authorization、cookie、绝对路径、base64 和 redacted thinking data。

核心事件包括 turn start/end、provider attempt/retry、tool start/end、skill activation、cancel 和 context checkpoint。一次性业务工具可以向同一 runtime log 的 stderr 链路记录文本，但 stdout 只用于协议 JSON。
