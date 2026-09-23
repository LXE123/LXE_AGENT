# 智汇 TMS 长期 Contract 收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将智汇 TMS 的公开执行输入收敛为唯一的菲律宾商品全量导出 Contract，并使 preview、人工确认、完整成功、部分成功与最终文件交付都有不依赖模型猜测的 terminal 语义。

**Architecture:** 智汇两个公开 catalog command 共用三个 const 参数和同一个 Python normalizer。业务 adapter 用可选 `terminal_projection` 把内部 workflow payload 投影成最小 terminal data；通用 Python CLI 只在业务主动提供且结构合法时做这项投影，文件仍严格由 catalog artifact declaration 收集，未启用投影的业务保持原终态行为。

**Tech Stack:** Python 3.12/pytest/uv、Bun/TypeScript catalog reader、JSON Schema、Markdown Skill contracts。

**Spec:** `docs/superpowers/specs/2026-09-22-zhihui-tms-long-term-contract-convergence-design.md`

## Global Constraints

- 只修改智汇 Skill、catalog、Python normalizer/planner/adapter、Python CLI 的 opt-in projection 和对应测试；不修改 Bun Agent Runtime 主链、雅仓、智慧印尼或马帮业务实现。
- 智汇公开执行 schema 必须严格为 `platform=zhihui_tms`、`warehouse=PH`、`intent=product_export`，required 且 `additionalProperties=false`；`fields` 不得保留为执行或兼容参数。
- preview 必须无网络、无登录态、无文件，并终态表达 `confirmation_required=true` 与空 files。
- execute 的生产安全、会话复用、401 单次恢复、403/429/第二次 401 停止、账号锁、脱敏和 artifact 校验保持不变。
- 顶层 files 是完整成功的唯一交付真源；部分成功为 `ok=false`、`partial=true` 且仅交付已校验部分文件。
- 不访问生产环境，不自行 `git add`、commit 或 push；保留工作区既有无关改动。

---

### Task 1: 先固定通用终态摘要投影的向后兼容边界

**Files:**
- Modify: `python/lxeskill_cli/tests/lxeskill/test_python_tool_boundaries.py`
- Modify: `python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py`
- Modify: `python/lxeskill_cli/lxeskill/business.py`

**Interfaces:**
- Consumes: 现有业务 payload 的 `success`、可选 `artifacts`、`exception` 与 catalog artifact declarations。
- Produces: 可选内部 envelope `terminal_projection={"data": dict, "error": {"code": str, "message": str}?}`；`execute_module_json()` 的 `content` 在 opt-in 时序列化 `terminal_projection.data`，否则保留原 payload；其 `error` 在 opt-in 失败时使用 projection error，否则保留 `business_cli_failed`。

- [ ] **Step 1: 写出 projection 的失败测试**

在 `test_python_tool_boundaries.py` 追加三组精确断言：

```python
def test_business_adapter_projects_only_an_explicit_terminal_projection(monkeypatch):
    module = ModuleType("tests.projected_success")
    module.run = lambda _arguments: {
        "success": True,
        "artifacts": [{"path": "/safe/final.xlsx"}],
        "terminal_projection": {"data": {"platform": "zhihui_tms", "row_count": 2}},
    }
    monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setattr("lxeskill.business.collect_declared_artifacts", lambda *_args: ["/safe/final.xlsx"])
    ok, content, files, error = execute_module_json({"module": module.__name__}, {}, {"session_id": "s"})
    assert (ok, json.loads(content[0]["text"]), files, error) == (True, {"platform": "zhihui_tms", "row_count": 2}, ["/safe/final.xlsx"], None)

def test_business_adapter_projects_an_explicit_partial_error(monkeypatch):
    module = ModuleType("tests.projected_partial")
    module.run = lambda _arguments: {
        "success": False,
        "exception": "download failed",
        "terminal_projection": {
            "data": {"platform": "zhihui_tms", "partial": True},
            "error": {"code": "tms_export_partial", "message": "download failed"},
        },
    }
    monkeypatch.setitem(sys.modules, module.__name__, module)
    ok, content, files, error = execute_module_json({"module": module.__name__}, {}, {"session_id": "s"})
    assert (ok, json.loads(content[0]["text"]), files, error) == (False, {"platform": "zhihui_tms", "partial": True}, [], {"code": "tms_export_partial", "message": "download failed"})

@pytest.mark.parametrize("platform", ["yacang", "shangman", "mabang"])
def test_business_adapter_keeps_unprojected_legacy_payloads_unchanged(platform, monkeypatch):
    module = ModuleType(f"tests.legacy_{platform}")
    payload = {"success": False, "platform": platform, "exception": f"{platform} failed"}
    module.run = lambda _arguments: payload
    monkeypatch.setitem(sys.modules, module.__name__, module)
    ok, content, files, error = execute_module_json({"module": module.__name__}, {}, {"session_id": "s"})
    assert (ok, json.loads(content[0]["text"]), files, error) == (False, payload, [], {"code": "business_cli_failed", "message": f"{platform} failed"})
```

在 `test_lxeskill_cli.py` 添加一条通过 `_run_entry` 的 terminal 测试，断言 projected partial payload 输出 `ok=false`、最小 `data`、指定业务 error code 和保留的部分 `files`。

- [ ] **Step 2: 运行测试确认当前实现失败**

Run: `uv run pytest python/lxeskill_cli/tests/lxeskill/test_python_tool_boundaries.py python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py -q`

Expected: 新增 projection 测试失败，因为当前 `_finalize_payload()` 总是序列化完整 payload 且把失败码固定为 `business_cli_failed`。

- [ ] **Step 3: 以 opt-in 方式实现结构投影**

在 `lxeskill/business.py` 增加私有结构解析 helper：

```python
def _terminal_projection(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str] | None] | None:
    raw = payload.get("terminal_projection")
    if not isinstance(raw, dict) or not isinstance(raw.get("data"), dict):
        return None
    error = raw.get("error")
    if error is not None and (
        not isinstance(error, dict)
        or not isinstance(error.get("code"), str) or not error["code"].strip()
        or not isinstance(error.get("message"), str) or not error["message"].strip()
    ):
        return None
    return dict(raw["data"]), ({"code": error["code"].strip(), "message": error["message"].strip()} if error else None)
```

在 `_finalize_payload()` 中：先照旧判断 success 和调用 `collect_declared_artifacts(entry, payload)`；只有 helper 返回值非空时才将 `content` 序列化为投影 data。失败时只有 projection 已提供完整 error 才使用该 error；没有 projection 或没有完整 projection error 时，沿用当前 message 优先级和 `business_cli_failed`。不依据平台名、artifact 数量、`partial` 或异常类型作任何分支。

- [ ] **Step 4: 运行通用投影与旧行为回归测试**

Run: `uv run pytest python/lxeskill_cli/tests/lxeskill/test_python_tool_boundaries.py python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py -q`

Expected: PASS；雅仓、智慧印尼/尚满、马帮标记的未投影 payload 仍逐字保留原 data 和 `business_cli_failed` 语义。

### Task 2: 收敛智汇 catalog、normalizer 和 Skill 的唯一输入

**Files:**
- Modify: `python/lxeskill_cli/lxeskill/catalog.json`
- Modify: `python/lxeskill_cli/services/zhihui_tms/intent.py`
- Modify: `python/lxeskill_cli/services/zhihui_tms/planner.py`
- Modify: `skills/zhihui-tms-product-export/SKILL.md`
- Modify: `python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`
- Modify: `python/lxeskill_cli/tests/zhihui_tms/test_acceptance.py`
- Modify: `packages/agent/runtime/test/tooling/lxeskill-command.test.ts`

**Interfaces:**
- Consumes: `{"platform": "zhihui_tms", "warehouse": "PH", "intent": "product_export"}`.
- Produces: `ZhihuiTmsProductExportIntent` 不再含 `fields`；`plan_product_export(arguments, action)` 只将这三个值归一为同一个商品全量导出计划。

- [ ] **Step 1: 先将智汇输入测试改为三字段 Contract**

将 `ARGUMENTS` / CLI argv fixture 改为：

```python
ARGUMENTS = {"platform": "zhihui_tms", "warehouse": "PH", "intent": "product_export"}
```

测试 normalizer 接受该对象并拒绝 `fields`、未知字段、错误平台/仓库/intent；测试 preview 与 execute catalog entry 的 `properties`、`required` 和 `additionalProperties` 完全相同。Bun catalog test 断言两个智汇 command 的 schema 不含 `fields`，仍保留 execute confirmation。

对 Skill 增加静态 Contract 断言：包含“当前版本只支持菲律宾”“固定归一为 PH，不追问国家”“菲律宾库存”平台歧义规则；不包含 `--fields`、字段白名单或 `data.artifacts` 作为完成依据。

- [ ] **Step 2: 运行测试确认当前 Contract 不符合要求**

Run: `uv run pytest python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py python/lxeskill_cli/tests/zhihui_tms/test_acceptance.py -q && bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`

Expected: FAIL，因为当前 schema、normalizer、CLI fixture 和 Skill 都仍要求或描述 `fields`。

- [ ] **Step 3: 删除 fields 并保持 preview/execute 参数同一性**

在两个 catalog entry 的 `input_schema` 中删除 `fields` property 与 required 项，保留三个 const property 和 `additionalProperties:false`。在 `intent.py` 删除 `_FIELDS`、dataclass `fields` 与相关校验，将 unknown key 限为三个 canonical key。`planner.py` 不引入替代字段。

更新 Skill：明确智汇/TMS 未指定国家固定 PH；“菲律宾库存”仍澄清平台；自然语言商品指标全部归一为唯一 canonical intent；示例命令只带三参数；删除 fields 白名单；声明 preview→确认→execute 和成功 `files` 的结束条件，不再以 `data.artifacts` 指导模型。

- [ ] **Step 4: 运行结构 Contract 双端验证**

Run: `uv run pytest python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py python/lxeskill_cli/tests/zhihui_tms/test_acceptance.py python/lxeskill_cli/tests/lxeskill/test_command_contracts.py python/lxeskill_cli/tests/lxeskill/test_lxeskill_contract.py -q && bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`

Expected: PASS；智汇公开 command 与 Skill manifest 匹配，且运行时读取 catalog 不要求 `fields`。

### Task 3: 在智汇 adapter 输出明确 preview、成功、部分成功和失败终态

**Files:**
- Modify: `python/lxeskill_cli/services/agent_cli/zhihui/export_products.py`
- Modify: `python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`
- Modify: `python/lxeskill_cli/tests/zhihui_tms/test_acceptance.py`

**Interfaces:**
- Consumes: 固定三字段 input 和原有 `ZhihuiTmsExportResult` / delivery artifacts / 既有异常的 `partial_artifacts`、`partial_pages`、`partial_rows`。
- Produces: 内部 payload 继续保留 `artifacts` 供 catalog 校验，但添加 `terminal_projection`：preview data 含 `confirmation_required:true`；完整成功 data 含 row_count；部分失败 data 含 `partial:true` 和部分计数，error 使用 `tms_export_partial` + 实际脱敏异常文本；非部分失败 data 含 `partial:false` 且不伪造部分文件。

- [ ] **Step 1: 写出终态 Contract 的失败测试**

在 `test_cli_entry.py` 断言 preview module result 的 projection data 为：

```python
{"platform": "zhihui_tms", "country": "PH", "business_type": "product_export", "confirmation_required": True}
```

并断言原始内部 payload 不把 action、限制参数或 artifacts 放进 projected terminal data。

在 `test_acceptance.py` 的成功 fixture 断言 terminal 具有 `ok is True`、`files` 恰为一个可打开的合并 XLSX，且 `data` 恰为平台、国家、业务类型、row_count 的摘要，不含 `artifacts`。

新增一个 delivery 抛出带 `partial_artifacts` / `partial_pages` / `partial_rows` 的真实业务异常的 fixture：断言 outer result `ok is False`、`data.partial is True`、`files` 为已验证部分合并文件、`error.code == "tms_export_partial"`，且不称完整成功。

- [ ] **Step 2: 运行测试确认现有 payload 泄露内部细节**

Run: `uv run pytest python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py python/lxeskill_cli/tests/zhihui_tms/test_acceptance.py -q`

Expected: FAIL，因为 preview 当前只返回 plan summary，成功 terminal data 仍含 artifacts/限制参数，部分成功没有结构化 partial 标记。

- [ ] **Step 3: 只在 adapter 中构造业务事实**

在 `export_products.py` 添加私有 builder（不修改 HTTP/workflow）：

```python
def _terminal_data(
    *, confirmation_required: bool = False, row_count: int | None = None,
    partial: bool | None = None, partial_pages: int | None = None,
    partial_rows: int | None = None,
) -> dict[str, Any]:
    data = {"platform": "zhihui_tms", "country": "PH", "business_type": "product_export"}
    if confirmation_required:
        data["confirmation_required"] = True
    if row_count is not None:
        data["row_count"] = row_count
    if partial is not None:
        data["partial"] = partial
    if partial_pages is not None:
        data["partial_pages"] = partial_pages
    if partial_rows is not None:
        data["partial_rows"] = partial_rows
    return data
```

preview 返回 `success=True`、供 catalog 收集的空 `artifacts` 和 `terminal_projection.data`。完整成功保留内部 artifacts 仅供 `files`，projection 只含最小业务摘要和 `row_count=delivery.total_rows`。异常处理计算 `has_partial = bool(artifacts)`；有部分 artifact 时设置 `partial:true` 和 `terminal_projection.error={"code":"tms_export_partial","message":redacted_actual_exception}`；没有部分 artifact 时设置 `partial:false`，保留原业务 code/message 路径。任何 token/account/password 都不得进入 projection。

- [ ] **Step 4: 运行智汇离线 fixture 验证**

Run: `uv run pytest python/lxeskill_cli/tests/zhihui_tms -q`

Expected: PASS；覆盖 preview 无网络、成功合并、部分合并、认证缓存和 401/403/429 边界，且不访问生产环境。

### Task 4: 端到端 Contract 回归与范围审计

**Files:**
- Modify: `docs/superpowers/handoffs/2026-09-21-business-contract-convergence.md`
- Modify: `docs/superpowers/plans/2026-09-22-zhihui-tms-long-term-contract-convergence.md`（勾选完成项并记录实际验证命令）

**Interfaces:**
- Consumes: Tasks 1–3 的终态 Contract、现有其他平台 fixture suites。
- Produces: 可交接的未提交实现说明：三字段 canonical Contract、projection opt-in 边界、验证结果、无其他平台业务变更证明。

- [ ] **Step 1: 运行定向 Python 与 Bun 回归**

Run: `uv run pytest python/lxeskill_cli/tests/zhihui_tms python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/yacang/test_export_intent.py python/lxeskill_cli/tests/yacang/test_export_workflow.py python/lxeskill_cli/tests/mabang/test_brazil_overseas_export_cli.py -q && bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`

Expected: PASS；其他平台代表性测试未因未启用 projection 的通用层改动而改变终态行为。

- [ ] **Step 2: 执行静态与安全检查**

Run: `bun run typecheck && git diff --check && rg -n --hidden --glob '!**/.git/**' 'ZHIHUI_TMS_(ACCOUNT|PASSWORD)|LXE_ZHIHUI_TMS_SESSION_HOST_TOKEN' apps/desktop python/lxeskill_cli skills docs/superpowers`

Expected: typecheck 成功；diff 无空白错误；扫描只允许环境变量标识和测试 fixture，不出现真实凭据。

- [ ] **Step 3: 更新交接文档与计划状态**

在 handoff 中记录：文件列表、三字段 Contract、preview/complete/partial terminal 数据语义、projection opt-in 兼容性、测试结果、未访问生产环境和未提交状态。勾选本计划所有已完成 task；不执行任何 git 状态修改命令。

- [ ] **Step 4: 生成只读交付报告**

Run: `git diff --stat && git status --short`

Expected: 报告只列本次涉及文件与已存在的无关工作区改动；明确没有雅仓、智慧印尼、马帮业务代码或 Bun Runtime 主链修改，也没有 commit/push。

## Execution Record

- [x] Task 1：完成 opt-in `terminal_projection`、legacy payload 保持原 data/error 的回归测试与 CLI outer-terminal 测试。
- [x] Task 2：完成三字段 schema/normalizer/Skill 收敛，并验证 preview/execute schema 完全一致。
- [x] Task 3：完成 preview 等待确认、完整成功最小摘要、部分成功结构化终态与 fixture 验证。
- [x] Task 4：完成智汇、通用 CLI、雅仓、智慧印尼/尚满、马帮离线回归与交接记录；最终静态检查和只读报告在交付前执行。
