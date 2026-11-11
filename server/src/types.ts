// Types partagés — copiés à l'identique dans web/src/types.ts (voir docs/ARCHITECTURE.md).

export type SessionStatus = "open" | "closed" | "interrupted";
export type CloseReason = "user" | "idle" | "app-quit" | "recovered";
export type ReviewStatus = "pending" | "running" | "done" | "failed";

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
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string; // texte affiché
  thinking?: string; // résumé de réflexion (assistant)
  createdAt: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string; // si la réponse a échoué / été interrompue
}

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

export interface AppConfig {
  // forme renvoyée au client (jamais la clé)
  hasApiKey: boolean;
  model: string; // défaut "claude-opus-5-5"
  effort: Effort; // défaut "medium"
  dataDir: string;
  availableModels: { id: string; label: string }[];
}

/** Forme stockée dans config.json (contient la clé : ne jamais renvoyer au client). */
export interface StoredConfig {
  apiKey?: string;
  model: string;
  effort: Effort;
}

/** Lignes de events.jsonl. */
export type SessionEvent =
  | { t: string; type: "message"; message: ChatMessage }
  | { t: string; type: "closed"; reason: CloseReason };

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const AVAILABLE_MODELS: { id: string; label: string }[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-2", label: "Fable 5.2" },
];

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "medium";
export const DEFAULT_TITLE = "Nouvelle session";
