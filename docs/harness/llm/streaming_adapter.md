# Streaming Adapter

Status: `Current`

The streaming adapter converts one runtime step into an Anthropic-compatible Messages stream and converts provider events back into runtime deltas. Its implementation is centered in `packages/runtime/src/provider.ts`.

## Inputs

Each call receives a stable step snapshot:

- system instructions and canonical conversation messages;
- provider-visible tool definitions;
- selected provider, model, thinking level, and output limit;
- explicit tool choice, including the provider-level `none` value;
- cancellation signal and request timeout;
- turn/session identifiers used only for scoped diagnostics.

Context assembly and tool exposure happen before the adapter is called. The adapter must not discover skills, execute tools, or persist messages.
Before transport, it applies the selected provider's history whitelist and thinking-field rules; unsupported blocks never pass through unchanged.

## Event Normalization

Provider stream events are accumulated into a runtime assistant message. The normalized stream distinguishes:

- user-visible answer text;
- reasoning/thinking text when the provider exposes it;
- tool-use identifiers, names, and incrementally decoded arguments;
- usage and completion metadata;
- terminal provider errors.

Partial JSON tool arguments are buffered until they form the final tool-call input. A completed step returns either final assistant content or tool calls for the runtime loop; it does not execute those calls itself.

The SDK's raw `streamEvent` supplies non-empty initial content from `content_block_start`. SDK high-level callbacks continue to supply subsequent text and thinking deltas. Redacted-thinking blocks are emitted once even when both callback layers observe the same block. Listener or conversion failures are isolated as wire `parse_error` diagnostics and cannot terminate an otherwise healthy provider stream.

## Cancellation And Timeouts

The caller supplies an abort signal. Cancellation must close the provider stream promptly and surface as turn cancellation, not as a generic provider failure.

`LLM_REQUEST_TIMEOUT_S` bounds Provider inactivity independently of gateway job cancellation. The watchdog resets on connection and every stream event, so an active long-running response is not treated as timed out. Timeout errors are classified so the turn loop can apply bounded retry policy. Cleanup must run even when the stream ends before yielding content.

## Retry And Overflow

Ordinary transient requests use bounded attempts; the current turn policy allows up to three normal attempts. Authentication, invalid-request, and permission errors are not retried blindly.
HTTP errors and SSE error events share the same provider classifier. Nested status fields such as `error.error.status_code` are retained before category and retryability are decided.

Context overflow is a separate path:

1. Runtime estimates `system + messages + tool schemas` before the call.
2. If the soft threshold is crossed, it attempts summary compaction.
3. If the provider still reports overflow, runtime performs its dedicated recovery path.
4. If safe compaction cannot reduce the request, the turn returns an explicit overflow result.

This separation prevents a too-large request from consuming normal transport retries without changing its size.

## Tracing And Redaction

Stream and wire traces are optional local diagnostics controlled by runtime trace settings and the local-log master switch. Traces must sanitize:

- authorization, API key, token, secret, password, cookie, and signature fields;
- redacted/encrypted thinking payloads;
- base64 media and oversized strings;
- absolute local filesystem paths.

Console INFO output should summarize request lifecycle and outcome. Detailed event payloads belong at DEBUG or in sanitized local trace files.

## Invariants

- The persisted canonical transcript is not replaced by a provider-repaired request view.
- DeepSeek thinking history is replayed without signature fields; unsupported image, redacted, and unknown blocks are replaced or dropped according to its provider contract.
- Tool calls returned from a stream have stable IDs and valid object arguments.
- A failed stream cannot masquerade as a successful empty assistant response.
- Cancellation and timeout always release stream resources.
- Provider details do not leak through user-facing errors or channel cards.
