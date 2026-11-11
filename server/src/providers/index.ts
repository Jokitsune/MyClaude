import { AgentSdkProvider } from "./agent-sdk.js";
import type { ProviderFactory } from "./types.js";

export * from "./types.js";
export { AgentSdkProvider, buildEngineEnv, isolationOptions, mapEngineError } from "./agent-sdk.js";

/**
 * Fabrique par défaut : Claude Agent SDK.
 * - subscription : login Claude Code de la machine ;
 * - apiKey : clé de config.json (aucun fournisseur si elle manque).
 */
export const defaultProviderFactory: ProviderFactory = (config) => {
  if (config.authMode === "apiKey") {
    return config.apiKey ? new AgentSdkProvider({ auth: { mode: "apiKey", apiKey: config.apiKey } }) : null;
  }
  return new AgentSdkProvider({ auth: { mode: "subscription" } });
};
