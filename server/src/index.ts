import { startServerInternal, type RunningServer, type StartOptions } from "./app.js";

export type { StartOptions, RunningServer } from "./app.js";
export type {
  AccountInfo,
  AppConfig,
  AuthMode,
  ChatMessage,
  PermissionDecision,
  PermissionRequest,
  ToolCall,
  CloseReason,
  Lesson,
  ReviewStatus,
  SessionMeta,
  SessionStatus,
} from "./types.js";

/**
 * Démarre le serveur local MyClaude (127.0.0.1 uniquement).
 * - `port` : 4317 par défaut, 0 = port libre aléatoire.
 * - `dataDir` : MYCLAUDE_DATA_DIR, sinon %APPDATA%/MyClaude/data (~/.config/MyClaude/data hors Windows).
 * - `webDir` : sert le build web (fallback SPA vers index.html).
 */
export async function startServer(opts?: StartOptions): Promise<RunningServer> {
  const { port, url, close } = await startServerInternal(opts);
  return { port, url, close };
}
