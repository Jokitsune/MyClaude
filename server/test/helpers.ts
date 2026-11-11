import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ProviderError, type Provider, type ProviderChatParams, type ProviderChatResult, type ProviderJsonParams } from "../src/providers/types.js";

export function tmpDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "myclaude-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Fournisseur factice : aucun appel réseau. */
export class FakeProvider implements Provider {
  readonly name = "fake";
  chatCalls = 0;
  jsonCalls = 0;
  /** Si défini, chat() émet ce premier delta puis attend l'annulation. */
  hangAfterFirstDelta = false;
  jsonResult: unknown = { lessons: [{ kind: "preference", text: "Répondre en français.", rationale: "Demandé." }] };
  jsonError: ProviderError | null = null;

  async chat(p: ProviderChatParams): Promise<ProviderChatResult> {
    this.chatCalls++;
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
    return { stopReason: "end", usage: { input_tokens: 10, output_tokens: 3 } };
  }

  async generateJson(_p: ProviderJsonParams): Promise<unknown> {
    this.jsonCalls++;
    if (this.jsonError) throw this.jsonError;
    return this.jsonResult;
  }
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
