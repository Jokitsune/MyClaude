import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { Logger } from "./log.js";
import { ProviderError, type ProviderFactory, type ProviderMessage } from "./providers/types.js";
import { refusalMessage } from "./providers/anthropic.js";
import { ReviewQueue } from "./review.js";
import { NotFoundError, nowIso, type Storage } from "./storage.js";
import {
  AVAILABLE_MODELS,
  DEFAULT_TITLE,
  EFFORTS,
  type AppConfig,
  type ChatMessage,
  type Effort,
  type Lesson,
  type SessionMeta,
} from "./types.js";

export const HEARTBEAT_STALE_MS = 2 * 60_000; // démarrage : open + heartbeat > 2 min → interrupted
export const IDLE_TIMEOUT_MS = 30 * 60_000; // inactivité → closed (idle)
export const IDLE_CHECK_INTERVAL_MS = 60_000;

const BASE_SYSTEM_PROMPT = [
  "Tu es Claude, l'assistant personnel de l'utilisateur dans MyClaude, son interface privée et locale.",
  "Réponds en français (sauf demande contraire), de façon claire et concise.",
  "Utilise le Markdown quand il aide la lecture (listes, titres, tableaux, blocs de code avec le langage).",
].join("\n");

export type SseSink = (event: "user" | "thinking" | "delta" | "done" | "error", data: unknown) => void;

type AbortReason = "client" | "app-quit" | "session-closed";

interface ActiveStream {
  controller: AbortController;
  done: Promise<void>;
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

/** Historique envoyé au modèle : texte uniquement, en commençant par un message utilisateur. */
export function toProviderHistory(messages: ChatMessage[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const m of messages) {
    if (!m.text.trim()) continue; // ex. réponse en échec sans texte
    if (!out.length && m.role !== "user") continue;
    out.push({ role: m.role, text: m.text });
  }
  return out;
}

export class AppService {
  readonly reviews: ReviewQueue;
  private readonly active = new Map<string, ActiveStream>();
  private idleTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    readonly storage: Storage,
    private readonly providerFactory: ProviderFactory,
    private readonly log: Logger,
  ) {
    this.reviews = new ReviewQueue(storage, providerFactory, log);
  }

  // ------------------------------------------------------------ cycle de vie

  /** Récupération au démarrage puis lancement des tâches de fond. */
  async start(opts: { idleCheck?: boolean } = {}): Promise<void> {
    await this.storage.init();
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

  // ------------------------------------------------------------------ config

  async getConfig(): Promise<AppConfig> {
    const cfg = await this.storage.readConfig();
    return {
      hasApiKey: !!cfg.apiKey,
      model: cfg.model,
      effort: cfg.effort,
      dataDir: this.storage.dataDir,
      availableModels: AVAILABLE_MODELS.map((m) => ({ ...m })),
    };
  }

  async putConfig(body: unknown): Promise<AppConfig> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Corps de requête invalide.");
    const b = body as { apiKey?: unknown; model?: unknown; effort?: unknown };
    if (b.apiKey !== undefined && b.apiKey !== null && typeof b.apiKey !== "string")
      throw new HttpError(400, "La clé API doit être une chaîne de caractères.");
    if (typeof b.apiKey === "string" && b.apiKey.length > 512) throw new HttpError(400, "Clé API trop longue.");
    if (typeof b.apiKey === "string" && /\s/.test(b.apiKey.trim()))
      throw new HttpError(400, "La clé API ne doit pas contenir d'espaces.");
    if (b.model !== undefined && !AVAILABLE_MODELS.some((m) => m.id === b.model))
      throw new HttpError(400, "Modèle inconnu.");
    if (b.effort !== undefined && !EFFORTS.includes(b.effort as Effort))
      throw new HttpError(400, "Niveau d'effort inconnu (low, medium, high, xhigh ou max).");

    const before = await this.storage.readConfig();
    const after = await this.storage.updateConfig((cfg) => {
      const next = { ...cfg };
      if (b.apiKey === null || (typeof b.apiKey === "string" && !b.apiKey.trim())) delete next.apiKey;
      else if (typeof b.apiKey === "string") next.apiKey = b.apiKey.trim();
      if (typeof b.model === "string") next.model = b.model;
      if (typeof b.effort === "string") next.effort = b.effort as Effort;
      return next;
    });
    // Une clé vient d'être ajoutée/modifiée : retenter les bilans en attente.
    if (after.apiKey && after.apiKey !== before.apiKey) {
      void this.reviews.scan().catch((e) => this.log.error("scan des bilans", e));
    }
    return this.getConfig();
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
    await this.requireSession(id);
    await this.abortActive(id, "session-closed");
    await this.storage.deleteSession(id);
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
    const finish = async (extra: Partial<ChatMessage>): Promise<ChatMessage> => {
      const msg: ChatMessage = { id: randomUUID(), role: "assistant", text: answer, createdAt: nowIso() };
      if (thinking) msg.thinking = thinking;
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

    const provider = this.providerFactory(cfg);
    if (!provider) {
      const msg = await finish({ error: "Aucune clé API configurée. Ajoutez votre clé dans les Réglages." });
      sink("error", { error: msg.error });
      return;
    }

    try {
      const memory = (await this.storage.readMemory()).trim();
      const system = memory
        ? `${BASE_SYSTEM_PROMPT}\n\n# Mémoire (préférences et leçons validées par l'utilisateur)\n\n${memory}`
        : BASE_SYSTEM_PROMPT;
      const result = await provider.chat({
        model: cfg.model,
        effort: cfg.effort,
        system,
        messages: toProviderHistory([...history, userMsg]),
        signal,
        onThinking: (d) => {
          thinking += d;
          sink("thinking", { text: d });
        },
        onText: (d) => {
          answer += d;
          sink("delta", { text: d });
        },
      });
      if (signal.aborted) throw new ProviderError("aborted", abortMessage(signal.reason));
      if (result.stopReason === "refusal") {
        const msg = await finish({ error: refusalMessage(result.refusalCategory), usage: result.usage });
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
