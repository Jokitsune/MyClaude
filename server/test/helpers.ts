import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  ProviderError,
  type EngineStatus,
  type Provider,
  type ProviderChatParams,
  type ProviderChatResult,
  type ProviderJsonParams,
} from "../src/providers/types.js";

export function tmpDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "myclaude-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Scénario d'un tour de fournisseur factice. */
export type FakeScript = (p: ProviderChatParams, fake: FakeProvider) => Promise<ProviderChatResult | void>;

/** Fournisseur factice : aucun appel réseau, aucun sous-processus. */
export class FakeProvider implements Provider {
  readonly name = "fake";
  chatCalls = 0;
  jsonCalls = 0;
  /** Paramètres reçus à chaque appel de chat(). */
  calls: ProviderChatParams[] = [];
  /** Si défini, chat() émet ce premier delta puis attend l'annulation. */
  hangAfterFirstDelta = false;
  /** Scénario personnalisé (outils, permissions…), prioritaire sur le comportement par défaut. */
  script: FakeScript | null = null;
  /** Lever resume_failed quand `resume` vaut cet ID. */
  failResumeOf: string | null = null;
  engineStatus: EngineStatus = { ready: true, account: { email: "test@example.com", subscription: "pro" } };
  statusCalls = 0;
  deletedTranscripts: { id: string; cwd: string }[] = [];
  jsonResult: unknown = { lessons: [{ kind: "preference", text: "Répondre en français.", rationale: "Demandé." }] };
  jsonError: ProviderError | null = null;
  sessionCounter = 0;

  async chat(p: ProviderChatParams): Promise<ProviderChatResult> {
    this.chatCalls++;
    this.calls.push(p);
    if (p.resume && p.resume === this.failResumeOf) {
      throw new ProviderError("resume_failed", "Reprise impossible : No conversation found.");
    }
    const sid = p.resume ?? `00000000-0000-4000-8000-${String(++this.sessionCounter).padStart(12, "0")}`;
    p.onSessionId(sid);
    if (this.script) {
      const r = await this.script(p, this);
      return r ?? { stopReason: "end", usage: { input_tokens: 1, output_tokens: 1 }, sessionId: sid };
    }
    p.onThinking("Je réfléchis.");
    p.onText("Bonjour");
    if (this.hangAfterFirstDelta) {
      await new Promise<void>((_, reject) => {
        if (p.signal.aborted) reject(new ProviderError("aborted", "Réponse interrompue."));
        p.signal.addEventListener("abort", () => reject(new ProviderError("aborted", "Réponse interrompue.")), {
          once: true,
        });
      });
    }
    p.onText(" !");
    return { stopReason: "end", usage: { input_tokens: 10, output_tokens: 3 }, sessionId: sid };
  }

  async generateJson(_p: ProviderJsonParams): Promise<unknown> {
    this.jsonCalls++;
    if (this.jsonError) throw this.jsonError;
    return this.jsonResult;
  }

  async status(): Promise<EngineStatus> {
    this.statusCalls++;
    return this.engineStatus;
  }

  async deleteTranscript(id: string, cwd: string): Promise<void> {
    this.deletedTranscripts.push({ id, cwd });
  }
}

/**
 * Simule un appel d'outil comme le moteur réel : tool_use, hook PreToolUse,
 * puis canUseTool si le hook renvoie « ask », puis résultat.
 */
export async function simulateTool(
  p: ProviderChatParams,
  id: string,
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): Promise<"allow" | "deny"> {
  p.onToolUse({ id, name, input });
  const pre = await p.gate.preToolUse(name, input, id);
  let allowed: boolean;
  if (pre.decision === "allow") allowed = true;
  else if (pre.decision === "deny") allowed = false;
  else allowed = (await p.gate.canUseTool(name, input, { toolUseId: id, signal })).behavior === "allow";
  p.onToolResult({ id, isError: !allowed, preview: allowed ? "ok" : "refusé" });
  return allowed ? "allow" : "deny";
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Requête HTTP brute (permet de forcer Host / Origin, ce que fetch interdit). */
export function rawRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

export function parseSse(body: string): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = [];
  for (const block of body.split("\n\n")) {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (event) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

/** Lecteur SSE incrémental : permet de réagir aux événements pendant le flux. */
export function openSse(
  port: number,
  path: string,
  body: unknown,
): {
  events: { event: string; data: unknown }[];
  waitFor(event: string, timeoutMs?: number): Promise<{ event: string; data: unknown }>;
  finished: Promise<void>;
  destroy(): void;
} {
  const events: { event: string; data: unknown }[] = [];
  const waiters: { event: string; resolve: (e: { event: string; data: unknown }) => void }[] = [];
  /** Nombre d'événements de chaque type déjà rendus par waitFor. */
  const consumed = new Map<string, number>();
  const take = (event: string): { event: string; data: unknown } | undefined => {
    const n = consumed.get(event) ?? 0;
    const matching = events.filter((e) => e.event === event);
    if (matching.length > n) {
      consumed.set(event, n + 1);
      return matching[n];
    }
    return undefined;
  };
  let buf = "";
  const data = JSON.stringify(body);
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => (resolveFinished = r));
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(data)),
      },
    },
    (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        buf += c;
        let idx: number;
        const SEP = String.fromCharCode(10, 10);
        while ((idx = buf.indexOf(SEP)) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const parsed = parseSse(block + SEP);
          for (const e of parsed) {
            events.push(e);
            const w = waiters.find((x) => x.event === e.event);
            if (w) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(take(e.event)!);
            }
          }
        }
      });
      res.on("end", () => resolveFinished());
      res.on("close", () => resolveFinished());
    },
  );
  req.on("error", () => resolveFinished());
  req.end(data);
  return {
    events,
    finished,
    destroy: () => req.destroy(),
    waitFor(event, timeoutMs = 5000) {
      const already = take(event);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`événement ${event} non reçu`)), timeoutMs);
        waiters.push({
          event,
          resolve: (e) => {
            clearTimeout(t);
            resolve(e);
          },
        });
      });
    },
  };
}
