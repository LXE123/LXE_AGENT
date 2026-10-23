import {
  AnthropicRuntimeProvider,
  PROVIDER_API_STYLE_OPENAI_COMPLETIONS,
  PROVIDER_API_STYLE_OPENAI_RESPONSES,
  type ProviderDescriptor,
  type RuntimeProviderFactory,
} from "./provider";
import { ResponsesRuntimeProvider } from "./responses-provider";
import { CompletionsRuntimeProvider } from "./completions-provider";
import { DeepSeekFilesService } from "./deepseek-files";

const transientDeepSeekFiles = new DeepSeekFilesService();

/**
 * Picks the adapter for a descriptor's wire protocol. This lives outside
 * provider.ts so the concrete adapters only ever import from it, never the
 * other way round.
 */
export const createRuntimeProvider = (descriptor: ProviderDescriptor, deepseekFiles = transientDeepSeekFiles): ReturnType<RuntimeProviderFactory> =>
  descriptor.apiStyle === PROVIDER_API_STYLE_OPENAI_COMPLETIONS
    ? new CompletionsRuntimeProvider(descriptor)
    : descriptor.apiStyle === PROVIDER_API_STYLE_OPENAI_RESPONSES
    ? new ResponsesRuntimeProvider(descriptor, undefined, deepseekFiles)
    : new AnthropicRuntimeProvider(descriptor);
