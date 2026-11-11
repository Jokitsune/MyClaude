// Types partagés — copiés à l'identique depuis docs/ARCHITECTURE.md (contrat).

export type SessionStatus = "open" | "closed" | "interrupted";
export type CloseReason = "user" | "idle" | "app-quit" | "recovered";
export type ReviewStatus = "pending" | "running" | "done" | "failed";

export interface SessionMeta {
  id: string;               // ex. "2026-11-11_143207_ab12"
  title: string;            // "Nouvelle session" puis titre auto (premiers mots du 1er message)
  status: SessionStatus;
  closeReason?: CloseReason;
  createdAt: string;        // ISO
  updatedAt: string;
  lastHeartbeat: string;
  model: string;
  review: ReviewStatus;
  reviewError?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;             // texte affiché
  thinking?: string;        // résumé de réflexion (assistant)
  createdAt: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;           // si la réponse a échoué / été interrompue
  tools?: ToolCall[];       // v2 : appels d'outils effectués pendant la réponse
}

export interface Lesson {
  id: string;
  sessionId: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
  kind: "preference" | "mistake" | "success" | "fact";
  text: string;             // la leçon, une phrase actionnable
  rationale: string;        // pourquoi
}

export interface AppConfig {       // forme renvoyée au client (jamais la clé)
  hasApiKey: boolean;
  model: string;            // défaut "claude-opus-5-5"
  effort: "low" | "medium" | "high" | "xhigh" | "max";   // défaut "medium"
  dataDir: string;
  availableModels: { id: string; label: string }[];
  // v2
  authMode: "subscription" | "apiKey";
  workspaceDir: string;
  account?: { email?: string; organization?: string; subscription?: string } | null;
  engineReady: boolean;        // Claude Code joignable + compte connecté (ou clé présente en mode apiKey)
  engineError?: string;
}

export interface ToolCall {
  id: string; name: string; input: unknown;
  status: "pending_approval" | "running" | "done" | "error" | "denied";
  resultPreview?: string;      // 2000 caractères max
}

export interface PermissionRequest { id: string; sessionId: string; toolCallId: string; tool: string; input: unknown; summary: string; }

// --- Types propres au client web (hors contrat partagé) ---

export type Effort = AppConfig["effort"];

export type AuthMode = AppConfig["authMode"];

export interface ConfigUpdate {
  apiKey?: string | null;
  model?: string;
  effort?: Effort;
  authMode?: AuthMode;
  workspaceDir?: string;
}

export type PermissionDecision = "allow" | "deny" | "allow_session";

/** `GET/PUT /api/governance` : contenus des 4 fichiers de `dataDir/governance/`. */
export interface Governance {
  system: string;                                   // system.md
  tools: { allowed: string[] };                     // tools.json
  mcp: { mcpServers: Record<string, unknown> };     // mcp.json
  agents: Record<string, unknown>;                  // agents.json
}

export type GovernanceUpdate = Partial<Governance>;

export interface ToolResult {
  id: string;
  status: ToolCall["status"];
  resultPreview?: string;
}

export type StreamEvent =
  | { type: "user"; message: ChatMessage }
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; error: string }
  | { type: "tool_use"; tool: ToolCall }
  | { type: "tool_result"; result: ToolResult }
  | { type: "permission_request"; request: PermissionRequest };
