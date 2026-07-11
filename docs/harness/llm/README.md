# LLM Integration

Status: `Current`

This directory documents the model-provider boundary used by the Bun runtime. The implementation truth source is `packages/runtime/src/provider.ts`; provider descriptors live under `packages/runtime/config/providers/`.

## Responsibilities

The provider layer is responsible for:

- resolving the selected provider and model from runtime configuration;
- translating canonical runtime messages into Anthropic Messages requests;
- attaching tool schemas and thinking controls supported by the selected model;
- streaming text, reasoning, and tool-use deltas back to the turn loop;
- classifying retryable, authentication, rate-limit, and context-overflow failures;
- sanitizing provider-specific history that cannot safely be replayed.

It does not own session persistence, tool execution, context compaction, or final channel delivery. Those remain runtime and gateway responsibilities.

## Request Lifecycle

1. A turn snapshots the current provider configuration.
2. Runtime context assembly produces canonical messages and exposed tool definitions.
3. The provider adapter repairs provider-specific history and estimates request budget.
4. The Anthropic-compatible stream is opened with model, thinking, timeout, and token settings.
5. Stream events are normalized into runtime deltas and accumulated into one assistant message.
6. The turn loop either executes requested tools, emits a final answer, retries a transient failure, or enters context-overflow recovery.

Provider reconfiguration is atomic for future turns. An in-flight turn keeps the provider snapshot with which it started.

## Documents

- [Provider catalog](provider_catalog.md): descriptors, environment variables, model selection, and provider-specific repair.
- [Streaming adapter](streaming_adapter.md): request construction, event normalization, retries, timeouts, and tracing.
- [Runtime context](../runtime/context/README.md): canonical messages, request budgeting, and compaction.
- [Tool schema](../runtime/tools/tool_schema.md): how runtime tools become provider-visible schemas.

## Operational Checks

When an LLM call fails, distinguish these layers before changing code:

- configuration: missing auth variable, unknown provider/model, invalid base URL;
- request shape: unsupported thinking block, image history, or tool schema;
- transport: timeout, connection reset, rate limit, or provider outage;
- context: request exceeds the model window before or after compaction;
- runtime: malformed tool-call closure or invalid canonical message ordering.

Detailed request diagnostics belong in sanitized runtime traces. Secrets, authorization headers, cookies, base64 payloads, and absolute local paths must never be emitted verbatim.
