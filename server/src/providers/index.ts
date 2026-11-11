import { AnthropicProvider } from "./anthropic.js";
import type { ProviderFactory } from "./types.js";

export * from "./types.js";
export { AnthropicProvider, createAnthropicClient, mapSdkError } from "./anthropic.js";

/**
 * Fabrique par défaut : Anthropic avec la clé de config.json, sinon rien.
 * (Un fournisseur Ollama 100 % local pourra être choisi ici plus tard.)
 */
export const defaultProviderFactory: ProviderFactory = (config) =>
  config.apiKey ? new AnthropicProvider(config.apiKey) : null;
