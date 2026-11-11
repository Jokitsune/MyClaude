import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { HttpError } from "./errors.js";
import { GovernanceStore, validateGovernancePatch, type Governance } from "./governance.js";
import type { Logger } from "./log.js";
import { canonicalize, checkToolPaths, isInsideDir } from "./pathguard.js";
import { PermissionBroker, READ_ONLY_TOOLS, type ResolvedDecision } from "./permissions.js";
import {
  ProviderError,
  refusalMessage,
  type EngineStatus,
  type Provider,
  type ProviderChatResult,
  type ProviderFactory,
  type ToolGate,
  type ToolGateResult,
} from "./providers/types.js";
import { ReviewQueue } from "./review.js";
import { NotFoundError, nowIso, type Storage } from "./storage.js";
import {
  AUTH_MODES,
  AVAILABLE_MODELS,
  DEFAULT_TITLE,
  EFFORTS,
  type AppConfig,
  type AuthMode,
  type ChatMessage,
  type Effort,
  type Lesson,
  type PermissionDecider,
  type PermissionDecision,
  type PermissionRequest,
  type SessionMeta,
  type StoredConfig,
  type ToolCall,
} from "./types.js";

export const HEARTBEAT_STALE_MS = 2 * 60_000; // démarrage : open + heartbeat > 2 min → interrupted
export const IDLE_TIMEOUT_MS = 30 * 60_000; // inactivité → closed (idle)
export const IDLE_CHECK_INTERVAL_MS = 60_000;
const STATUS_TTL_READY_MS = 5 * 60_000;
const STATUS_TTL_NOT_READY_MS = 15_000;
const MAX_INJECTED_TRANSCRIPT_CHARS = 150_000;
const PREVIEW_MAX = 2000;

export type SseEvent = "user" | "thinking" | "delta" | "tool_use" | "tool_result" | "permission_request" | "done" | "error";
export type SseSink = (event: SseEvent, data: unknown) => void;

type AbortReason = "client" | "app-quit" | "session-closed";

interface ActiveStream {
  controller: AbortController;
  done: Promise<void>;
}

export interface ServiceOptions {
  /** Délai avant refus automatique d'une demande de permission (défaut 10 min). */
  permissionTimeoutMs?: number;
}

function autoTitle(text: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  if (!words) return DEFAULT_TITLE;
  return words.length > 60 ? words.slice(0, 57).trimEnd() + "…" : words;
}

function abortMessage(reason: unknown): string {
  switch (reason as AbortReason) {
    case "app-quit":
      return "Réponse interrompue : fermeture de l'application.";
    case "session-closed":
      return "Réponse interrompue : session clôturée.";
    default:
      return "Réponse interrompue : connexion fermée par l'interface.";
  }
}

/**
 * Message envoyé au moteur quand la session moteur ne peut pas être reprise :
 * la transcription MyClaude (texte des échanges) précède le nouveau message.
 */
export function buildPromptWithTranscript(history: ChatMessage[], text: string): string {
  const parts = history
    .filter((m) => m.text.trim())
    .map((m) => `${m.role === "user" ? "Utilisateur" : "Claude"} :\n${m.text.trim()}`);
  if (!parts.length) return text;
  let transcript = parts.join("\n\n---\n\n");
  if (transcript.length > MAX_INJECTED_TRANSCRIPT_CHARS)
    transcript = "[… début tronqué …]\n\n" + transcript.slice(-MAX_INJECTED_TRANSCRIPT_CHARS);
  return (
    "Contexte : voici la transcription de notre conversation précédente dans MyClaude " +
    "(l'historique du moteur n'a pas pu être repris). Poursuis-la naturellement.\n\n" +
    `<transcription>\n${transcript}\n</transcription>\n\n` +
    `Nouveau message de l'utilisateur :\n${text}`
  );
}

/** Copie bornée d'une entrée d'outil pour le journal (chaînes tronquées). */
export function journalInput(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return input.length > PREVIEW_MAX ? input.slice(0, PREVIEW_MAX) + "…" : input;
  if (depth > 4 || input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.slice(0, 50).map((v) => journalInput(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input).slice(0, 50)) out[k] = journalInput(v, depth + 1);
  return out;
}

/** Résumé lisible (FR) d'une demande de permission. */
export function summarizeToolCall(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  let out: string;
  switch (tool) {
    case "Write":
      out = `Écrire le fichier ${s("file_path")}`;
      break;
    case "Edit":
    case "MultiEdit":
      out = `Modifier le fichier ${s("file_path")}`;
      break;
    case "NotebookEdit":
      out = `Modifier le notebook ${s("notebook_path")}`;
      break;
    case "Bash":
    case "PowerShell":
      out = `Exécuter la commande : ${s("command")}`;
      break;
    case "WebFetch":
      out = `Ouvrir la page ${s("url")}`;
      break;
    case "WebSearch":
      out = `Rechercher sur le web : ${s("query")}`;
      break;
    case "Agent":
    case "Task":
      out = `Lancer le sous-agent ${s("subagent_type") || s("description")}`.trim();
      break;
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
      out = m ? `Outil MCP ${m[1]} › ${m[2]}` : `Utiliser l'outil ${tool}`;
    }
  }
  return out.length > 300 ? out.slice(0, 299) + "…" : out;
}

function authKey(cfg: StoredConfig): string {
  const k = cfg.authMode === "apiKey" && cfg.apiKey ? createHash("sha256").update(cfg.apiKey).digest("hex").slice(0, 12) : "";
  return `${cfg.authMode}:${k}`;
}

export class AppService {
  readonly reviews: ReviewQueue;
  readonly governance: GovernanceStore;
  readonly permissions: PermissionBroker;
  private readonly active = new Map<string, ActiveStream>();
  private idleTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private statusCache: { key: string; at: number; value: EngineStatus } | null = null;
  private statusInflight: { key: string; promise: Promise<EngineStatus> } | null = null;

  constructor(
    readonly storage: Storage,
    private readonly providerFactory: ProviderFactory,
    private readonly log: Logger,
    opts: ServiceOptions = {},
  ) {
    this.governance = new GovernanceStore(storage.dataDir, log);
    this.permissions = new PermissionBroker(opts.permissionTimeoutMs);
    this.reviews = new ReviewQueue(storage, providerFactory, log);
  }

  // ------------------------------------------------------------ cycle de vie

  /** Récupération au démarrage puis lancement des tâches de fond. */
  async start(opts: { idleCheck?: boolean } = {}): Promise<void> {
    await this.storage.init();
    await this.governance.init();
    await this.recover();
    void this.reviews.scan().catch((e) => this.log.error("scan des bilans", e));
    if (opts.idleCheck !== false) {
      this.idleTimer = setInterval(() => {
        void this.checkIdle().catch((e) => this.log.error("vérification d'inactivité", e));
      }, IDLE_CHECK_INTERVAL_MS);
      this.idleTimer.unref();
    }
  }

  /**
   * - session `open` au heartbeat périmé (> 2 min) → `interrupted` (`recovered`) ;
   * - bilan resté `running` (arrêt brutal) → `pending`.
   */
  async recover(now = Date.now()): Promise<void> {
    for (const s of await this.storage.listSessions()) {
      try {
        if (s.status === "open" && now - Date.parse(s.lastHeartbeat) > HEARTBEAT_STALE_MS) {
          await this.storage.closeSession(s.id, "recovered", "interrupted");
          this.log.info(`session ${s.id} récupérée (interrompue)`);
        }
        if (s.review === "running") {
          await this.storage.updateMeta(s.id, (m) => {
            if (m.review === "running") m.review = "pending";
          });
        }
      } catch (err) {
        this.log.error(`récupération de ${s.id}`, err);
      }
    }
  }

  /** Clôt (`idle`) les sessions ouvertes sans message ni heartbeat depuis 30 min. */
  async checkIdle(now = Date.now()): Promise<void> {
    if (this.stopped) return;
    for (const s of await this.storage.listSessions()) {
      if (s.status !== "open" || this.active.has(s.id)) continue;
      const last = Math.max(Date.parse(s.lastHeartbeat) || 0, Date.parse(s.updatedAt) || 0);
      if (now - last > IDLE_TIMEOUT_MS) {
        await this.storage.closeSession(s.id, "idle");
        this.permissions.clearSession(s.id);
        this.reviews.enqueue(s.id);
      }
    }
  }

  /** Arrêt propre : interrompt les flux (réponses partielles journalisées), clôt les sessions ouvertes. */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    const pending = [...this.active.values()];
    for (const a of pending) a.controller.abort("app-quit" satisfies AbortReason);
    await Promise.allSettled(pending.map((a) => a.done));
    await this.reviews.stop();
    for (const s of await this.storage.listSessions()) {
      if (s.status === "open") {
        await this.storage.closeSession(s.id, "app-quit").catch((e) => this.log.error(`clôture ${s.id}`, e));
      }
    }
  }

  // ------------------------------------------------------------------ moteur

  /** État du moteur (mis en cache : le sondage lance un sous-processus Claude Code). */
  async engineStatus(cfg: StoredConfig, force = false): Promise<EngineStatus> {
    const key = authKey(cfg);
    const c = this.statusCache;
    if (!force && c && c.key === key) {
      const ttl = c.value.ready ? STATUS_TTL_READY_MS : STATUS_TTL_NOT_READY_MS;
      if (Date.now() - c.at < ttl) return c.value;
    }
    if (this.statusInflight?.key === key) return this.statusInflight.promise;
    const provider = this.providerFactory(cfg);
    const promise = (async (): Promise<EngineStatus> => {
      if (!provider)
        return {
          ready: false,
          account: null,
          error:
            cfg.authMode === "apiKey"
              ? "Mode clé API : aucune clé API configurée. Ajoutez votre clé dans les Réglages."
              : "Moteur indisponible.",
        };
      try {
        return await provider.status();
      } catch (err) {
        this.log.error("état du moteur", err);
        return { ready: false, account: null, error: "Impossible de vérifier l'état de Claude Code." };
      }
    })();
    this.statusInflight = { key, promise };
    try {
      const value = await promise;
      this.statusCache = { key, at: Date.now(), value };
      return value;
    } finally {
      if (this.statusInflight?.promise === promise) this.statusInflight = null;
    }
  }

  // ------------------------------------------------------------------ config

  async getConfig(opts: { refresh?: boolean } = {}): Promise<AppConfig> {
    const cfg = await this.storage.readConfig();
    const status = await this.engineStatus(cfg, opts.refresh);
    const out: AppConfig = {
      hasApiKey: !!cfg.apiKey,
      model: cfg.model,
      effort: cfg.effort,
      dataDir: this.storage.dataDir,
      availableModels: AVAILABLE_MODELS.map((m) => ({ ...m })),
      authMode: cfg.authMode,
      workspaceDir: cfg.workspaceDir,
      account: status.account,
      engineReady: status.ready,
    };
    if (status.error) out.engineError = status.error;
    return out;
  }

  /** Valide (et crée si besoin) un dossier de travail. Renvoie le chemin normalisé. */
  async validateWorkspaceDir(raw: unknown): Promise<string> {
    if (typeof raw !== "string" || !raw.trim()) throw new HttpError(400, "Le dossier de travail doit être un chemin.");
    const p = raw.trim();
    if (p.length > 1024 || p.includes("\0")) throw new HttpError(400, "Chemin de dossier de travail invalide.");
    if (!path.isAbsolute(p) || /^[\\/]{2}[?.][\\/]/.test(p))
      throw new HttpError(400, "Le dossier de travail doit être un chemin absolu (ex. C:\\Users\\moi\\MyClaude-workspace).");
    const dir = path.resolve(p);
    if (path.parse(dir).root === dir || path.parse(dir).root === dir + path.sep)
      throw new HttpError(400, "Le dossier de travail ne peut pas être la racine d'un disque.");
    // Le moteur peut lire tout le dossier de travail : il ne doit pas englober les données de MyClaude.
    const data = this.storage.dataDir;
    if (isInsideDir(data, dir) || isInsideDir(dir, data))
      throw new HttpError(400, "Le dossier de travail ne peut pas contenir les données de MyClaude (ni être dedans).");
    try {
      await fsp.mkdir(dir, { recursive: true });
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) throw new Error("pas un dossier");
    } catch {
      throw new HttpError(400, "Impossible de créer ou d'utiliser ce dossier de travail.");
    }
    return dir;
  }

  async putConfig(body: unknown): Promise<AppConfig> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Corps de requête invalide.");
    const b = body as { apiKey?: unknown; model?: unknown; effort?: unknown; authMode?: unknown; workspaceDir?: unknown };
    if (b.apiKey !== undefined && b.apiKey !== null && typeof b.apiKey !== "string")
      throw new HttpError(400, "La clé API doit être une chaîne de caractères.");
    if (typeof b.apiKey === "string" && b.apiKey.length > 512) throw new HttpError(400, "Clé API trop longue.");
    if (typeof b.apiKey === "string" && /\s/.test(b.apiKey.trim()))
      throw new HttpError(400, "La clé API ne doit pas contenir d'espaces.");
    if (b.model !== undefined && !AVAILABLE_MODELS.some((m) => m.id === b.model))
      throw new HttpError(400, "Modèle inconnu.");
    if (b.effort !== undefined && !EFFORTS.includes(b.effort as Effort))
      throw new HttpError(400, "Niveau d'effort inconnu (low, medium, high, xhigh ou max).");
    if (b.authMode !== undefined && !AUTH_MODES.includes(b.authMode as AuthMode))
      throw new HttpError(400, "Mode d'authentification inconnu (subscription ou apiKey).");
    const workspaceDir = b.workspaceDir !== undefined ? await this.validateWorkspaceDir(b.workspaceDir) : undefined;

    const before = await this.storage.readConfig();
    const after = await this.storage.updateConfig((cfg) => {
      const next = { ...cfg };
      if (b.apiKey === null || (typeof b.apiKey === "string" && !b.apiKey.trim())) delete next.apiKey;
      else if (typeof b.apiKey === "string") next.apiKey = b.apiKey.trim();
      if (typeof b.model === "string") next.model = b.model;
      if (typeof b.effort === "string") next.effort = b.effort as Effort;
      if (typeof b.authMode === "string") next.authMode = b.authMode as AuthMode;
      if (workspaceDir) next.workspaceDir = workspaceDir;
      return next;
    });
    // Identifiants modifiés : nouvel état moteur, et retenter les bilans en attente.
    if (authKey(after) !== authKey(before)) {
      this.statusCache = null;
      void this.reviews.scan().catch((e) => this.log.error("scan des bilans", e));
    }
    return this.getConfig();
  }

  // -------------------------------------------------------------- gouvernance

  getGovernance(): Promise<Governance> {
    return this.governance.read();
  }

  async putGovernance(body: unknown): Promise<Governance> {
    return this.governance.write(validateGovernancePatch(body));
  }

  // ---------------------------------------------------------------- sessions

  listSessions(): Promise<SessionMeta[]> {
    return this.storage.listSessions();
  }

  async createSession(body: unknown): Promise<SessionMeta> {
    const title = (body as { title?: unknown } | undefined)?.title;
    if (title !== undefined && typeof title !== "string") throw new HttpError(400, "Titre invalide.");
    const cfg = await this.storage.readConfig();
    return this.storage.createSession({ title, model: cfg.model });
  }

  async getSession(id: string): Promise<{ session: SessionMeta; messages: ChatMessage[] }> {
    const session = await this.requireSession(id);
    return { session, messages: await this.storage.readMessages(id) };
  }

  async deleteSession(id: string): Promise<void> {
    const meta = await this.requireSession(id);
    await this.abortActive(id, "session-closed");
    this.permissions.clearSession(id);
    await this.storage.deleteSession(id);
    // Transcription Claude Code correspondante : seulement si localisable de façon sûre
    // (ID exact de la session moteur, dans le dossier projet de son cwd).
    if (meta.engineSessionId && meta.engineCwd) {
      const provider = this.providerFactory(await this.storage.readConfig());
      await provider
        ?.deleteTranscript?.(meta.engineSessionId, meta.engineCwd)
        .catch(() => this.log.info(`session ${id} : transcription moteur non supprimée (introuvable)`));
    }
  }

  async heartbeat(id: string): Promise<void> {
    const meta = await this.requireSession(id);
    if (meta.status !== "open") return;
    await this.storage.updateMeta(id, (m) => {
      m.lastHeartbeat = nowIso();
    });
  }

  async closeSession(id: string): Promise<SessionMeta> {
    await this.requireSession(id);
    await this.abortActive(id, "session-closed");
    this.permissions.clearSession(id);
    const meta = await this.storage.closeSession(id, "user");
    this.reviews.enqueue(id);
    return meta;
  }

  private async requireSession(id: string): Promise<SessionMeta> {
    const meta = await this.storage.getMeta(id);
    if (!meta) throw new HttpError(404, "Session introuvable.");
    return meta;
  }

  private async abortActive(id: string, reason: AbortReason): Promise<void> {
    const a = this.active.get(id);
    if (!a) return;
    a.controller.abort(reason);
    await a.done.catch(() => {});
  }

  // ------------------------------------------------------------- permissions

  async respondPermission(sessionId: string, reqId: string, body: unknown): Promise<void> {
    const decision = (body as { decision?: unknown } | undefined)?.decision;
    if (decision !== "allow" && decision !== "deny" && decision !== "allow_session")
      throw new HttpError(400, "Décision invalide (allow, deny ou allow_session).");
    await this.requireSession(sessionId);
    if (!this.permissions.respond(sessionId, reqId, decision as PermissionDecision))
      throw new HttpError(404, "Demande de permission introuvable ou expirée.");
  }

  private async journalPermission(
    sessionId: string,
    e: { tool: string; input: unknown; decision: "allow" | "deny"; by: PermissionDecider; toolCallId?: string; reason?: string },
  ): Promise<void> {
    await this.storage
      .appendEvent(sessionId, { t: nowIso(), type: "permission", ...e, input: journalInput(e.input) })
      .catch((err) => this.log.error(`journal des permissions (${sessionId})`, err));
  }

  // ---------------------------------------------------------------- messages

  /**
   * Validation (lève HttpError avant tout événement SSE), puis diffusion.
   * Retourne une fois la réponse terminée et journalisée.
   */
  async sendMessage(id: string, body: unknown, sink: SseSink, clientSignal: AbortSignal): Promise<void> {
    const text = (body as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Le message est vide.");
    if (text.length > 500_000) throw new HttpError(413, "Message trop long.");
    if (this.stopped) throw new HttpError(503, "L'application est en cours de fermeture.");
    if (this.active.has(id)) throw new HttpError(409, "Une réponse est déjà en cours dans cette session.");

    // Réservation synchrone pour éviter deux flux concurrents sur la même session.
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.active.set(id, { controller, done });
    const onClientAbort = () => controller.abort("client" satisfies AbortReason);
    try {
      const meta = await this.storage.getMeta(id);
      if (!meta) throw new HttpError(404, "Session introuvable.");
      if (meta.status !== "open") throw new HttpError(409, "Cette session est close : ouvrez-en une nouvelle.");
      if (clientSignal.aborted) return;
      clientSignal.addEventListener("abort", onClientAbort, { once: true });
      await this.runExchange(meta, text, sink, controller.signal);
    } finally {
      clientSignal.removeEventListener("abort", onClientAbort);
      this.active.delete(id);
      resolveDone();
    }
  }

  /** Point de décision des permissions pour un échange (voir docs, v2 « Outils & permissions »). */
  private makeGate(
    sessionId: string,
    workspace: string,
    gov: Governance,
    tools: ToolTracker,
    sink: SseSink,
    signal: AbortSignal,
  ): ToolGate {
    const allowed = new Set(gov.tools.allowed);
    const hasAgents = Object.keys(gov.agents).length > 0;
    const isPermitted = (tool: string) =>
      allowed.has(tool) || tool.startsWith("mcp__") || (hasAgents && (tool === "Agent" || tool === "Task"));

    /** Règles 1 (hors dossier → refus) et outils hors gouvernance ; null si rien à refuser. */
    const hardDeny = (tool: string, input: unknown): string | null => {
      if (!isPermitted(tool)) return `L'outil ${tool} n'est pas autorisé par la gouvernance MyClaude.`;
      const chk = checkToolPaths(tool, input, workspace);
      if (!chk.ok) return `Accès refusé : « ${chk.path} » est en dehors du dossier de travail de MyClaude.`;
      return null;
    };

    const deny = async (tool: string, input: unknown, toolUseId: string, by: PermissionDecider, reason: string) => {
      tools.markDenied(toolUseId, tool, input, reason);
      await this.journalPermission(sessionId, { tool, input, decision: "deny", by, toolCallId: toolUseId, reason });
    };

    return {
      preToolUse: async (tool, input, toolUseId) => {
        const reason = hardDeny(tool, input);
        if (reason) {
          await deny(tool, input, toolUseId, "auto", reason);
          return { decision: "deny", reason };
        }
        if (READ_ONLY_TOOLS.has(tool)) {
          await this.journalPermission(sessionId, { tool, input, decision: "allow", by: "auto", toolCallId: toolUseId });
          return { decision: "allow" };
        }
        return { decision: "ask" }; // décision dans canUseTool
      },

      canUseTool: async (tool, input, { toolUseId, signal: sdkSignal }): Promise<ToolGateResult> => {
        const reason = hardDeny(tool, input);
        if (reason) {
          await deny(tool, input, toolUseId, "auto", reason);
          return { behavior: "deny", message: reason };
        }
        if (READ_ONLY_TOOLS.has(tool)) {
          await this.journalPermission(sessionId, { tool, input, decision: "allow", by: "auto", toolCallId: toolUseId });
          return { behavior: "allow" };
        }
        if (this.permissions.isSessionAllowed(sessionId, tool)) {
          await this.journalPermission(sessionId, { tool, input, decision: "allow", by: "session", toolCallId: toolUseId });
          tools.setStatus(toolUseId, tool, input, "running");
          return { behavior: "allow" };
        }
        tools.setStatus(toolUseId, tool, input, "pending_approval");
        const r: ResolvedDecision = await this.permissions.ask(
          { sessionId, toolCallId: toolUseId, tool, input, summary: summarizeToolCall(tool, input) },
          [signal, sdkSignal],
          (req: PermissionRequest) => sink("permission_request", req),
        );
        if (r.decision === "allow") {
          await this.journalPermission(sessionId, { tool, input, decision: "allow", by: r.by, toolCallId: toolUseId });
          tools.setStatus(toolUseId, tool, input, "running");
          return { behavior: "allow" };
        }
        const message =
          r.by === "timeout"
            ? "Refusé : pas de réponse de l'utilisateur dans le délai imparti."
            : r.by === "disconnect"
              ? "Refusé : l'interface s'est déconnectée."
              : "L'utilisateur a refusé cette action.";
        await deny(tool, input, toolUseId, r.by, message);
        return { behavior: "deny", message };
      },
    };
  }

  private async runExchange(meta: SessionMeta, text: string, sink: SseSink, signal: AbortSignal): Promise<void> {
    const id = meta.id;
    const history = await this.storage.readMessages(id);
    const userMsg: ChatMessage = { id: randomUUID(), role: "user", text, createdAt: nowIso() };
    await this.storage.appendMessage(id, userMsg);
    const cfg = await this.storage.readConfig();
    await this.storage.updateMeta(id, (m) => {
      const t = nowIso();
      m.updatedAt = t;
      m.lastHeartbeat = t;
      m.model = cfg.model;
      if (m.title === DEFAULT_TITLE && !history.some((h) => h.role === "user")) m.title = autoTitle(text);
    });
    sink("user", userMsg);

    let answer = "";
    let thinking = "";
    const tools = new ToolTracker(sink);
    const finish = async (extra: Partial<ChatMessage>): Promise<ChatMessage> => {
      const msg: ChatMessage = { id: randomUUID(), role: "assistant", text: answer, createdAt: nowIso() };
      if (thinking) msg.thinking = thinking;
      const calls = tools.finalize(!!extra.error);
      if (calls.length) msg.tools = calls;
      Object.assign(msg, extra);
      await this.storage.appendMessage(id, msg);
      await this.storage
        .updateMeta(id, (m) => {
          const t = nowIso();
          m.updatedAt = t;
          m.lastHeartbeat = t;
        })
        .catch((e) => {
          if (!(e instanceof NotFoundError)) throw e;
        });
      return msg;
    };

    const provider: Provider | null = this.providerFactory(cfg);
    if (!provider) {
      const msg = await finish({
        error:
          cfg.authMode === "apiKey"
            ? "Mode clé API : aucune clé API configurée. Ajoutez votre clé dans les Réglages."
            : "Moteur Claude indisponible.",
      });
      sink("error", { error: msg.error });
      return;
    }

    try {
      const gov = await this.governance.read();
      let workspace: string;
      try {
        await fsp.mkdir(cfg.workspaceDir, { recursive: true });
        workspace = canonicalize(cfg.workspaceDir);
      } catch {
        throw new ProviderError("bad_request", `Dossier de travail inutilisable : ${cfg.workspaceDir}`);
      }
      const memory = (await this.storage.readMemory()).trim();
      const base = gov.system.trim();
      const system = memory
        ? `${base}\n\n# Mémoire (préférences et leçons validées par l'utilisateur)\n\n${memory}`
        : base;
      const gate = this.makeGate(id, workspace, gov, tools, sink, signal);

      let sessionWrite: Promise<unknown> = Promise.resolve();
      const run = (prompt: string, resume: string | undefined): Promise<ProviderChatResult> =>
        provider.chat({
          model: cfg.model,
          effort: cfg.effort,
          system,
          prompt,
          resume,
          cwd: workspace,
          tools: gov.tools.allowed,
          mcpServers: gov.mcp.mcpServers,
          agents: gov.agents,
          gate,
          signal,
          onSessionId: (sid) => {
            sessionWrite = sessionWrite.then(() =>
              this.storage
                .updateMeta(id, (m) => {
                  m.engineSessionId = sid;
                  m.engineCwd = workspace;
                })
                .catch(() => {}),
            );
          },
          onThinking: (d) => {
            thinking += d;
            sink("thinking", { text: d });
          },
          onText: (d) => {
            answer += d;
            sink("delta", { text: d });
          },
          onToolUse: (call) => tools.onToolUse(call),
          onToolResult: (r) => tools.onToolResult(r),
        });

      // Reprise de la session moteur si elle existe ET a été créée dans le même dossier de travail.
      const resume =
        meta.engineSessionId && (!meta.engineCwd || meta.engineCwd === workspace) ? meta.engineSessionId : undefined;
      let result: ProviderChatResult;
      try {
        result = await run(resume ? text : buildPromptWithTranscript(history, text), resume);
      } catch (err) {
        if (!(err instanceof ProviderError && err.code === "resume_failed") || signal.aborted) throw err;
        this.log.warn(`session ${id} : reprise moteur impossible, nouvelle session avec la transcription`);
        await this.storage.updateMeta(id, (m) => {
          delete m.engineSessionId;
          delete m.engineCwd;
        });
        result = await run(buildPromptWithTranscript(history, text), undefined);
      }
      await sessionWrite;

      if (signal.aborted) throw new ProviderError("aborted", abortMessage(signal.reason));
      if (result.stopReason === "refusal") {
        const msg = await finish({ error: refusalMessage(result.refusalCategory), ...(result.usage ? { usage: result.usage } : {}) });
        sink("error", { error: msg.error });
        return;
      }
      const extra: Partial<ChatMessage> = {};
      if (result.usage) extra.usage = result.usage;
      if (result.stopReason === "max_tokens") extra.error = "Réponse tronquée : longueur maximale atteinte.";
      const msg = await finish(extra);
      sink("done", msg);
    } catch (err) {
      let message: string;
      if (signal.aborted) message = abortMessage(signal.reason);
      else if (err instanceof ProviderError) message = err.message;
      else {
        this.log.error(`session ${id} : erreur pendant la réponse`, err);
        message = "Erreur inattendue pendant la réponse.";
      }
      if (err instanceof ProviderError && (err.code === "not_logged_in" || err.code === "auth")) this.statusCache = null;
      const msg = await finish({ error: message });
      sink("error", { error: msg.error });
    }
  }

  // ----------------------------------------------------------------- leçons

  listLessons(status?: string): Promise<Lesson[]> {
    if (status !== undefined && !["pending", "approved", "rejected"].includes(status))
      throw new HttpError(400, "Filtre de statut invalide.");
    return this.storage.listLessons(status as Lesson["status"] | undefined);
  }

  async approveLesson(id: string, body: unknown): Promise<Lesson> {
    const edited = (body as { text?: unknown } | undefined)?.text;
    if (edited !== undefined && (typeof edited !== "string" || !edited.trim()))
      throw new HttpError(400, "Le texte de la leçon est vide.");
    const lesson = await this.storage.getLesson(id);
    if (!lesson) throw new HttpError(404, "Leçon introuvable.");
    if (lesson.status === "approved") return lesson;
    if (lesson.status === "rejected") throw new HttpError(409, "Cette leçon a déjà été rejetée.");
    const text = (typeof edited === "string" ? edited : lesson.text).replace(/\s+/g, " ").trim();
    // Mémoire d'abord (idempotent : pas de doublon si la ligne y est déjà), puis statut.
    const line = `- ${text}`;
    const memory = await this.storage.readMemory();
    if (!memory.split(/\r?\n/).includes(line)) await this.storage.appendMemoryLine(line);
    return this.storage.updateLesson(id, (l) => ({ ...l, text, status: "approved" }));
  }

  async rejectLesson(id: string): Promise<Lesson> {
    const lesson = await this.storage.getLesson(id);
    if (!lesson) throw new HttpError(404, "Leçon introuvable.");
    if (lesson.status === "rejected") return lesson;
    if (lesson.status === "approved") throw new HttpError(409, "Cette leçon a déjà été approuvée.");
    return this.storage.updateLesson(id, (l) => ({ ...l, status: "rejected" }));
  }

  // ----------------------------------------------------------------- mémoire

  async getMemory(): Promise<{ content: string }> {
    return { content: await this.storage.readMemory() };
  }

  async putMemory(body: unknown): Promise<{ content: string }> {
    const content = (body as { content?: unknown } | undefined)?.content;
    if (typeof content !== "string") throw new HttpError(400, "Contenu de mémoire invalide.");
    if (content.length > 1_000_000) throw new HttpError(413, "Mémoire trop volumineuse.");
    return { content: await this.storage.writeMemory(content) };
  }
}

/** Suivi des appels d'outils d'une réponse (ordre d'apparition) et émission SSE. */
class ToolTracker {
  private readonly calls = new Map<string, ToolCall>();

  constructor(private readonly sink: SseSink) {}

  private upsert(id: string, name: string, input: unknown): { call: ToolCall; created: boolean } {
    let call = this.calls.get(id);
    if (call) return { call, created: false };
    call = { id, name, input, status: "running" };
    this.calls.set(id, call);
    return { call, created: true };
  }

  onToolUse(c: { id: string; name: string; input: unknown }): void {
    const { call, created } = this.upsert(c.id, c.name, c.input);
    call.input = c.input;
    if (created) this.sink("tool_use", { ...call });
  }

  setStatus(id: string, name: string, input: unknown, status: "running" | "pending_approval"): void {
    const { call, created } = this.upsert(id, name, input);
    if (call.status === "done" || call.status === "error" || call.status === "denied") return;
    call.status = status;
    // Un seul tool_use par appel (contrat web) : les changements de statut ultérieurs passent
    // par permission_request puis tool_result.
    if (created) this.sink("tool_use", { ...call });
  }

  markDenied(id: string, name: string, input: unknown, reason: string): void {
    const { call, created } = this.upsert(id, name, input);
    if (created) this.sink("tool_use", { ...call });
    if (call.status === "denied") return;
    call.status = "denied";
    call.resultPreview = reason.slice(0, PREVIEW_MAX);
    this.sink("tool_result", { id, status: call.status, resultPreview: call.resultPreview });
  }

  onToolResult(r: { id: string; isError: boolean; preview: string }): void {
    const call = this.calls.get(r.id);
    if (!call) return; // résultat d'un outil inconnu (ex. interne) : ignoré
    if (call.status === "denied") return; // déjà signalé
    call.status = r.isError ? "error" : "done";
    call.resultPreview = r.preview.slice(0, PREVIEW_MAX);
    this.sink("tool_result", { id: r.id, status: call.status, resultPreview: call.resultPreview });
  }

  /** Liste finale ; un appel resté en attente est refusé, un appel en cours est clos selon l'issue. */
  finalize(failed: boolean): ToolCall[] {
    const out: ToolCall[] = [];
    for (const c of this.calls.values()) {
      if (c.status === "pending_approval") c.status = "denied";
      else if (c.status === "running" && failed) {
        c.status = "error";
        c.resultPreview ??= "Interrompu.";
      } else if (c.status === "running") c.status = "done";
      out.push({ ...c });
    }
    return out;
  }
}
