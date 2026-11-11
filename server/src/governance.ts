import { promises as fsp } from "node:fs";
import path from "node:path";
import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk";
import { HttpError } from "./errors.js";
import { KeyedMutex, atomicWrite, atomicWriteJson } from "./fsutil.js";
import type { Logger } from "./log.js";

/**
 * Gouvernance de MyClaude (dataDir/governance/) : seule source du comportement du moteur,
 * indépendante du compte Claude connecté.
 */

export interface ToolsConfig {
  allowed: string[];
}

export type McpServerDef =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse" | "http"; url: string; headers?: Record<string, string> };

export interface McpConfig {
  mcpServers: Record<string, McpServerDef>;
}

export interface AgentDef {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

export type AgentsConfig = Record<string, AgentDef>;

export interface Governance {
  system: string;
  tools: ToolsConfig;
  mcp: McpConfig;
  agents: AgentsConfig;
}

export const DEFAULT_SYSTEM_PROMPT = `Tu es Claude, l'assistant personnel de l'utilisateur dans MyClaude, son interface privée et locale.

# Style
- Réponds en français (sauf demande contraire), de façon claire et concise.
- Utilise le Markdown quand il aide la lecture (listes, titres, tableaux, blocs de code avec le langage).

# Outils et dossier de travail
- Tu travailles uniquement dans le dossier de travail de MyClaude (ton répertoire courant). N'essaie pas d'accéder à des fichiers en dehors : ce sera refusé.
- Les lectures dans ce dossier sont autorisées ; les écritures, commandes, accès web et outils externes sont soumis à la validation de l'utilisateur. Explique brièvement pourquoi tu as besoin d'un outil avant de l'utiliser.
- Si une action est refusée, n'insiste pas : propose une alternative ou demande à l'utilisateur.

# Prudence
- Ne divulgue jamais de secret (clé, mot de passe, jeton) rencontré dans un fichier.
- Avant toute action destructive ou irréversible, décris ce que tu vas faire.
`;

export const DEFAULT_TOOLS: ToolsConfig = {
  allowed: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "WebSearch", "TodoWrite"],
};

const FILES = {
  system: "system.md",
  tools: "tools.json",
  mcp: "mcp.json",
  agents: "agents.json",
} as const;

const MAX_SYSTEM_CHARS = 200_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_*-]+)?$/;
/** Noms d'outils intégrés reconnus (+ anciens noms). */
const KNOWN_TOOLS = new Set<string>([...BUILTIN_TOOL_NAMES, "Task", "LS", "MultiEdit", "NotebookRead"]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bad = (msg: string): never => {
  throw new HttpError(400, msg);
};

function validateStringRecord(v: unknown, what: string): Record<string, string> {
  if (!isObj(v)) bad(`${what} doit être un objet de chaînes.`);
  for (const [k, val] of Object.entries(v as object)) {
    if (typeof val !== "string") bad(`${what} : la valeur de « ${k} » doit être une chaîne.`);
  }
  return { ...(v as Record<string, string>) };
}

function validateToolName(t: unknown, where: string): string {
  if (typeof t !== "string" || !t.trim()) return bad(`${where} : nom d'outil invalide.`);
  const name = t.trim();
  if (!KNOWN_TOOLS.has(name) && !MCP_TOOL_RE.test(name)) bad(`${where} : outil inconnu « ${name} ».`);
  return name;
}

export function validateSystem(v: unknown): string {
  if (typeof v !== "string") return bad("system doit être du texte (Markdown).");
  if (v.length > MAX_SYSTEM_CHARS) bad("system est trop long.");
  return v;
}

export function validateTools(v: unknown): ToolsConfig {
  if (!isObj(v) || !Array.isArray(v.allowed)) return bad("tools doit être de la forme { \"allowed\": [\"Read\", …] }.");
  const allowed = [...new Set((v.allowed as unknown[]).map((t) => validateToolName(t, "tools.allowed")))];
  if (allowed.length > 200) bad("tools.allowed contient trop d'outils.");
  return { allowed };
}

export function validateMcp(v: unknown): McpConfig {
  if (!isObj(v) || !isObj(v.mcpServers)) return bad("mcp doit être de la forme { \"mcpServers\": { … } }.");
  const out: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(v.mcpServers)) {
    if (!NAME_RE.test(name)) bad(`mcp : nom de serveur invalide « ${name} » (lettres, chiffres, - et _).`);
    if (!isObj(def)) bad(`mcp.${name} doit être un objet.`);
    const d = def as Record<string, unknown>;
    const type = d.type ?? "stdio";
    if (type === "stdio") {
      if (typeof d.command !== "string" || !d.command.trim()) bad(`mcp.${name} : « command » est requis.`);
      if (d.args !== undefined && (!Array.isArray(d.args) || d.args.some((a) => typeof a !== "string")))
        bad(`mcp.${name} : « args » doit être une liste de chaînes.`);
      const s: McpServerDef = { command: d.command as string };
      if (d.type !== undefined) s.type = "stdio";
      if (d.args !== undefined) s.args = [...(d.args as string[])];
      if (d.env !== undefined) s.env = validateStringRecord(d.env, `mcp.${name}.env`);
      out[name] = s;
    } else if (type === "sse" || type === "http") {
      if (typeof d.url !== "string" || !/^https?:\/\//i.test(d.url)) bad(`mcp.${name} : « url » http(s) requise.`);
      const s: McpServerDef = { type, url: d.url as string };
      if (d.headers !== undefined) s.headers = validateStringRecord(d.headers, `mcp.${name}.headers`);
      out[name] = s;
    } else {
      bad(`mcp.${name} : type inconnu « ${String(type)} » (stdio, sse ou http).`);
    }
  }
  return { mcpServers: out };
}

export function validateAgents(v: unknown): AgentsConfig {
  if (!isObj(v)) return bad("agents doit être un objet { \"nom\": { description, prompt, tools?, model? } }.");
  const out: AgentsConfig = {};
  for (const [name, def] of Object.entries(v)) {
    if (!NAME_RE.test(name)) bad(`agents : nom invalide « ${name} » (lettres, chiffres, - et _).`);
    if (!isObj(def)) bad(`agents.${name} doit être un objet.`);
    const d = def as Record<string, unknown>;
    if (typeof d.description !== "string" || !d.description.trim()) bad(`agents.${name} : « description » est requise.`);
    if (typeof d.prompt !== "string" || !d.prompt.trim()) bad(`agents.${name} : « prompt » est requis.`);
    const a: AgentDef = { description: d.description as string, prompt: d.prompt as string };
    if (d.tools !== undefined) {
      if (!Array.isArray(d.tools)) bad(`agents.${name} : « tools » doit être une liste.`);
      a.tools = (d.tools as unknown[]).map((t) => validateToolName(t, `agents.${name}.tools`));
    }
    if (d.model !== undefined) {
      if (typeof d.model !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(d.model)) bad(`agents.${name} : « model » invalide.`);
      a.model = d.model as string;
    }
    out[name] = a;
  }
  return out;
}

/** Valide un corps PUT partiel ; lève HttpError(400) en français. */
export function validateGovernancePatch(body: unknown): Partial<Governance> {
  if (!isObj(body)) return bad("Corps de requête invalide.");
  const unknown = Object.keys(body).filter((k) => !(k in FILES));
  if (unknown.length) bad(`Champ inconnu : ${unknown.join(", ")}.`);
  const out: Partial<Governance> = {};
  if (body.system !== undefined) out.system = validateSystem(body.system);
  if (body.tools !== undefined) out.tools = validateTools(body.tools);
  if (body.mcp !== undefined) out.mcp = validateMcp(body.mcp);
  if (body.agents !== undefined) out.agents = validateAgents(body.agents);
  return out;
}

export class GovernanceStore {
  readonly dir: string;
  private readonly lock = new KeyedMutex();

  constructor(
    dataDir: string,
    private readonly log?: Logger,
  ) {
    this.dir = path.join(dataDir, "governance");
  }

  private file(k: keyof typeof FILES): string {
    return path.join(this.dir, FILES[k]);
  }

  /** Crée les fichiers absents avec leurs valeurs par défaut (jamais d'écrasement). */
  async init(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const defaults: [keyof typeof FILES, string][] = [
      ["system", DEFAULT_SYSTEM_PROMPT],
      ["tools", JSON.stringify(DEFAULT_TOOLS, null, 2) + "\n"],
      ["mcp", JSON.stringify({ mcpServers: {} }, null, 2) + "\n"],
      ["agents", "{}\n"],
    ];
    for (const [k, content] of defaults) {
      try {
        await fsp.writeFile(this.file(k), content, { encoding: "utf8", flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }

  private async readText(k: keyof typeof FILES): Promise<string | undefined> {
    try {
      return await fsp.readFile(this.file(k), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /** Lit et valide un fichier JSON ; en cas d'absence ou d'erreur, renvoie la valeur sûre par défaut. */
  private async readJsonPart<T>(k: "tools" | "mcp" | "agents", validate: (v: unknown) => T, fallback: T): Promise<T> {
    const raw = await this.readText(k);
    if (raw === undefined) return fallback;
    try {
      return validate(JSON.parse(raw));
    } catch (err) {
      const why = err instanceof HttpError ? err.message : "JSON invalide";
      this.log?.warn(`gouvernance : ${FILES[k]} ignoré (${why}) — valeur par défaut utilisée`);
      return fallback;
    }
  }

  async read(): Promise<Governance> {
    const system = (await this.readText("system")) ?? DEFAULT_SYSTEM_PROMPT;
    return {
      system,
      tools: await this.readJsonPart("tools", validateTools, { allowed: [...DEFAULT_TOOLS.allowed] }),
      mcp: await this.readJsonPart("mcp", validateMcp, { mcpServers: {} }),
      agents: await this.readJsonPart("agents", validateAgents, {}),
    };
  }

  /** Écrit les parties fournies (déjà validées par validateGovernancePatch). */
  async write(patch: Partial<Governance>): Promise<Governance> {
    await this.lock.run("governance", async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      if (patch.system !== undefined) await atomicWrite(this.file("system"), patch.system);
      if (patch.tools !== undefined) await atomicWriteJson(this.file("tools"), patch.tools);
      if (patch.mcp !== undefined) await atomicWriteJson(this.file("mcp"), patch.mcp);
      if (patch.agents !== undefined) await atomicWriteJson(this.file("agents"), patch.agents);
    });
    return this.read();
  }
}
