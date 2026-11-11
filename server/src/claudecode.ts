import { randomUUID } from "node:crypto";
import { createReadStream, promises as fsp, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CcProject, CcSessionSummary, CcTranscript, ChatMessage, ToolCall } from "./types.js";

/**
 * v3 — Lecture SEULE des sessions Claude Code locales
 * (`<CLAUDE_CONFIG_DIR ou ~/.claude>/projects/<projet>/<sessionId>.jsonl`).
 *
 * Le SDK expose `listSessions` / `getSessionMessages`, mais ni l'identifiant du dossier projet,
 * ni le nombre de messages, ni les résultats d'outils exploitables, ni de limite de taille :
 * on parse donc le JSONL nous-mêmes, en flux, de façon tolérante (lignes invalides ignorées),
 * avec un plafond d'octets lus. Aucune écriture n'est jamais faite ici.
 */

export const PREVIEW_MAX = 2000;
/** Octets lus au maximum par transcription (au-delà : `truncated`). */
export const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;
/** Messages convertis au maximum par transcription (au-delà : `truncated`). */
export const MAX_TRANSCRIPT_MESSAGES = 5000;
/** Octets lus pour retrouver le `cwd` d'un projet. */
const HEAD_BYTES = 256 * 1024;
const TITLE_MAX = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Noms de dossiers projet Claude Code (chemin « assaini ») : pas de séparateur, pas de `..`. */
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,255}$/;

export function isValidCcSessionId(id: string): boolean {
  return UUID_RE.test(id);
}
export function isValidCcProjectId(id: string): boolean {
  return PROJECT_ID_RE.test(id) && id !== "." && id !== ".." && !/^\.+$/.test(id);
}

/** Dossier `projects` de Claude Code (lu à chaque appel : CLAUDE_CONFIG_DIR peut être défini par les tests). */
export function defaultClaudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(path.resolve(base), "projects");
}

/** Balises des entrées utilisateur techniques (commandes locales, notifications, rappels système). */
const TECHNICAL_TAGS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "task-notification",
  "system-reminder",
  "user-prompt-submit-hook",
];
const TECHNICAL_RE = new RegExp(`^\\s*<(${TECHNICAL_TAGS.join("|")})[\\s>]`);

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Copie bornée d'une entrée d'outil (chaînes tronquées, profondeur/largeur limitées). */
export function boundedInput(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return input.length > PREVIEW_MAX ? input.slice(0, PREVIEW_MAX) + "…" : input;
  if (depth > 4 || input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.slice(0, 50).map((v) => boundedInput(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input).slice(0, 50)) out[k] = boundedInput(v, depth + 1);
  return out;
}

/** Aperçu texte d'un résultat d'outil (chaîne ou blocs). */
export function resultPreview(content: unknown): string {
  let s: string;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    s = content
      .map((b) => {
        const block = b as { type?: unknown; text?: unknown };
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        if (block?.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else if (content === undefined || content === null) s = "";
  else {
    try {
      s = JSON.stringify(content);
    } catch {
      s = "";
    }
  }
  return truncate(s, PREVIEW_MAX);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function textOfUser(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

/**
 * Convertisseur incrémental : une ligne JSON → mise à jour des messages.
 * Modèle « tour » : un message utilisateur réel ouvre un tour ; toutes les entrées assistant
 * jusqu'au suivant forment UN message assistant (texte, réflexion, outils), comme dans MyClaude.
 */
export class TranscriptBuilder {
  readonly messages: ChatMessage[] = [];
  cwd: string | null = null;
  gitBranch: string | null = null;
  startedAt: string | null = null;
  updatedAt: string | null = null;
  firstPrompt: string | null = null;
  customTitle: string | null = null;
  summary: string | null = null;
  aiTitle: string | null = null;
  /** Limite de messages atteinte. */
  full = false;
  private current: ChatMessage | null = null;
  private readonly tools = new Map<string, ToolCall>();

  constructor(private readonly maxMessages = MAX_TRANSCRIPT_MESSAGES) {}

  get title(): string {
    const t = this.customTitle || this.summary || this.aiTitle || this.firstPrompt || "Session sans titre";
    return truncate(t.replace(/\s+/g, " ").trim(), TITLE_MAX) || "Session sans titre";
  }

  private push(m: ChatMessage): boolean {
    if (this.messages.length >= this.maxMessages) {
      this.full = true;
      return false;
    }
    this.messages.push(m);
    return true;
  }

  private stamp(ts: string | undefined) {
    if (!ts || Number.isNaN(Date.parse(ts))) return;
    if (!this.startedAt || ts < this.startedAt) this.startedAt = ts;
    if (!this.updatedAt || ts > this.updatedAt) this.updatedAt = ts;
  }

  /** Ligne brute (texte) ; ignore silencieusement tout ce qui n'est pas un objet JSON exploitable. */
  addLine(line: string): void {
    const t = line.trim();
    if (!t || t[0] !== "{") return;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      return;
    }
    if (isObj(o)) this.addEntry(o);
  }

  addEntry(o: Obj): void {
    const type = o.type;
    // Titres / résumés (entrées techniques, jamais affichées comme messages).
    if (type === "custom-title" && str(o.customTitle)) this.customTitle = o.customTitle as string;
    if (type === "summary" && str(o.summary)) this.summary = o.summary as string;
    if (type === "ai-title" && str(o.aiTitle)) this.aiTitle = o.aiTitle as string;
    if (type !== "user" && type !== "assistant") return;
    if (o.isSidechain === true) return; // sous-agents
    if (str(o.cwd)) this.cwd = o.cwd as string;
    if (typeof o.gitBranch === "string" && o.gitBranch) this.gitBranch = o.gitBranch;
    const msg = isObj(o.message) ? o.message : null;
    if (!msg) return;
    const ts = str(o.timestamp);
    const createdAt = ts && !Number.isNaN(Date.parse(ts)) ? ts : (this.updatedAt ?? new Date(0).toISOString());

    if (type === "user") {
      if (o.isMeta === true || o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) return;
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!isObj(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          const call = this.tools.get(b.tool_use_id);
          if (!call) continue;
          call.status = b.is_error === true ? "error" : "done";
          call.resultPreview = resultPreview(b.content);
        }
      }
      const text = textOfUser(content);
      if (!text.trim() || TECHNICAL_RE.test(text)) return;
      this.stamp(ts);
      this.current = null;
      this.firstPrompt ??= text;
      this.push({ id: str(o.uuid) ?? randomUUID(), role: "user", text, createdAt });
      return;
    }

    // assistant
    this.stamp(ts);
    const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
    if (!this.current) {
      const m: ChatMessage = { id: str(o.uuid) ?? randomUUID(), role: "assistant", text: "", createdAt };
      if (!this.push(m)) return;
      this.current = m;
    }
    const cur = this.current;
    if (o.isApiErrorMessage === true) {
      const errText = blocks
        .filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      cur.error = truncate(errText || "Erreur de l'API.", 500);
      return;
    }
    for (const b of blocks) {
      if (!isObj(b)) continue;
      if (b.type === "text" && typeof b.text === "string" && b.text) {
        cur.text = cur.text ? `${cur.text}\n\n${b.text}` : b.text;
      } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
        cur.thinking = cur.thinking ? `${cur.thinking}\n\n${b.thinking}` : b.thinking;
      } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        if (this.tools.has(b.id)) continue;
        const call: ToolCall = { id: b.id, name: b.name, input: boundedInput(b.input), status: "done" };
        this.tools.set(b.id, call);
        (cur.tools ??= []).push(call);
      }
    }
  }
}

export interface ParsedFile {
  builder: TranscriptBuilder;
  truncated: boolean;
}

/** Parse en flux un fichier JSONL, en ne lisant au plus que `maxBytes`. */
export async function parseTranscriptFile(
  file: string,
  size: number,
  opts: { maxBytes?: number; maxMessages?: number } = {},
): Promise<ParsedFile> {
  const maxBytes = opts.maxBytes ?? MAX_TRANSCRIPT_BYTES;
  const builder = new TranscriptBuilder(opts.maxMessages);
  const cut = size > maxBytes;
  const stream = createReadStream(file, { encoding: "utf8", ...(cut ? { end: maxBytes - 1 } : {}) });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      builder.addLine(line);
      if (builder.full) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { builder, truncated: cut || builder.full };
}

/** Premier `cwd` trouvé dans le début d'un fichier (lecture bornée). */
async function readHeadCwd(file: string): Promise<string | null> {
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    for (const line of buf.toString("utf8", 0, bytesRead).split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        const o = JSON.parse(line) as Obj;
        if (typeof o.cwd === "string" && o.cwd) return o.cwd;
      } catch {
        // ligne coupée / invalide
      }
    }
  } catch {
    // illisible
  } finally {
    await fh?.close().catch(() => {});
  }
  return null;
}

export class CcNotFoundError extends Error {}

interface CacheEntry {
  key: string;
  summary: Omit<CcSessionSummary, "fromMyClaude">;
}

/** Accès en lecture seule aux sessions Claude Code. */
export class ClaudeCodeSessions {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly projectsDirFn: () => string = defaultClaudeProjectsDir) {}

  get projectsDir(): string {
    return this.projectsDirFn();
  }

  /** Dossier projet validé (pas de traversée, pas de lien symbolique, sous `projects`). */
  private async projectDir(projectId: string): Promise<string> {
    if (!isValidCcProjectId(projectId)) throw new CcNotFoundError("Projet introuvable.");
    const root = path.resolve(this.projectsDir);
    const dir = path.resolve(root, projectId);
    if (path.dirname(dir) !== root) throw new CcNotFoundError("Projet introuvable.");
    const st = await fsp.lstat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new CcNotFoundError("Projet introuvable.");
    return dir;
  }

  /** Fichier de session validé (fichier régulier, pas un lien). */
  private async sessionFile(projectId: string, sessionId: string): Promise<{ file: string; st: Stats }> {
    const dir = await this.projectDir(projectId);
    if (!isValidCcSessionId(sessionId)) throw new CcNotFoundError("Session Claude Code introuvable.");
    const file = path.join(dir, `${sessionId}.jsonl`);
    if (path.dirname(file) !== dir) throw new CcNotFoundError("Session Claude Code introuvable.");
    const st = await fsp.lstat(file).catch(() => null);
    if (!st?.isFile()) throw new CcNotFoundError("Session Claude Code introuvable.");
    return { file, st };
  }

  /** Fichiers `<uuid>.jsonl` (réguliers) d'un dossier projet. */
  private async sessionFiles(dir: string): Promise<{ id: string; file: string; st: Stats }[]> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const out: { id: string; file: string; st: Stats }[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -6);
      if (!isValidCcSessionId(id)) continue;
      const file = path.join(dir, name);
      const st = await fsp.lstat(file).catch(() => null);
      if (st?.isFile()) out.push({ id, file, st });
    }
    return out;
  }

  async listProjects(): Promise<CcProject[]> {
    const root = path.resolve(this.projectsDir);
    let names: string[];
    try {
      names = await fsp.readdir(root);
    } catch {
      return [];
    }
    const out: CcProject[] = [];
    for (const name of names) {
      if (!isValidCcProjectId(name)) continue;
      const dir = path.join(root, name);
      const st = await fsp.lstat(dir).catch(() => null);
      if (!st?.isDirectory()) continue;
      const files = await this.sessionFiles(dir);
      if (!files.length) continue;
      files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      let cwd: string | null = null;
      for (const f of files.slice(0, 3)) if ((cwd = await readHeadCwd(f.file))) break;
      out.push({ id: name, path: cwd, sessionCount: files.length, lastActivity: new Date(files[0]!.st.mtimeMs).toISOString() });
    }
    out.sort((a, b) => ((a.lastActivity ?? "") < (b.lastActivity ?? "") ? 1 : (a.lastActivity ?? "") > (b.lastActivity ?? "") ? -1 : 0));
    return out;
  }

  private async summarize(projectId: string, id: string, file: string, st: Stats): Promise<CacheEntry["summary"]> {
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = this.cache.get(file);
    if (hit && hit.key === key) return hit.summary;
    const { builder } = await parseTranscriptFile(file, st.size);
    const summary: CacheEntry["summary"] = {
      id,
      projectId,
      cwd: builder.cwd,
      title: builder.title,
      startedAt: builder.startedAt,
      updatedAt: builder.updatedAt ?? new Date(st.mtimeMs).toISOString(),
      messageCount: builder.messages.length,
      gitBranch: builder.gitBranch,
    };
    this.cache.set(file, { key, summary });
    return summary;
  }

  /** Sessions d'un projet (exclut celles sans aucun message affichable), plus récentes d'abord. */
  async listSessions(projectId: string, known: ReadonlySet<string>, q?: string): Promise<CcSessionSummary[]> {
    const dir = await this.projectDir(projectId);
    const needle = q?.trim().toLowerCase();
    const out: CcSessionSummary[] = [];
    for (const f of await this.sessionFiles(dir)) {
      const s = await this.summarize(projectId, f.id, f.file, f.st).catch(() => null);
      if (!s || s.messageCount === 0) continue;
      if (needle && !s.title.toLowerCase().includes(needle)) continue;
      out.push({ ...s, fromMyClaude: known.has(f.id.toLowerCase()) });
    }
    out.sort((a, b) => ((a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : (a.updatedAt ?? "") > (b.updatedAt ?? "") ? -1 : 0));
    return out;
  }

  async readTranscript(projectId: string, sessionId: string, known: ReadonlySet<string>): Promise<CcTranscript> {
    const { file, st } = await this.sessionFile(projectId, sessionId);
    const { builder, truncated } = await parseTranscriptFile(file, st.size);
    return {
      session: {
        id: sessionId,
        projectId,
        cwd: builder.cwd,
        title: builder.title,
        startedAt: builder.startedAt,
        updatedAt: builder.updatedAt ?? new Date(st.mtimeMs).toISOString(),
        messageCount: builder.messages.length,
        gitBranch: builder.gitBranch,
        fromMyClaude: known.has(sessionId.toLowerCase()),
      },
      messages: builder.messages,
      truncated,
    };
  }
}
