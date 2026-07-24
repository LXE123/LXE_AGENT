# Provider Catalog

Status: `Current`

The catalog turns repository-owned provider descriptors into validated runtime configuration. The source of truth is `config/llm/providers/`, loaded by `packages/agent/runtime/src/providers/provider.ts`.

## Descriptor Contract

A descriptor records the stable facts needed to create a provider client:

- provider identifier and display metadata;
- Anthropic-compatible base URL;
- authentication environment variable;
- available model identifiers and labels;
- context-window and output-token limits;
- supported thinking levels and provider quirks.

Descriptors contain no credentials. Local secrets remain in private environment files and are resolved only when a provider is instantiated.

## Runtime Selection

The Dashboard and environment configuration select a provider/model pair. Runtime validates that the model belongs to the selected descriptor before starting a request. A configuration update replaces the shared provider snapshot atomically and affects the next turn, not a request already streaming.

Relevant runtime controls include:

- the selected provider and model;
- the selected thinking or effort level.

The requested output cap comes from the selected model descriptor, with a conservative internal fallback when metadata is absent. Provider inactivity uses a fixed 120-second watchdog between connection and stream events. Model context limits come from catalog metadata rather than a global environment setting.

## Anthropic-Compatible Providers

The production transport uses the Anthropic Messages shape. Compatibility does not mean providers accept identical history. The adapter performs narrowly scoped repair before sending:

- Kimi and DeepSeek histories are normalized to their accepted content shape;
- unsupported thinking signatures and encrypted redacted-thinking payloads are removed;
- historical base64 image content that cannot be replayed is stripped;
- canonical tool-use and tool-result relationships remain closed and ordered.

These repairs apply to the provider request view. They must not silently rewrite the persisted canonical transcript.

## Adding A Provider Or Model

1. Add or update a descriptor under `config/llm/providers/`.
2. Use an environment-variable name for authentication; never place a key in the descriptor.
3. Record accurate context, output, and thinking capabilities.
4. Add catalog tests for parsing, model lookup, and invalid configuration.
5. Verify the Dashboard options and runtime selection expose the same models.
6. Exercise streaming text, tool calls, retry classification, and context overflow.

Do not add provider-specific conditionals to the turn loop when the behavior belongs in catalog metadata or provider request adaptation.

## Failure Boundaries

- Unknown provider/model: configuration error before transport.
- Missing credential: explicit setup error without printing the credential value.
- Authentication or permission failure: non-retryable provider error.
- Rate limit or transient upstream failure: bounded retry according to runtime policy.
- Context overflow: handed to runtime compaction/recovery rather than treated as an ordinary retry.
- Unsupported history content: sanitize only the provider request representation and retain a diagnostic reason.
