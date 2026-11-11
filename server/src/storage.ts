import { randomBytes, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AUTH_MODES,
  AVAILABLE_MODELS,
  DEFAULT_AUTH_MODE,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TITLE,
  EFFORTS,
  type ChatMessage,
  type CloseReason,
  type Lesson,
  type SessionEvent,
  type SessionMeta,
  type StoredConfig,
} from "./types.js";
import { KeyedMutex, appendJsonLine, atomicWrite, atomicWriteJson, readJson, readJsonLines } from "./fsutil.js";

/** Format des identifiants de session : "2026-11-11_143207_ab12". Aucune traversée de chemin possible. */
const SESSION_ID_RE = /^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{4,8}$/;
/** Identifiants de leçon (UUID). */
const LESSON_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}
export function isValidLessonId(id: string): boolean {
  return LESSON_ID_RE.test(id);
}

export class NotFoundError extends Error {}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function newSessionId(d = new Date()): string {
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}_${randomBytes(2).toString("hex")}`;
}

/** Dossier de travail par défaut : %USERPROFILE%\MyClaude-workspace. */
export function defaultWorkspaceDir(): string {
  return path.join(os.homedir(), "MyClaude-workspace");
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Accès disque (dataDir). Toutes les opérations lecture-modification-écriture
 * passent par un verrou par ressource pour éviter les écritures perdues.
 */
export class Storage {
  readonly sessionsDir: string;
  readonly lessonsDir: string;
  readonly configFile: string;
  readonly memoryFile: string;
  private readonly lock = new KeyedMutex();

  constructor(
    readonly dataDir: string,
    /** Dossier de travail utilisé tant que config.json n'en définit pas (injectable pour les tests). */
    readonly defaultWorkspace: string = defaultWorkspaceDir(),
  ) {
    this.sessionsDir = path.join(dataDir, "sessions");
    this.lessonsDir = path.join(dataDir, "lessons");
    this.configFile = path.join(dataDir, "config.json");
    this.memoryFile = path.join(dataDir, "memory.md");
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.sessionsDir, { recursive: true });
    await fsp.mkdir(this.lessonsDir, { recursive: true });
  }

  // ---------------------------------------------------------------- config

  async readConfig(): Promise<StoredConfig> {
    const raw = (await readJson<Partial<StoredConfig>>(this.configFile)) ?? {};
    const model = AVAILABLE_MODELS.some((m) => m.id === raw.model) ? raw.model! : DEFAULT_MODEL;
    const effort = raw.effort && EFFORTS.includes(raw.effort) ? raw.effort : DEFAULT_EFFORT;
    const authMode = raw.authMode && AUTH_MODES.includes(raw.authMode) ? raw.authMode : DEFAULT_AUTH_MODE;
    const workspaceDir =
      typeof raw.workspaceDir === "string" && path.isAbsolute(raw.workspaceDir) ? raw.workspaceDir : this.defaultWorkspace;
    const cfg: StoredConfig = { model, effort, authMode, workspaceDir };
    if (typeof raw.apiKey === "string" && raw.apiKey.trim()) cfg.apiKey = raw.apiKey.trim();
    return cfg;
  }

  updateConfig(patch: (cfg: StoredConfig) => StoredConfig): Promise<StoredConfig> {
    return this.lock.run("config", async () => {
      const next = patch(await this.readConfig());
      await atomicWriteJson(this.configFile, next);
      return next;
    });
  }

  // ---------------------------------------------------------------- memory

  async readMemory(): Promise<string> {
    try {
      return await fsp.readFile(this.memoryFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  writeMemory(content: string): Promise<string> {
    return this.lock.run("memory", async () => {
      await atomicWrite(this.memoryFile, content);
      return content;
    });
  }

  appendMemoryLine(line: string): Promise<string> {
    return this.lock.run("memory", async () => {
      let content = await this.readMemory();
      if (content && !content.endsWith("\n")) content += "\n";
      content += line + "\n";
      await atomicWrite(this.memoryFile, content);
      return content;
    });
  }

  // -------------------------------------------------------------- sessions

  private sessionDir(id: string): string {
    if (!isValidSessionId(id)) throw new NotFoundError("Session introuvable.");
    return path.join(this.sessionsDir, id);
  }
  private metaFile(id: string) {
    return path.join(this.sessionDir(id), "meta.json");
  }
  private eventsFile(id: string) {
    return path.join(this.sessionDir(id), "events.jsonl");
  }

  async createSession(opts: { title?: string; model: string }): Promise<SessionMeta> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = newSessionId();
      const dir = path.join(this.sessionsDir, id);
      try {
        await fsp.mkdir(dir, { recursive: false });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
      const t = nowIso();
      const title = opts.title?.trim().slice(0, 120);
      const meta: SessionMeta = {
        id,
        title: title || DEFAULT_TITLE,
        status: "open",
        createdAt: t,
        updatedAt: t,
        lastHeartbeat: t,
        model: opts.model,
        review: "pending",
      };
      await atomicWriteJson(path.join(dir, "meta.json"), meta);
      return meta;
    }
    throw new Error("Impossible de créer un identifiant de session unique.");
  }

  async getMeta(id: string): Promise<SessionMeta | undefined> {
    if (!isValidSessionId(id)) return undefined;
    return readJson<SessionMeta>(this.metaFile(id));
  }

  async requireMeta(id: string): Promise<SessionMeta> {
    const meta = await this.getMeta(id);
    if (!meta) throw new NotFoundError("Session introuvable.");
    return meta;
  }

  /** Lecture-modification-écriture atomique et sérialisée de meta.json. */
  updateMeta(id: string, fn: (meta: SessionMeta) => SessionMeta | void): Promise<SessionMeta> {
    return this.lock.run(`session:${id}`, async () => {
      const meta = await this.requireMeta(id);
      const next = fn(meta) ?? meta;
      await atomicWriteJson(this.metaFile(id), next);
      return next;
    });
  }

  async listSessions(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.sessionsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const metas: SessionMeta[] = [];
    for (const name of names) {
      if (!isValidSessionId(name)) continue;
      const meta = await readJson<SessionMeta>(path.join(this.sessionsDir, name, "meta.json"));
      if (meta && meta.id === name) metas.push(meta);
    }
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return metas;
  }

  appendEvent(id: string, event: SessionEvent): Promise<void> {
    return this.lock.run(`events:${id}`, () => appendJsonLine(this.eventsFile(id), event));
  }

  async readEvents(id: string): Promise<SessionEvent[]> {
    const lines = await readJsonLines<SessionEvent>(this.eventsFile(id));
    return lines.filter((e) => e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string");
  }

  async readMessages(id: string): Promise<ChatMessage[]> {
    const events = await this.readEvents(id);
    const out: ChatMessage[] = [];
    for (const e of events) {
      if (e.type === "message" && e.message && typeof e.message.id === "string") out.push(e.message);
    }
    return out;
  }

  async appendMessage(id: string, message: ChatMessage): Promise<void> {
    await this.appendEvent(id, { t: nowIso(), type: "message", message });
  }

  /** Clôt une session ouverte (no-op si déjà close). Renvoie la meta à jour. */
  async closeSession(id: string, reason: CloseReason, status: "closed" | "interrupted" = "closed"): Promise<SessionMeta> {
    let changed = false;
    const meta = await this.updateMeta(id, (m) => {
      if (m.status !== "open") return m;
      changed = true;
      m.status = status;
      m.closeReason = reason;
      m.updatedAt = nowIso();
      return m;
    });
    if (changed) await this.appendEvent(id, { t: nowIso(), type: "closed", reason });
    return meta;
  }

  async deleteSession(id: string): Promise<void> {
    const dir = this.sessionDir(id);
    await this.lock.run(`session:${id}`, () => fsp.rm(dir, { recursive: true, force: true }));
    const lessons = await this.listLessons();
    for (const l of lessons) {
      if (l.sessionId === id && l.status === "pending") await this.deleteLesson(l.id);
    }
  }

  // --------------------------------------------------------------- lessons

  private lessonFile(id: string): string {
    if (!isValidLessonId(id)) throw new NotFoundError("Leçon introuvable.");
    return path.join(this.lessonsDir, `${id}.json`);
  }

  async listLessons(status?: Lesson["status"]): Promise<Lesson[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.lessonsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Lesson[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!isValidLessonId(id)) continue;
      const lesson = await readJson<Lesson>(path.join(this.lessonsDir, name));
      if (lesson && lesson.id === id && (!status || lesson.status === status)) out.push(lesson);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out;
  }

  async createLesson(input: Omit<Lesson, "id" | "createdAt" | "status">): Promise<Lesson> {
    const lesson: Lesson = { id: randomUUID(), createdAt: nowIso(), status: "pending", ...input };
    await atomicWriteJson(this.lessonFile(lesson.id), lesson);
    return lesson;
  }

  async getLesson(id: string): Promise<Lesson | undefined> {
    if (!isValidLessonId(id)) return undefined;
    return readJson<Lesson>(this.lessonFile(id));
  }

  updateLesson(id: string, fn: (l: Lesson) => Lesson): Promise<Lesson> {
    return this.lock.run(`lesson:${id}`, async () => {
      const lesson = await this.getLesson(id);
      if (!lesson) throw new NotFoundError("Leçon introuvable.");
      const next = fn(lesson);
      await atomicWriteJson(this.lessonFile(id), next);
      return next;
    });
  }

  async deleteLesson(id: string): Promise<void> {
    await this.lock.run(`lesson:${id}`, () => fsp.rm(this.lessonFile(id), { force: true }));
  }
}
