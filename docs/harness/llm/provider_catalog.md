# Provider Catalog

Runtime resolves a provider descriptor from the local catalog and, for company models, the validated cloud definition. Local model entries live in `config/llm/providers/`; cloud compatibility is defined by [managed-model-definition.ts](/packages/foundation/core/src/managed-model-definition.ts). [provider.ts](/packages/agent/runtime/src/providers/provider.ts) builds the selected runtime descriptor.

## Descriptor Contract

A descriptor records the stable facts needed to create a provider client:

- provider identifier and display metadata;
- API style (Anthropic Messages, OpenAI Completions, or OpenAI Responses) and base URL;
- authentication environment variable;
- available model identifiers and labels;
- context-window and output-token limits;
- supported thinking levels and provider quirks.

Repository and cloud model definitions contain no credentials; the resolved Runtime descriptor receives the selected key separately. Desktop owns credential selection: company credentials use encrypted storage, while personal model keys use local auth.json. Source Desktop dotenv files do not configure model keys. See [Desktop configuration](../../desktop/README.md#桌面配置与安全).

## Runtime Selection

Desktop selects a provider/model pair and passes the resolved configuration to Runtime. The explicit CLI exec entry supplies its own runtime configuration. Runtime validates the model against the selected local catalog or supported cloud definition before starting a request. A configuration update replaces the shared provider snapshot atomically and affects the next turn, not a request already streaming.

Relevant runtime controls include:

- the selected provider and model;
- the selected thinking or effort level.

The requested output cap comes from the selected model descriptor, with a conservative internal fallback when metadata is absent. Provider inactivity uses the validated descriptor timeout, defaulting to 120 seconds, between connection and stream events. Model context limits come from the local catalog or cloud model definition rather than a global environment setting.

## Protocol And History Adaptation

The descriptor selects one of the [three runtime adapters](README.md). The same model family can have protocol-specific tool, reasoning and image requirements; an Anthropic wire rule must not be applied to OpenAI requests.

Adapters preserve closed tool-call/result relationships and translate canonical history to their wire format. Opaque reasoning signatures, provider item IDs and namespaces are replayed only for a matching source. Unsupported content is adapted for the selected protocol without silently rewriting the persisted transcript. See [Assistant message streaming](../assistant-message-stream.md).

## Adding A Local Provider Or Model

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

## Company-managed model sets

Desktop prefers the v3 cloud manifest, with v2 and legacy responses retained for compatibility. v3 can publish a model ID absent from the local catalog, provided its supplier, protocol, address and model definition pass the client contract. Personal credentials and local model entries remain a separate source.

The manifest and per-target credentials are encrypted locally and passed to Gateway and Agent CLI as typed state. Each running turn holds its acquired configuration and credentials; updates apply to later turns. Network failures preserve cache, while explicit withdrawal removes the affected target. An unavailable company target must not silently spend a personal key.

Cloud publication, configuration revisions, credential refresh and rollout have one maintained reference: [Cloud model definitions v3](managed-model-catalog.md).
