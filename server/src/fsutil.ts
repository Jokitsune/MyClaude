import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Écriture atomique : fichier temporaire dans le même dossier + fsync + rename.
 * Sous Windows, rename peut échouer brièvement (EPERM/EBUSY/EACCES) si un autre
 * processus (antivirus, indexeur) tient le fichier cible : on réessaie.
 */
export async function atomicWrite(file: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      await sleep(20 * (attempt + 1));
    }
  }
  await fsp.rm(tmp, { force: true }).catch(() => {});
  throw lastErr;
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}

/** Lit un JSON ; renvoie `undefined` si absent ou illisible. */
export async function readJson<T>(file: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Ajoute une ligne JSON à un fichier JSONL et force l'écriture sur disque.
 * Si le fichier se termine par une ligne tronquée (coupure précédente), on
 * insère d'abord un saut de ligne pour ne pas souder la nouvelle ligne à l'ancienne.
 */
export async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fh = await fsp.open(file, "a+");
  try {
    const { size } = await fh.stat();
    let prefix = "";
    if (size > 0) {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, size - 1);
      if (buf[0] !== 0x0a) prefix = "\n";
    }
    await fh.write(prefix + JSON.stringify(value) + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Lit un JSONL en ignorant silencieusement les lignes illisibles (ex. dernière ligne tronquée). */
export async function readJsonLines<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // ligne tronquée / corrompue : ignorée
    }
  }
  return out;
}

/** Verrou par clé : sérialise les sections critiques (lecture-modification-écriture). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
