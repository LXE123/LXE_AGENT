import {
  AnthropicRuntimeProvider,
  PROVIDER_API_STYLE_OPENAI_COMPLETIONS,
  PROVIDER_API_STYLE_OPENAI_RESPONSES,
  type ProviderDescriptor,
  type RuntimeProviderFactory,
} from "./provider";
import { ResponsesRuntimeProvider } from "./responses-provider";
import { PROVIDER_API_STYLE_GOOGLE_GENERATIVE_AI } from "@lxe/core";
import { GoogleRuntimeProvider } from "./google-provider";
import { CompletionsRuntimeProvider } from "./completions-provider";
import { DeepSeekFilesService } from "./deepseek-files";

const transientDeepSeekFiles = new DeepSeekFilesService();

/**
 * Picks the adapter for a descriptor's wire protocol. This lives outside
 * provider.ts so the concrete adapters only ever import from it, never the
 * other way round.
 */
export const createRuntimeProvider = (descriptor: ProviderDescriptor, deepseekFiles = transientDeepSeekFiles): ReturnType<RuntimeProviderFactory> => {
  switch (descriptor.apiStyle) {
    case PROVIDER_API_STYLE_GOOGLE_GENERATIVE_AI: return new GoogleRuntimeProvider(descriptor);
    case PROVIDER_API_STYLE_OPENAI_COMPLETIONS: return new CompletionsRuntimeProvider(descriptor);
    case PROVIDER_API_STYLE_OPENAI_RESPONSES: return new ResponsesRuntimeProvider(descriptor, undefined, deepseekFiles);
    default: return new AnthropicRuntimeProvider(descriptor);
  }
};
