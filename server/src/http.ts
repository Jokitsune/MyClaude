import { createReadStream, promises as fsp } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { HttpError } from "./errors.js";
import type { Logger } from "./log.js";
import type { AppService, SseSink } from "./service.js";
import { isValidLessonId, isValidSessionId } from "./storage.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const SSE_PING_MS = 15_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const VITE_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

export interface HttpContext {
  service: AppService;
  version: string;
  webDir?: string;
  dev: boolean;
  log: Logger;
  /** Port réellement écouté (connu après listen). */
  getPort(): number;
}

// ------------------------------------------------------------------ sécurité

/**
 * Anti DNS-rebinding : Host doit être 127.0.0.1:<port> ou localhost:<port>.
 * Anti-CSRF : une requête mutante avec un Origin présent doit venir de ces hôtes
 * (ou du serveur Vite en mode dev).
 */
export function checkRequestOrigin(
  req: { method?: string; headers: IncomingMessage["headers"] },
  port: number,
  dev: boolean,
): string | null {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (dev) {
    // Le proxy Vite peut transmettre le Host d'origine (localhost:5173).
    allowedHosts.add("localhost:5173");
    allowedHosts.add("127.0.0.1:5173");
  }
  const host = (req.headers.host ?? "").toLowerCase();
  if (!allowedHosts.has(host)) return "Hôte non autorisé.";

  const method = (req.method ?? "GET").toUpperCase();
  const origin = req.headers.origin;
  if (!SAFE_METHODS.has(method) && origin !== undefined) {
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (dev) for (const o of VITE_DEV_ORIGINS) allowedOrigins.add(o);
    if (!allowedOrigins.has(String(origin).toLowerCase())) return "Origine non autorisée.";
  }
  return null;
}

// ------------------------------------------------------------------ helpers

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Corps de requête trop volumineux.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  const ct = String(req.headers["content-type"] ?? "");
  if (!ct.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Le corps doit être en JSON (Content-Type: application/json).");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON invalide.");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(webDir: string, urlPath: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  if (rel.includes("\0")) return false;
  const root = path.resolve(webDir);
  let file = path.resolve(root, "." + path.posix.normalize("/" + rel));
  if (file !== root && !file.startsWith(root + path.sep)) return false;

  let stat = await fsp.stat(file).catch(() => null);
  if (stat?.isDirectory()) {
    file = path.join(file, "index.html");
    stat = await fsp.stat(file).catch(() => null);
  }
  if (!stat?.isFile()) {
    // Fallback SPA : routes sans extension → index.html
    if (path.extname(rel)) return false;
    file = path.join(root, "index.html");
    stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) return false;
  }
  const ext = path.extname(file).toLowerCase();
  const isHtml = ext === ".html";
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": isHtml ? "no-cache" : rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise<void>((resolve) => {
    const s = createReadStream(file);
    s.on("error", () => {
      res.destroy();
      resolve();
    });
    s.on("end", () => resolve());
    s.pipe(res);
  });
  return true;
}

// ------------------------------------------------------------------ SSE

async function handleMessageStream(ctx: HttpContext, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const clientAbort = new AbortController();
  let opened = false;
  let ping: NodeJS.Timeout | null = null;

  const open = () => {
    if (opened) return;
    opened = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    ping = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, SSE_PING_MS);
  };
  const sink: SseSink = (event, data) => {
    open();
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Déconnexion du client avant la fin : on interrompt l'appel au modèle.
  res.on("close", () => {
    if (!res.writableEnded) clientAbort.abort();
  });

  try {
    await ctx.service.sendMessage(id, body, sink, clientAbort.signal);
  } catch (err) {
    if (!opened) throw err; // erreur de validation : réponse JSON classique
    ctx.log.error(`flux ${id}`, err);
    sink("error", { error: err instanceof HttpError ? err.message : "Erreur interne du serveur." });
  } finally {
    if (ping) clearInterval(ping);
    if (opened && !res.writableEnded) res.end();
  }
}

// ------------------------------------------------------------------ routeur

export function createRequestHandler(ctx: HttpContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    try {
      const reason = checkRequestOrigin(req, ctx.getPort(), ctx.dev);
      if (reason) throw new HttpError(403, reason);

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = (req.method ?? "GET").toUpperCase();
      const p = url.pathname;

      if (p === "/api" || p.startsWith("/api/")) {
        await routeApi(ctx, method, p, url, req, res);
        return;
      }
      if ((method === "GET" || method === "HEAD") && ctx.webDir) {
        if (await serveStatic(ctx.webDir, p, req, res)) return;
      }
      throw new HttpError(404, "Ressource introuvable.");
    } catch (err) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        ctx.log.error(`${req.method} ${req.url?.split("?")[0]}`, err);
        sendJson(res, 500, { error: "Erreur interne du serveur." });
      }
    }
  };
}

async function routeApi(
  ctx: HttpContext,
  method: string,
  p: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const svc = ctx.service;
  const seg = p.split("/").filter(Boolean).slice(1); // sans "api"
  const notAllowed = () => {
    throw new HttpError(405, "Méthode non autorisée.");
  };

  // /api/health
  if (seg.length === 1 && seg[0] === "health") {
    if (method !== "GET") return notAllowed();
    return sendJson(res, 200, { ok: true, version: ctx.version });
  }

  // /api/config
  if (seg.length === 1 && seg[0] === "config") {
    if (method === "GET") return sendJson(res, 200, await svc.getConfig());
    if (method === "PUT") return sendJson(res, 200, await svc.putConfig(await readBody(req)));
    return notAllowed();
  }

  // /api/memory
  if (seg.length === 1 && seg[0] === "memory") {
    if (method === "GET") return sendJson(res, 200, await svc.getMemory());
    if (method === "PUT") return sendJson(res, 200, await svc.putMemory(await readBody(req)));
    return notAllowed();
  }

  // /api/sessions[...]
  if (seg[0] === "sessions") {
    if (seg.length === 1) {
      if (method === "GET") return sendJson(res, 200, await svc.listSessions());
      if (method === "POST") return sendJson(res, 200, await svc.createSession(await readBody(req)));
      return notAllowed();
    }
    const id = seg[1]!;
    if (!isValidSessionId(id)) throw new HttpError(404, "Session introuvable.");
    if (seg.length === 2) {
      if (method === "GET") return sendJson(res, 200, await svc.getSession(id));
      if (method === "DELETE") {
        await svc.deleteSession(id);
        return sendJson(res, 200, { ok: true });
      }
      return notAllowed();
    }
    if (seg.length === 3) {
      if (method !== "POST") return notAllowed();
      switch (seg[2]) {
        case "heartbeat":
          await svc.heartbeat(id);
          return sendJson(res, 200, { ok: true });
        case "close":
          return sendJson(res, 200, await svc.closeSession(id));
        case "messages":
          return handleMessageStream(ctx, id, req, res);
      }
    }
    throw new HttpError(404, "Route inconnue.");
  }

  // /api/lessons[...]
  if (seg[0] === "lessons") {
    if (seg.length === 1) {
      if (method !== "GET") return notAllowed();
      return sendJson(res, 200, await svc.listLessons(url.searchParams.get("status") ?? undefined));
    }
    const id = seg[1]!;
    if (!isValidLessonId(id)) throw new HttpError(404, "Leçon introuvable.");
    if (seg.length === 3 && method === "POST") {
      if (seg[2] === "approve") return sendJson(res, 200, await svc.approveLesson(id, await readBody(req)));
      if (seg[2] === "reject") return sendJson(res, 200, await svc.rejectLesson(id));
    }
    throw new HttpError(404, "Route inconnue.");
  }

  throw new HttpError(404, "Route inconnue.");
}
