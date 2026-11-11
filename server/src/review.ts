import type { Logger } from "./log.js";
import { ProviderError, RETRY_LATER_CODES, type ProviderFactory } from "./providers/types.js";
import type { Storage } from "./storage.js";
import type { ChatMessage, Lesson } from "./types.js";

const MAX_LESSONS = 5;
const MAX_TRANSCRIPT_CHARS = 200_000;
const KINDS: readonly Lesson["kind"][] = ["preference", "mistake", "success", "fact"];

export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    lessons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...KINDS] },
          text: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["kind", "text", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["lessons"],
  additionalProperties: false,
};

const REVIEW_SYSTEM = [
  "Tu fais le bilan d'une conversation passée entre l'utilisateur et Claude, son assistant personnel.",
  "Objectif : proposer de 0 à 5 leçons durables qui amélioreront les futures conversations avec cet utilisateur.",
  "Types de leçons :",
  "- preference : une préférence de l'utilisateur (style, format, langue, outils…) ;",
  "- mistake : une erreur de l'assistant à ne pas reproduire ;",
  "- success : une approche qui a bien fonctionné et qu'il faut refaire ;",
  "- fact : un fait stable sur l'utilisateur ou son contexte, utile plus tard.",
  "Règles : chaque leçon tient en une phrase actionnable, en français, formulée comme une consigne pour l'assistant.",
  "N'invente rien : ne retiens que ce que la conversation montre clairement. Ignore les détails ponctuels sans valeur future.",
  "Ne propose pas une leçon déjà présente dans la mémoire actuelle. S'il n'y a rien d'utile, renvoie une liste vide.",
  "Ne recopie jamais de secret (clé, mot de passe, donnée sensible) dans une leçon.",
].join("\n");

export function hasExchange(messages: ChatMessage[]): boolean {
  return (
    messages.some((m) => m.role === "user" && m.text.trim()) &&
    messages.some((m) => m.role === "assistant" && m.text.trim())
  );
}

function buildTranscript(messages: ChatMessage[]): string {
  const parts = messages
    .filter((m) => m.text.trim())
    .map((m) => `${m.role === "user" ? "Utilisateur" : "Claude"} :\n${m.text.trim()}`);
  let transcript = parts.join("\n\n---\n\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = "[… début de la conversation tronqué …]\n\n" + transcript.slice(-MAX_TRANSCRIPT_CHARS);
  }
  return transcript;
}

function parseLessons(raw: unknown): { kind: Lesson["kind"]; text: string; rationale: string }[] {
  const list = (raw as { lessons?: unknown })?.lessons;
  if (!Array.isArray(list)) throw new ProviderError("invalid_output", "Le bilan renvoyé n'a pas le format attendu.");
  const out: { kind: Lesson["kind"]; text: string; rationale: string }[] = [];
  for (const item of list) {
    const it = item as { kind?: unknown; text?: unknown; rationale?: unknown };
    if (typeof it?.text !== "string" || !it.text.trim()) continue;
    const kind = KINDS.includes(it.kind as Lesson["kind"]) ? (it.kind as Lesson["kind"]) : "fact";
    out.push({
      kind,
      text: it.text.trim().slice(0, 1000),
      rationale: typeof it.rationale === "string" ? it.rationale.trim().slice(0, 2000) : "",
    });
    if (out.length >= MAX_LESSONS) break;
  }
  return out;
}

/**
 * File de bilans : une session à la fois, sans doublon, idempotente
 * (`done` n'est jamais refait ; une session `open` n'est jamais traitée).
 */
export class ReviewQueue {
  private queue: string[] = [];
  private queued = new Set<string>();
  private current: string | null = null;
  private currentAbort: AbortController | null = null;
  private pumping: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly storage: Storage,
    private readonly providerFactory: ProviderFactory,
    private readonly log: Logger,
  ) {}

  enqueue(id: string): void {
    if (this.stopped || this.queued.has(id) || this.current === id) return;
    this.queued.add(id);
    this.queue.push(id);
    if (!this.pumping) this.pumping = this.pump().finally(() => (this.pumping = null));
  }

  /** Met en file toutes les sessions éligibles (non `open`, bilan `pending`/`failed`). */
  async scan(): Promise<void> {
    const sessions = await this.storage.listSessions();
    // Les plus anciennes d'abord.
    for (const s of sessions.reverse()) {
      if (s.status !== "open" && (s.review === "pending" || s.review === "failed")) this.enqueue(s.id);
    }
  }

  /** Attend que la file soit vide (tests). */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queue = [];
    this.queued.clear();
    this.currentAbort?.abort();
    await this.idle();
  }

  private async pump(): Promise<void> {
    while (this.queue.length && !this.stopped) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      this.current = id;
      try {
        await this.reviewOne(id);
      } catch (err) {
        this.log.error(`bilan ${id} : erreur inattendue`, err);
      } finally {
        this.current = null;
        this.currentAbort = null;
      }
    }
  }

  private async reviewOne(id: string): Promise<void> {
    const meta = await this.storage.getMeta(id);
    if (!meta || meta.status === "open") return;
    if (meta.review === "done" || meta.review === "running") return;

    const messages = await this.storage.readMessages(id);
    if (!hasExchange(messages)) {
      // Rien à analyser : bilan terminé sans leçon.
      await this.storage.updateMeta(id, (m) => {
        m.review = "done";
        delete m.reviewError;
      });
      return;
    }

    const config = await this.storage.readConfig();
    const provider = this.providerFactory(config);
    if (!provider) return; // Mode clé API sans clé : reste `pending`, sera retenté.

    await this.storage.updateMeta(id, (m) => {
      m.review = "running";
      delete m.reviewError;
    });

    const abort = new AbortController();
    this.currentAbort = abort;
    try {
      // Leçons `pending` d'une tentative précédente interrompue : remplacées.
      for (const l of await this.storage.listLessons("pending")) {
        if (l.sessionId === id) await this.storage.deleteLesson(l.id);
      }
      const memory = (await this.storage.readMemory()).trim();
      const prompt =
        `Mémoire actuelle (déjà validée) :\n${memory || "(vide)"}\n\n` +
        `Transcription de la conversation :\n\n${buildTranscript(messages)}\n\n` +
        `Propose les leçons (0 à ${MAX_LESSONS}) au format JSON demandé.`;
      const raw = await provider.generateJson({
        model: config.model,
        effort: "medium",
        system: REVIEW_SYSTEM,
        prompt,
        schema: REVIEW_SCHEMA,
        signal: abort.signal,
      });
      const lessons = parseLessons(raw);
      if (!(await this.storage.getMeta(id))) return; // session supprimée entre-temps
      for (const l of lessons) await this.storage.createLesson({ sessionId: id, ...l });
      await this.storage.updateMeta(id, (m) => {
        m.review = "done";
        delete m.reviewError;
      });
      this.log.info(`bilan ${id} : ${lessons.length} leçon(s) proposée(s)`);
    } catch (err) {
      if (!(await this.storage.getMeta(id))) return;
      const aborted = abort.signal.aborted || (err instanceof ProviderError && err.code === "aborted");
      // Pas de clé / pas connecté / Claude Code absent : reste `pending`, retenté plus tard.
      const noKey = err instanceof ProviderError && RETRY_LATER_CODES.has(err.code);
      const message =
        err instanceof ProviderError ? err.message : "Erreur inattendue pendant le bilan.";
      await this.storage.updateMeta(id, (m) => {
        if (aborted || noKey) {
          m.review = "pending";
        } else {
          m.review = "failed";
          m.reviewError = message;
        }
      });
      if (!aborted) this.log.warn(`bilan ${id} échoué : ${message}`);
    }
  }
}
