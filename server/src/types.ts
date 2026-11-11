// Types partagés — copiés à l'identique dans web/src/types.ts (voir docs/ARCHITECTURE.md, v2).

export type SessionStatus = "open" | "closed" | "interrupted";
export type CloseReason = "user" | "idle" | "app-quit" | "recovered";
export type ReviewStatus = "pending" | "running" | "done" | "failed";
export type AuthMode = "subscription" | "apiKey";

export interface SessionMeta {
  id: string; // ex. "2026-11-11_143207_ab12"
  title: string; // "Nouvelle session" puis titre auto (premiers mots du 1er message)
  status: SessionStatus;
  closeReason?: CloseReason;
  createdAt: string; // ISO
  updatedAt: string;
  lastHeartbeat: string;
  model: string;
  review: ReviewStatus;
  reviewError?: string;
  /** v2 : ID de session du moteur (Claude Agent SDK), repris au message suivant. */
  engineSessionId?: string;
  /** v2 : dossier de travail utilisé par cette session moteur (pour localiser sa transcription). */
  engineCwd?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  status: "pending_approval" | "running" | "done" | "error" | "denied";
  resultPreview?: string; // 2000 caractères max
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string; // texte affiché
  thinking?: string; // résumé de réflexion (assistant)
  createdAt: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string; // si la réponse a échoué / été interrompue
  tools?: ToolCall[]; // v2 : appels d'outils de la réponse
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  tool: string;
  input: unknown;
  summary: string;
}

export type PermissionDecision = "allow" | "deny" | "allow_session";

export interface Lesson {
  id: string;
  sessionId: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
  kind: "preference" | "mistake" | "success" | "fact";
  text: string; // la leçon, une phrase actionnable
  rationale: string; // pourquoi
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscription?: string;
}

export interface AppConfig {
  // forme renvoyée au client (jamais la clé)
  hasApiKey: boolean;
  model: string; // défaut "claude-opus-5-5"
  effort: Effort; // défaut "medium"
  dataDir: string;
  availableModels: { id: string; label: string }[];
  authMode: AuthMode;
  workspaceDir: string;
  account?: AccountInfo | null;
  engineReady: boolean; // Claude Code joignable + compte connecté (ou clé présente en mode apiKey)
  engineError?: string;
}

/** Forme stockée dans config.json (contient la clé : ne jamais renvoyer au client). */
export interface StoredConfig {
  apiKey?: string;
  model: string;
  effort: Effort;
  authMode: AuthMode;
  workspaceDir: string;
}

/** Qui a pris une décision de permission. */
export type PermissionDecider = "auto" | "user" | "session" | "timeout" | "disconnect";

/** Lignes de events.jsonl. */
export type SessionEvent =
  | { t: string; type: "message"; message: ChatMessage }
  | { t: string; type: "closed"; reason: CloseReason }
  | {
      t: string;
      type: "permission";
      tool: string;
      input: unknown;
      decision: "allow" | "deny";
      by: PermissionDecider;
      toolCallId?: string;
      reason?: string;
    };

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const AUTH_MODES: readonly AuthMode[] = ["subscription", "apiKey"];

/** Alias acceptés par Claude Code + IDs complets. */
export const AVAILABLE_MODELS: { id: string; label: string }[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "opus", label: "Opus (dernier)" },
  { id: "sonnet", label: "Sonnet (dernier)" },
  { id: "haiku", label: "Haiku (dernier)" },
];

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "medium";
export const DEFAULT_AUTH_MODE: AuthMode = "subscription";
export const DEFAULT_TITLE = "Nouvelle session";
