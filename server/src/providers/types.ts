import type { Effort, StoredConfig } from "../types.js";

/** Message de conversation transmis au fournisseur (texte uniquement). */
export interface ProviderMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ProviderChatParams {
  model: string;
  effort: Effort;
  system: string;
  messages: ProviderMessage[];
  signal: AbortSignal;
  onThinking(delta: string): void;
  onText(delta: string): void;
}

export type ProviderStopReason = "end" | "max_tokens" | "refusal" | "other";

export interface ProviderChatResult {
  stopReason: ProviderStopReason;
  usage?: { input_tokens: number; output_tokens: number };
  /** Modèle ayant réellement produit la réponse (peut différer en cas de fallback). */
  servedBy?: string;
  /** Catégorie de refus, à titre informatif. */
  refusalCategory?: string | null;
}

export interface ProviderJsonParams {
  model: string;
  effort: Effort;
  system: string;
  prompt: string;
  /** JSON Schema (sorties structurées). */
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

export type ProviderErrorCode =
  | "no_key"
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "bad_request"
  | "too_large"
  | "timeout"
  | "connection"
  | "aborted"
  | "refusal"
  | "invalid_output"
  | "unknown";

/** Erreur fournisseur avec message déjà traduit en français (présentable à l'utilisateur). */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface Provider {
  readonly name: string;
  /** Diffuse une réponse ; appelle onThinking/onText au fil de l'eau. Lève ProviderError. */
  chat(params: ProviderChatParams): Promise<ProviderChatResult>;
  /** Génère un objet JSON conforme au schéma (sorties structurées). Lève ProviderError. */
  generateJson(params: ProviderJsonParams): Promise<unknown>;
}

/**
 * Construit un fournisseur à partir de la configuration de l'app.
 * Renvoie `null` si aucun fournisseur n'est utilisable (ex. pas de clé API).
 */
export type ProviderFactory = (config: StoredConfig) => Provider | null;
