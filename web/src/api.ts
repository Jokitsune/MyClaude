import type {
  AppConfig,
  ChatMessage,
  ConfigUpdate,
  Governance,
  GovernanceUpdate,
  Lesson,
  PermissionDecision,
  PermissionRequest,
  SessionMeta,
  StreamEvent,
  ToolCall,
  ToolResult,
} from "./types";
import { createMockApi } from "./mock";
import { ApiError } from "./errors";

export { ApiError };

export interface Api {
  health(): Promise<{ ok: true; version: string }>;
  getConfig(): Promise<AppConfig>;
  putConfig(update: ConfigUpdate): Promise<AppConfig>;
  listSessions(): Promise<SessionMeta[]>;
  createSession(title?: string): Promise<SessionMeta>;
  getSession(id: string): Promise<{ session: SessionMeta; messages: ChatMessage[] }>;
  deleteSession(id: string): Promise<{ ok: true }>;
  heartbeat(id: string): Promise<{ ok: true }>;
  closeSession(id: string): Promise<SessionMeta>;
  /** Envoie un message et consomme le flux SSE. Résout quand le flux se termine. */
  sendMessage(
    id: string,
    text: string,
    onEvent: (ev: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  listLessons(status?: Lesson["status"]): Promise<Lesson[]>;
  approveLesson(id: string, text?: string): Promise<Lesson>;
  rejectLesson(id: string): Promise<Lesson>;
  getMemory(): Promise<{ content: string }>;
  putMemory(content: string): Promise<{ content: string }>;
  getGovernance(): Promise<Governance>;
  putGovernance(update: GovernanceUpdate): Promise<Governance>;
  /** Répond à une demande d'autorisation d'outil (404 si inconnue/expirée). */
  respondPermission(sessionId: string, reqId: string, decision: PermissionDecision): Promise<{ ok: true }>;
}

// URL relative : fonctionne via le proxy Vite en dev et quand le serveur sert le build.
const BASE = "api";

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `Erreur ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === "string" && body.error) message = body.error;
  } catch {
    /* corps non JSON */
  }
  return new ApiError(res.status, message);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Impossible de joindre le serveur local.");
  }
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as T;
}

/** Transforme un bloc SSE (`event:` / `data:`) en événement typé. */
function toStreamEvent(event: string, data: string): StreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  switch (event) {
    case "user":
      return { type: "user", message: p as unknown as ChatMessage };
    case "done":
      return { type: "done", message: p as unknown as ChatMessage };
    case "thinking":
      return { type: "thinking", text: String(p.text ?? "") };
    case "delta":
      return { type: "delta", text: String(p.text ?? "") };
    case "error":
      return { type: "error", error: String(p.error ?? "Erreur inconnue.") };
    case "tool_use":
      return typeof p.id === "string" ? { type: "tool_use", tool: p as unknown as ToolCall } : null;
    case "tool_result":
      return typeof p.id === "string" ? { type: "tool_result", result: p as unknown as ToolResult } : null;
    case "permission_request":
      return typeof p.id === "string" ? { type: "permission_request", request: p as unknown as PermissionRequest } : null;
    default:
      return null;
  }
}

/** Lit un flux `text/event-stream` depuis un ReadableStream (EventSource ne permet pas POST). */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: StreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushBlock = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(":")) continue;
      const idx = line.indexOf(":");
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? "" : line.slice(idx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    const ev = toStreamEvent(event, data.join("\n"));
    if (ev) onEvent(ev);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        flushBlock(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) flushBlock(buffer);
  } finally {
    reader.releaseLock();
  }
}

const enc = encodeURIComponent;

export const httpApi: Api = {
  health: () => request("GET", "/health"),
  getConfig: () => request("GET", "/config"),
  putConfig: (update) => request("PUT", "/config", update),
  listSessions: () => request("GET", "/sessions"),
  createSession: (title) => request("POST", "/sessions", title ? { title } : {}),
  getSession: (id) => request("GET", `/sessions/${enc(id)}`),
  deleteSession: (id) => request("DELETE", `/sessions/${enc(id)}`),
  heartbeat: (id) => request("POST", `/sessions/${enc(id)}/heartbeat`),
  closeSession: (id) => request("POST", `/sessions/${enc(id)}/close`),
  async sendMessage(id, text, onEvent, signal) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/sessions/${enc(id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ text }),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ApiError(0, "Impossible de joindre le serveur local.");
    }
    if (!res.ok) throw await errorFrom(res);
    if (!res.body) throw new ApiError(0, "Flux de réponse indisponible.");
    await readSse(res.body, onEvent);
  },
  listLessons: (status) => request("GET", `/lessons${status ? `?status=${enc(status)}` : ""}`),
  approveLesson: (id, text) =>
    request("POST", `/lessons/${enc(id)}/approve`, text !== undefined ? { text } : {}),
  rejectLesson: (id) => request("POST", `/lessons/${enc(id)}/reject`),
  getMemory: () => request("GET", "/memory"),
  putMemory: (content) => request("PUT", "/memory", { content }),
  getGovernance: () => request("GET", "/governance"),
  putGovernance: (update) => request("PUT", "/governance", update),
  respondPermission: (sessionId, reqId, decision) =>
    request("POST", `/sessions/${enc(sessionId)}/permissions/${enc(reqId)}`, { decision }),
};

export const isMock = import.meta.env.VITE_MOCK === "1" || import.meta.env.MODE === "mock";

export const api: Api = isMock ? createMockApi() : httpApi;
