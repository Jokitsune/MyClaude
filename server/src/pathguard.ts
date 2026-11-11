import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Contrôle des chemins de fichiers manipulés par les outils du moteur.
 *
 * Règle : tout chemin doit, après résolution, rester dans le dossier de travail.
 * - séparateurs `/` et `\` acceptés (Windows) ;
 * - `..` résolus ;
 * - `~` développé vers le dossier personnel (comme le fait Claude Code) ;
 * - liens symboliques / jonctions résolus via realpath sur le plus proche ancêtre existant ;
 * - comparaison insensible à la casse sous Windows ;
 * - chemins de périphérique / UNC étendus (`\\?\`, `\\.\`) refusés d'office.
 */

const IS_WIN = process.platform === "win32";

/** Clé de comparaison (casse ignorée sous Windows, sans séparateur final). */
function compareKey(p: string): string {
  let s = path.normalize(p);
  if (s.length > path.parse(s).root.length) s = s.replace(/[\\/]+$/, "");
  return IS_WIN ? s.toLowerCase() : s;
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * Forme canonique d'un chemin absolu : realpath du plus proche ancêtre existant
 * (résout liens et jonctions), puis réapplication des segments restants.
 */
export function canonicalize(absPath: string): string {
  let current = path.resolve(absPath);
  const rest: string[] = [];
  for (;;) {
    const real = realpathOrNull(current);
    if (real !== null) return rest.length ? path.join(real, ...rest.reverse()) : real;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(absPath); // aucun ancêtre lisible
    rest.push(path.basename(current));
    current = parent;
  }
}

/** Chemin de périphérique Windows / espace de noms étendu : jamais accepté. */
function isDevicePath(p: string): boolean {
  return /^[\\/]{2}[?.][\\/]/.test(p);
}

/**
 * Résout `p` (relatif au dossier `base`) comme le ferait l'outil.
 * Renvoie null si le chemin est inacceptable d'office.
 */
export function resolveToolPath(p: string, base: string): string | null {
  if (typeof p !== "string" || p.includes("\0")) return null;
  let s = p.trim();
  if (!s) return path.resolve(base);
  if (isDevicePath(s)) return null;
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(os.homedir(), s.slice(1));
  if (IS_WIN) s = s.replace(/\//g, "\\");
  return path.resolve(base, s);
}

/** `target` (absolu) est-il `dir` ou dans `dir` ? Les deux sont canonicalisés. */
export function isInsideDir(target: string, dir: string): boolean {
  const t = compareKey(canonicalize(target));
  const d = compareKey(canonicalize(dir));
  if (t === d) return true;
  const prefix = d.endsWith(path.sep) ? d : d + path.sep;
  return t.startsWith(prefix);
}

/** Partie fixe d'un motif glob (avant le premier segment contenant un joker). */
export function globStaticPrefix(pattern: string): string {
  const segs = pattern.split(/[\\/]/);
  const out: string[] = [];
  for (const seg of segs) {
    if (/[*?[\]{}]/.test(seg)) break;
    out.push(seg);
  }
  // "C:" seul → racine du lecteur ; "" initial → racine (motif absolu POSIX).
  if (out.length === 1 && out[0] === "") return path.sep;
  if (out.length === 1 && /^[A-Za-z]:$/.test(out[0]!)) return out[0]! + path.sep;
  return out.join(path.sep);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Chemins « à contrôler » d'un appel d'outil, relatifs ou absolus.
 * Les outils sans chemin (Bash, WebFetch…) renvoient une liste vide.
 */
export function extractToolPaths(tool: string, input: unknown): string[] {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") out.push(v);
  };
  switch (tool) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      push(i.file_path);
      break;
    case "NotebookEdit":
    case "NotebookRead":
      push(i.notebook_path);
      break;
    case "Glob": {
      push(i.path);
      const pattern = str(i.pattern);
      if (pattern) out.push(path.join(str(i.path) ?? ".", globStaticPrefix(pattern)) || ".");
      if (pattern && (path.isAbsolute(pattern) || /^[\\/]/.test(pattern))) out.push(globStaticPrefix(pattern));
      break;
    }
    case "Grep": {
      push(i.path);
      const glob = str(i.glob);
      if (glob) out.push(path.join(str(i.path) ?? ".", globStaticPrefix(glob)) || ".");
      break;
    }
    case "LS":
      push(i.path);
      break;
    default:
      // Outils inconnus / MCP : clés usuelles désignant un chemin.
      for (const k of ["file_path", "notebook_path", "path", "directory", "dir", "cwd"]) push(i[k]);
  }
  return out;
}

export type PathCheck = { ok: true } | { ok: false; path: string };

/** Vérifie que tous les chemins de l'appel restent dans `workspace`. */
export function checkToolPaths(tool: string, input: unknown, workspace: string): PathCheck {
  for (const raw of extractToolPaths(tool, input)) {
    const resolved = resolveToolPath(raw, workspace);
    if (resolved === null || !isInsideDir(resolved, workspace)) return { ok: false, path: raw };
  }
  return { ok: true };
}
