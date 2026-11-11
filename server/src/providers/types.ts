import type { AgentDef, McpServerDef } from "../governance.js";
import type { AccountInfo, Effort, StoredConfig } from "../types.js";

/** Décision rendue pour un appel d'outil. */
export type ToolGateResult = { behavior: "allow" } | { behavior: "deny"; message: string };

/**
 * Point de décision des permissions, fourni par le service à chaque échange.
 * - `preToolUse` : appelé pour CHAQUE appel d'outil (même ceux que Claude Code autoriserait seul) ;
 *   renvoie allow / deny (définitif) ou ask (la décision passe alors par `canUseTool`).
 * - `canUseTool` : demande de permission (peut attendre la validation de l'utilisateur).
 */
export interface ToolGate {
  preToolUse(tool: string, input: unknown, toolUseId: string): Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }>;
  canUseTool(tool: string, input: unknown, opts: { toolUseId: string; signal: AbortSignal }): Promise<ToolGateResult>;
}

export interface ProviderChatParams {
  model: string;
  effort: Effort;
  /** Prompt système complet (governance/system.md + memory.md). */
  system: string;
  /** Message envoyé pour ce tour (éventuellement précédé de la transcription en cas de reprise impossible). */
  prompt: string;
  /** ID de session moteur à reprendre. */
  resume?: string;
  /** Dossier de travail (cwd du moteur). */
  cwd: string;
  /** Outils intégrés disponibles (governance/tools.json). */
  tools: string[];
  mcpServers: Record<string, McpServerDef>;
  agents: Record<string, AgentDef>;
  gate: ToolGate;
  signal: AbortSignal;
  onSessionId(id: string): void;
  onThinking(delta: string): void;
  onText(delta: string): void;
  onToolUse(call: { id: string; name: string; input: unknown }): void;
  onToolResult(result: { id: string; isError: boolean; preview: string }): void;
}

export type ProviderStopReason = "end" | "max_tokens" | "refusal" | "other";

export interface ProviderChatResult {
  stopReason: ProviderStopReason;
  usage?: { input_tokens: number; output_tokens: number };
  sessionId?: string;
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

export interface EngineStatus {
  ready: boolean;
  account: AccountInfo | null;
  error?: string;
}

export type ProviderErrorCode =
  | "no_key"
  | "not_logged_in"
  | "engine_missing"
  | "resume_failed"
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

/** Codes pour lesquels un bilan doit rester `pending` (retenté plus tard) plutôt que `failed`. */
export const RETRY_LATER_CODES: ReadonlySet<ProviderErrorCode> = new Set(["no_key", "not_logged_in", "engine_missing", "aborted"]);

export interface Provider {
  readonly name: string;
  /** Diffuse une réponse (texte, réflexion, outils). Lève ProviderError. */
  chat(params: ProviderChatParams): Promise<ProviderChatResult>;
  /** Génère un objet JSON conforme au schéma, sans aucun outil. Lève ProviderError. */
  generateJson(params: ProviderJsonParams): Promise<unknown>;
  /** État du moteur : joignable, compte connecté. Ne lève pas. */
  status(): Promise<EngineStatus>;
  /** Supprime la transcription moteur d'une session si elle est localisable de façon sûre. */
  deleteTranscript?(sessionId: string, cwd: string): Promise<void>;
}

/**
 * Construit un fournisseur à partir de la configuration de l'app.
 * Renvoie `null` si aucun fournisseur n'est utilisable (ex. mode clé API sans clé).
 */
export type ProviderFactory = (config: StoredConfig) => Provider | null;

export function refusalMessage(category?: string | null): string {
  const base = "Claude a refusé de répondre à cette demande (refus de sécurité).";
  return category ? `${base} Catégorie : ${category}.` : base;
}
