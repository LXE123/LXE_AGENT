# TypeScript Runtime

状态：Current

Runtime 位于 [`packages/runtime/src`](/packages/runtime/src)，并由 Gateway 在同一 Bun 进程内直接调用。

- [Runtime Flow](runtime_flow.md)
- [Turn Execution](turn_execution.md)
- [Turn Step Lifecycle](turn_step_lifecycle.md)
- [Context](context/README.md)
- [Tools](tools/README.md)

生产 Runtime 没有 Python fallback。Python 仅存在于版本化 script tool bridge 后方，并且每次调用结束即退出。
