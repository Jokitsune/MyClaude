// Présentation des appels d'outils (résumés lisibles, catégories, sensibilité, aperçus).
import type { ToolCall } from "./types";

/** Outils intégrés autorisés par défaut (docs/ARCHITECTURE.md, v2). */
export const DEFAULT_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Bash",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;

export const TOOL_DESCRIPTION: Record<string, string> = {
  Read: "Lire un fichier",
  Glob: "Lister des fichiers par motif",
  Grep: "Rechercher dans les fichiers",
  Write: "Créer ou écraser un fichier",
  Edit: "Modifier un fichier",
  Bash: "Exécuter des commandes",
  WebFetch: "Ouvrir une page web",
  WebSearch: "Recherche sur le web",
  TodoWrite: "Liste de tâches interne",
};

/** Outils en lecture seule, autorisés automatiquement dans le dossier de travail. */
const READ_ONLY = new Set(["Read", "Glob", "Grep", "TodoWrite", "LS", "NotebookRead"]);

export type ToolKind = "read" | "write" | "bash" | "search" | "web" | "todo" | "agent" | "mcp" | "other";

export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  switch (name) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "write";
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "bash";
    case "Glob":
    case "Grep":
    case "LS":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "TodoWrite":
      return "todo";
    case "Task":
    case "Agent":
      return "agent";
    default:
      return "other";
  }
}

/** « sensible » : tout ce qui n'est pas une lecture ; « danger » : commandes shell. */
export function sensitivity(name: string): "safe" | "sensitive" | "danger" {
  if (toolKind(name) === "bash") return "danger";
  return READ_ONLY.has(name) ? "safe" : "sensitive";
}

export const STATUS_LABEL: Record<ToolCall["status"], string> = {
  pending_approval: "en attente",
  running: "en cours",
  done: "terminé",
  error: "erreur",
  denied: "refusé",
};

function rec(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Dernier segment d'un chemin Windows ou POSIX. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Chemin de fichier visé par l'outil, s'il y en a un. */
export function toolPath(input: unknown): string | undefined {
  const i = rec(input);
  return str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
}

/** Résumé court : un verbe + une cible affichée en `code`. */
export function toolSummary(name: string, input: unknown): { verb: string; target?: string } {
  const i = rec(input);
  const path = toolPath(input);
  if (name.startsWith("mcp__")) {
    const [, server = "?", ...rest] = name.split("__");
    return { verb: `MCP ${server} :`, target: rest.join("__") || name };
  }
  switch (name) {
    case "Read":
    case "NotebookRead":
      return { verb: "Lire", target: path ? baseName(path) : undefined };
    case "Write":
      return { verb: "Écrire", target: path ? baseName(path) : undefined };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: "Modifier", target: path ? baseName(path) : undefined };
    case "Bash":
      return { verb: "Commande :", target: truncate(str(i.command)?.split("\n")[0] ?? "", 80) || undefined };
    case "Glob":
      return { verb: "Chercher des fichiers", target: str(i.pattern) };
    case "Grep":
      return { verb: "Rechercher", target: str(i.pattern) };
    case "LS":
      return { verb: "Lister", target: path };
    case "WebFetch":
      return { verb: "Ouvrir", target: str(i.url) ? host(str(i.url)!) : undefined };
    case "WebSearch":
      return { verb: "Recherche web :", target: str(i.query) };
    case "TodoWrite":
      return { verb: "Mettre à jour la liste de tâches" };
    case "Task":
    case "Agent":
      return { verb: "Sous-agent :", target: str(i.description) ?? str(i.subagent_type) };
    default:
      return { verb: name };
  }
}

export function summaryText(name: string, input: unknown): string {
  const s = toolSummary(name, input);
  return s.target ? `${s.verb} ${s.target}` : s.verb;
}

export function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

export interface PermissionPreview {
  /** Lignes « ce qui va se passer ». */
  facts: { label: string; value: string; mono?: boolean }[];
  /** Bloc de contenu (diff, contenu de fichier, commande, JSON). */
  block?: { label: string; text: string; diff?: boolean };
}

const PREVIEW_MAX = 1500;

function diffLines(oldS: string, newS: string): string {
  const minus = oldS.split("\n").map((l) => `- ${l}`);
  const plus = newS.split("\n").map((l) => `+ ${l}`);
  return [...minus, ...plus].join("\n");
}

/** Aperçu détaillé d'une demande d'autorisation. */
export function permissionPreview(tool: string, input: unknown): PermissionPreview {
  const i = rec(input);
  const path = toolPath(input);
  const facts: PermissionPreview["facts"] = [];
  if (path) facts.push({ label: "Fichier", value: path, mono: true });

  switch (tool) {
    case "Bash": {
      if (str(i.description)) facts.push({ label: "Objet", value: str(i.description)! });
      return { facts, block: { label: "Commande", text: truncate(str(i.command) ?? "", PREVIEW_MAX) } };
    }
    case "Write": {
      const content = str(i.content) ?? "";
      const lines = content ? content.split("\n").length : 0;
      facts.push({ label: "Taille", value: `${lines} ligne${lines > 1 ? "s" : ""}, ${content.length} caractères` });
      return { facts, block: { label: "Contenu écrit", text: truncate(content, PREVIEW_MAX) } };
    }
    case "Edit": {
      if (i.replace_all === true) facts.push({ label: "Portée", value: "toutes les occurrences" });
      const d = diffLines(str(i.old_string) ?? "", str(i.new_string) ?? "");
      return { facts, block: { label: "Modification", text: truncate(d, PREVIEW_MAX), diff: true } };
    }
    case "MultiEdit": {
      const edits = Array.isArray(i.edits) ? (i.edits as unknown[]) : [];
      const d = edits
        .map((e) => diffLines(str(rec(e).old_string) ?? "", str(rec(e).new_string) ?? ""))
        .join("\n@@\n");
      facts.push({ label: "Modifications", value: String(edits.length) });
      return { facts, block: { label: "Modifications", text: truncate(d, PREVIEW_MAX), diff: true } };
    }
    case "WebFetch":
      if (str(i.url)) facts.push({ label: "Adresse", value: str(i.url)!, mono: true });
      if (str(i.prompt)) facts.push({ label: "Consigne", value: truncate(str(i.prompt)!, 300) });
      return { facts };
    case "WebSearch":
      if (str(i.query)) facts.push({ label: "Requête", value: str(i.query)! });
      return { facts };
    case "Task":
    case "Agent":
      if (str(i.subagent_type)) facts.push({ label: "Agent", value: str(i.subagent_type)! });
      if (str(i.description)) facts.push({ label: "Tâche", value: str(i.description)! });
      return str(i.prompt) ? { facts, block: { label: "Consigne", text: truncate(str(i.prompt)!, PREVIEW_MAX) } } : { facts };
    default:
      return { facts, block: { label: "Paramètres", text: truncate(formatInput(input), PREVIEW_MAX) } };
  }
}
