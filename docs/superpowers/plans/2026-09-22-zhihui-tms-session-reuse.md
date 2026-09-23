# 智汇 TMS 登录态复用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让智汇 TMS 商品导出跨 Desktop 重启复用有效登录态，并在明确的 401 失效时仅受控重登一次。

**Architecture:** Desktop 主进程拥有加密的智汇会话记录和一个仅限回环、能力凭证保护的会话宿主；Python 导出端通过窄 `ZhihuiTmsSessionProvider` 接口读写它。`ZhihuiTmsClient` 保持平台请求职责，只接受初始 token 和一次性 401 恢复回调，因此分页、导出和投递逻辑无需知道缓存位置。

**Tech Stack:** Electron `safeStorage`、Node `http`/`crypto`、TypeScript、Python `requests`、pytest、Bun test。

**Spec:** `docs/superpowers/specs/2026-09-22-zhihui-tms-session-reuse-design.md`

## Global Constraints

- 仅缓存智汇 TMS `apiToken`，且只能存入 Electron `safeStorage` 加密的 `secrets.bin`；不得写入普通文件、日志、stdout、聊天结果或 Git。
- Desktop 重启后可复用；直接 Python CLI 且缺少 Desktop 宿主时维持现有无状态登录兼容行为。
- 账号/密码变更、清空配置、禁用生产调用均在同一加密事务中清除会话。
- 仅 HTTP 401 可清除缓存、重新登录并重放一次被拒绝的请求；403、429、网络、结构和未知业务错误立即停止且不重登。
- 维持现有账户级进程锁、限速、有限重试、确认与导出投递语义。
- 所有 Git 状态修改命令须在执行时先取得用户授权；本计划中的提交命令仅作为待授权步骤。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `apps/desktop/src/main/config-store/model.ts` | 声明、解析和验证加密的智汇会话记录。 |
| `apps/desktop/src/main/config-store/setup.ts` | 原子地失效会话，并提供会话读写方法。 |
| `apps/desktop/src/main/config-store/store.ts` | 向主进程宿主暴露窄会话存储 API。 |
| `apps/desktop/src/main/zhihui-tms-session-host.ts` | 实现回环、能力凭证保护的固定读/写/清除协议。 |
| `apps/desktop/src/main.ts`、`desktop-gateway.ts` | 管理宿主生命周期，并只向 Agent 子进程注入宿主环境变量。 |
| `python/lxeskill_cli/services/zhihui_tms/session.py` | Python 到 Desktop 宿主的受控会话 provider 与无宿主降级。 |
| `python/lxeskill_cli/services/zhihui_tms/client.py` | 初始 token 与单次 401 恢复边界。 |
| `python/lxeskill_cli/services/agent_cli/zhihui/export_products.py` | 在现有账户锁内组合 provider、登录、保存、401 恢复和导出。 |

### Task 1: 加密会话记录与配置失效

**Files:**

- Modify: `apps/desktop/src/main/config-store/model.ts`
- Modify: `apps/desktop/src/main/config-store/setup.ts`
- Modify: `apps/desktop/src/main/config-store/store.ts`
- Test: `apps/desktop/test/config-store.test.ts`

**Interfaces:**

- Produces: `DesktopConfigStore.readZhihuiTmsSession(accountFingerprint: string): string | null`
- Produces: `DesktopConfigStore.saveZhihuiTmsSession(accountFingerprint: string, apiToken: string): void`
- Produces: `DesktopConfigStore.clearZhihuiTmsSession(accountFingerprint?: string): void`
- Produces: encrypted `DesktopSecrets.zhihui_tms_session: { account_fingerprint: string; api_token: string; saved_at: number } | null`

- [ ] **Step 1: Write the failing config-store test**

```ts
test("persists only a matching encrypted Zhihui session and clears it after a password update", () => {
  store.saveZhihuiTmsSession(fingerprint, "fixture-api-token");
  expect(restarted.readZhihuiTmsSession(fingerprint)).toBe("fixture-api-token");
  expect(readFileSync(join(root, "config", "settings.json"), "utf8")).not.toContain("fixture-api-token");

  store.save({ workspace_root, zhihui_tms: {
    action: "save", account: "fixture", password: "new-secret", production_enabled: true,
  } });
  expect(store.readZhihuiTmsSession(fingerprint)).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify the missing interface**

Run: `bun test apps/desktop/test/config-store.test.ts`

Expected: FAIL because `saveZhihuiTmsSession` and `readZhihuiTmsSession` do not yet exist.

- [ ] **Step 3: Implement the encrypted record and narrow store API**

```ts
export interface ZhihuiTmsSessionRecord {
  account_fingerprint: string;
  api_token: string;
  saved_at: number;
}

readZhihuiTmsSession(accountFingerprint: string): string | null {
  const record = this.repository.readSecrets().zhihui_tms_session;
  return record?.account_fingerprint === accountFingerprint ? record.api_token : null;
}
```

Add strict `parseSecrets` validation: lowercase 64-hex account fingerprint, nonempty bounded token, and positive safe-integer `saved_at`. Invalid stored content becomes `null`. In `DesktopSetupService.save`, clear the session in the same `repository.commit(config, secrets)` transaction when the input clears Zhihui, changes account, supplies a new password, or disables production. Preserve it when only unrelated settings change.

- [ ] **Step 4: Run the focused Desktop test**

Run: `bun test apps/desktop/test/config-store.test.ts`

Expected: PASS; the encrypted store survives reconstruction, public state/settings omit the token, and all credential-change cases clear it.

- [ ] **Step 5: Inspect this task and propose the authorized commit**

Run: `git diff --check -- apps/desktop/src/main/config-store/model.ts apps/desktop/src/main/config-store/setup.ts apps/desktop/src/main/config-store/store.ts apps/desktop/test/config-store.test.ts`

Expected: no output.

On explicit Git approval:

```bash
git add apps/desktop/src/main/config-store/model.ts apps/desktop/src/main/config-store/setup.ts apps/desktop/src/main/config-store/store.ts apps/desktop/test/config-store.test.ts
git commit -m "feat: persist encrypted Zhihui TMS sessions"
```

### Task 2: Desktop 回环会话宿主与生命周期

**Files:**

- Create: `apps/desktop/src/main/zhihui-tms-session-host.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/main/desktop-gateway.ts`
- Test: `apps/desktop/test/zhihui-tms-session-host.test.ts`

**Interfaces:**

- Consumes: Task 1's `DesktopConfigStore` session methods.
- Produces: `ZhihuiTmsSessionHost.start()`, `stop()`, and `environment()`.
- Produces: `LXE_ZHIHUI_TMS_SESSION_HOST_URL` and `LXE_ZHIHUI_TMS_SESSION_HOST_TOKEN` only in the Gateway child environment.

- [ ] **Step 1: Write the failing host security test**

```ts
test("rejects unauthenticated and browser-originated requests before reading storage", async () => {
  const { host, request, store } = await fixture();
  expect((await request({ authorization: "Bearer wrong", operation: "read" })).status).toBe(403);
  expect((await request({ origin: "https://untrusted.example", operation: "read" })).status).toBe(403);
  expect(store.reads).toBe(0);
  await host.stop();
  expect(() => host.environment()).toThrow("not running");
});
```

Add tests for successful `read`, `write`, and `clear` with a valid fingerprint; invalid method/path/body/fingerprint; maximum body size; and errors that do not echo `fixture-api-token`.

- [ ] **Step 2: Run the new test to verify the module is absent**

Run: `bun test apps/desktop/test/zhihui-tms-session-host.test.ts`

Expected: FAIL because `zhihui-tms-session-host.ts` does not exist.

- [ ] **Step 3: Implement the fixed local protocol and lifecycle wiring**

```ts
export interface ZhihuiTmsSessionStore {
  read(accountFingerprint: string): string | null;
  save(accountFingerprint: string, apiToken: string): void;
  clear(accountFingerprint: string): void;
}

export class ZhihuiTmsSessionHost {
  environment(): Record<string, string> {
    return {
      LXE_ZHIHUI_TMS_SESSION_HOST_URL: this.endpoint,
      LXE_ZHIHUI_TMS_SESSION_HOST_TOKEN: this.capability,
    };
  }
}
```

Bind `createServer` to `127.0.0.1` on port `0`. Accept only `POST /v1/zhihui-tms-session` with a 16 KiB JSON body, a constant-time `Authorization: Bearer` capability comparison, no `Origin`, and exact lower-case 64-hex `account_fingerprint`. Accept only `read`, `write`, and `clear`; include `Cache-Control: no-store` on every reply; never interpolate a token into an error.

In `main.ts`, start the host before `DesktopGateway.start()`, provide it through a new `zhihuiTmsSessionEnvironment` gateway option, and stop it after the gateway during shutdown. Do not add the variables to public IPC, config state, logger fields, or renderer environment.

- [ ] **Step 4: Run host tests and Desktop typecheck**

Run: `bun test apps/desktop/test/zhihui-tms-session-host.test.ts && bun run --cwd apps/desktop typecheck`

Expected: PASS; invalid callers cannot access the session and the Desktop compiles.

- [ ] **Step 5: Inspect this task and propose the authorized commit**

Run: `git diff --check -- apps/desktop/src/main/zhihui-tms-session-host.ts apps/desktop/src/main.ts apps/desktop/src/main/desktop-gateway.ts apps/desktop/test/zhihui-tms-session-host.test.ts`

Expected: no output.

On explicit Git approval:

```bash
git add apps/desktop/src/main/zhihui-tms-session-host.ts apps/desktop/src/main.ts apps/desktop/src/main/desktop-gateway.ts apps/desktop/test/zhihui-tms-session-host.test.ts
git commit -m "feat: host Zhihui TMS sessions in desktop"
```

### Task 3: Python 会话 provider 与安全降级

**Files:**

- Create: `python/lxeskill_cli/services/zhihui_tms/session.py`
- Modify: `python/lxeskill_cli/services/zhihui_tms/__init__.py`
- Test: `python/lxeskill_cli/tests/zhihui_tms/test_session.py`

**Interfaces:**

- Consumes: Task 2's two environment variables and `/v1/zhihui-tms-session` protocol.
- Produces: `ZhihuiTmsSessionProvider.from_environment()`.
- Produces: `read(account: str) -> str | None`, `write(account: str, api_token: str) -> None`, and `clear(account: str) -> None`.

- [ ] **Step 1: Write the failing provider tests**

```python
def test_provider_uses_loopback_capability_and_never_logs_token(monkeypatch):
    provider = ZhihuiTmsSessionProvider.from_environment(env)
    assert provider.read("fixture-account") == "fixture-token"
    assert captured_headers["Authorization"] == "Bearer fixture-capability"
    assert captured_body["account_fingerprint"] == sha256(b"fixture-account").hexdigest()

def test_missing_or_unreachable_host_degrades_to_empty_session():
    provider = ZhihuiTmsSessionProvider.from_environment({})
    assert provider.read("fixture-account") is None
    provider.write("fixture-account", "fixture-token")
```

- [ ] **Step 2: Run the test to verify the provider is absent**

Run: `uv run pytest -q python/lxeskill_cli/tests/zhihui_tms/test_session.py`

Expected: FAIL because `services.zhihui_tms.session` has not been created.

- [ ] **Step 3: Implement the controlled HTTP provider**

```python
class ZhihuiTmsSessionProvider:
    @classmethod
    def from_environment(
        cls, environment: Mapping[str, str] | None = None,
    ) -> "ZhihuiTmsSessionProvider": ...

    def read(self, account: str) -> str | None: ...
    def write(self, account: str, api_token: str) -> None: ...
    def clear(self, account: str) -> None: ...
```

Validate an exact `http://127.0.0.1:<port>` endpoint and a nonempty capability. Use a short explicit timeout, `allow_redirects=False`, only the fixed authorization header plus JSON body, and the fixed `{ ok: true, result }` response. Hash `account.strip().casefold()` locally. Missing environment, unreachable host, malformed host response, and host failure must safely yield a cache miss/no-op rather than block a valid export; no path may emit token text.

- [ ] **Step 4: Run provider tests**

Run: `uv run pytest -q python/lxeskill_cli/tests/zhihui_tms/test_session.py`

Expected: PASS; only a loopback host is contacted and every downgrade path is token-free.

- [ ] **Step 5: Inspect this task and propose the authorized commit**

Run: `git diff --check -- python/lxeskill_cli/services/zhihui_tms/session.py python/lxeskill_cli/services/zhihui_tms/__init__.py python/lxeskill_cli/tests/zhihui_tms/test_session.py`

Expected: no output.

On explicit Git approval:

```bash
git add python/lxeskill_cli/services/zhihui_tms/session.py python/lxeskill_cli/services/zhihui_tms/__init__.py python/lxeskill_cli/tests/zhihui_tms/test_session.py
git commit -m "feat: add Zhihui TMS session provider"
```

### Task 4: 导出编排与单次 401 恢复

**Files:**

- Modify: `python/lxeskill_cli/services/zhihui_tms/client.py`
- Modify: `python/lxeskill_cli/services/agent_cli/zhihui/export_products.py`
- Modify: `python/lxeskill_cli/tests/zhihui_tms/test_zhihui_client.py`
- Modify: `python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`

**Interfaces:**

- Consumes: Task 3's `ZhihuiTmsSessionProvider`.
- Produces: `ZhihuiTmsClient(api_token: str = "")` and `set_authentication_recovery(callback: Callable[[], None]) -> None`.
- Produces: cache hit skips login; cache miss logs in and saves; 401 recovers only once.

- [ ] **Step 1: Write the failing reuse and recovery tests**

```python
def test_cached_token_reuses_session_without_login(monkeypatch, tmp_path):
    provider = FakeProvider(token="fixture-api-token")
    result = export_products.run_action(ARGUMENTS, action="execute")
    assert result["success"] is True
    assert fake_client.login_calls == []
    assert fake_client.initial_token == "fixture-api-token"

def test_http_401_clears_reauthenticates_and_replays_once():
    client = _client(FakeSession([unauthorized(), login_success(), success()]))
    client._api_token = "stale-token"
    client.set_authentication_recovery(recover)
    assert client.find_my_stockwarehouse_list(page=1)["code"] == "200"
    assert recover.calls == 1
```

Also test cache miss saves the new token, a second 401 stops after one recovery, and each of 403, 429, unknown business error, network error, and download failure leaves recovery call count at zero.

- [ ] **Step 2: Run the tests to verify current behavior fails**

Run: `uv run pytest -q python/lxeskill_cli/tests/zhihui_tms/test_zhihui_client.py python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`

Expected: FAIL because the client has no initial-token/recovery interface and export always calls `login`.

- [ ] **Step 3: Implement the minimal recovery boundary**

```python
client = ZhihuiTmsClient(api_token=session_provider.read(account) or "")

def authenticate_and_persist() -> None:
    session_provider.clear(account)
    client.login(account, password)
    session_provider.write(account, client.api_token)

client.set_authentication_recovery(authenticate_and_persist)
if not client.api_token:
    authenticate_and_persist()
```

Within `ZhihuiTmsClient._post_json`, for exactly one authenticated POST with HTTP 401, call the registered recovery function, rebuild the `token` header from the replacement `api_token`, and repeat the same request once. Do not activate it for `/login` or downloads. If recovery is absent or fails, a second 401 occurs, or the status is not 401, preserve the existing typed failure. Keep the existing account lock around provider, login, export and writeback work.

- [ ] **Step 4: Run all Zhihui Python tests**

Run: `uv run pytest -q python/lxeskill_cli/tests/zhihui_tms`

Expected: PASS; first login saves, later export reuses, 401 recovers once, 403/429 stop, missing host remains compatible, and redaction remains intact.

- [ ] **Step 5: Inspect this task and propose the authorized commit**

Run: `git diff --check -- python/lxeskill_cli/services/zhihui_tms/client.py python/lxeskill_cli/services/agent_cli/zhihui/export_products.py python/lxeskill_cli/tests/zhihui_tms/test_zhihui_client.py python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`

Expected: no output.

On explicit Git approval:

```bash
git add python/lxeskill_cli/services/zhihui_tms/client.py python/lxeskill_cli/services/agent_cli/zhihui/export_products.py python/lxeskill_cli/tests/zhihui_tms/test_zhihui_client.py python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py
git commit -m "feat: reuse Zhihui TMS sessions for exports"
```

### Task 5: 回归、交接与敏感信息审计

**Files:**

- Modify: `docs/superpowers/handoffs/2026-09-21-business-contract-convergence.md`
- Modify: `skills/zhihui-tms-product-export/SKILL.md`
- Test: `apps/desktop/test/config-store.test.ts`
- Test: `apps/desktop/test/zhihui-tms-session-host.test.ts`
- Test: `python/lxeskill_cli/tests/zhihui_tms/`

**Interfaces:**

- Consumes: Tasks 1–4's tested contracts.
- Produces: a handoff with branch, call chain, runtime variables, evidence, known limitations, and next step.

- [ ] **Step 1: Run focused tests and workspace typecheck**

Run: `bun test apps/desktop/test/config-store.test.ts apps/desktop/test/zhihui-tms-session-host.test.ts && uv run pytest -q python/lxeskill_cli/tests/zhihui_tms && bun run typecheck`

Expected: all tests pass and workspace typecheck exits 0.

- [ ] **Step 2: Verify lifecycle without calling production**

Use the host fixture or a temporary Desktop data root to start and stop the session host. Assert the Gateway-only environment contains the two locator variables and no actual command executes with `ZHIHUI_TMS_PRODUCTION_ENABLED=1`.

- [ ] **Step 3: Update the handoff and skill contract**

Record: current branch; `DesktopConfigStore → ZhihuiTmsSessionHost → ZhihuiTmsSessionProvider → ZhihuiTmsClient → export_products`; the two locator environment variable names; test outputs; no confirmed fixed token TTL; exact 401-only recovery; 403/429 stop. State in the skill that preview never logs in and execution reuses a valid Desktop session when available.

- [ ] **Step 4: Run the final security and working-tree audit**

Run: `git diff --check && git status --short && rg -n --hidden --glob '!**/.git/**' 'fixture-api-token|stale-token|ZHIHUI_TMS_SESSION_HOST_TOKEN' apps/desktop python/lxeskill_cli docs/superpowers/handoffs skills/zhihui-tms-product-export`

Expected: `git diff --check` has no output; status keeps unrelated existing work; search finds only variable names, tests, or documentation—not real credentials.

- [ ] **Step 5: Propose Git closure without changing Git state**

Report verification and exact file list. Only after explicit Git approval run:

```bash
git add apps/desktop/src/main/config-store/model.ts apps/desktop/src/main/config-store/setup.ts apps/desktop/src/main/config-store/store.ts apps/desktop/src/main/zhihui-tms-session-host.ts apps/desktop/src/main.ts apps/desktop/src/main/desktop-gateway.ts apps/desktop/test/config-store.test.ts apps/desktop/test/zhihui-tms-session-host.test.ts python/lxeskill_cli/services/zhihui_tms/session.py python/lxeskill_cli/services/zhihui_tms/client.py python/lxeskill_cli/services/agent_cli/zhihui/export_products.py python/lxeskill_cli/tests/zhihui_tms/test_session.py python/lxeskill_cli/tests/zhihui_tms/test_zhihui_client.py python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py docs/superpowers/handoffs/2026-09-21-business-contract-convergence.md skills/zhihui-tms-product-export/SKILL.md
git commit -m "feat: reuse Zhihui TMS sessions for exports"
```

## Plan Self-Review

- **Spec coverage:** Task 1 implements encrypted persistence and configuration invalidation; Task 2 implements the Desktop security boundary and lifecycle; Task 3 implements provider isolation and no-host compatibility; Task 4 implements reuse, 401-only recovery, lock preservation, and stop rules; Task 5 verifies, documents, and audits all constraints.
- **Placeholder scan:** Every task identifies files, interfaces, concrete test commands, expected outcome, and implementation shape. No deferred behavior is left for the implementer to infer.
- **Type consistency:** Desktop exposes fingerprint-keyed read/save/clear methods; the host consumes that same contract; Python derives the fingerprint; the client receives initial token plus zero-argument recovery; export owns credentials and persistence callback.
