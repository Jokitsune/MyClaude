import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { startServerInternal, type InternalRunningServer } from "../src/app.js";
import { checkRequestOrigin } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import type { ChatMessage, SessionMeta } from "../src/types.js";
import { FakeProvider, parseSse, rawRequest, tmpDir } from "./helpers.js";

describe("contrôles Host / Origin (unitaires)", () => {
  const port = 4317;
  const h = (headers: Record<string, string>, method = "GET") => checkRequestOrigin({ method, headers }, port, false);

  test("Host autorisés", () => {
    assert.equal(h({ host: "127.0.0.1:4317" }), null);
    assert.equal(h({ host: "localhost:4317" }), null);
  });
  test("Host refusés (DNS rebinding)", () => {
    assert.notEqual(h({ host: "evil.example:4317" }), null);
    assert.notEqual(h({ host: "127.0.0.1:9999" }), null);
    assert.notEqual(h({ host: "127.0.0.1" }), null);
    assert.notEqual(h({}), null);
  });
  test("Origin étranger refusé sur requête mutante, toléré sur GET", () => {
    assert.notEqual(h({ host: "127.0.0.1:4317", origin: "https://evil.example" }, "POST"), null);
    assert.notEqual(h({ host: "127.0.0.1:4317", origin: "null" }, "PUT"), null);
    assert.equal(h({ host: "127.0.0.1:4317", origin: "http://localhost:4317" }, "POST"), null);
    assert.equal(h({ host: "127.0.0.1:4317" }, "DELETE"), null);
    assert.equal(h({ host: "127.0.0.1:4317", origin: "https://evil.example" }, "GET"), null);
  });
  test("origine Vite seulement en dev", () => {
    const req = { method: "POST", headers: { host: "127.0.0.1:4317", origin: "http://localhost:5173" } };
    assert.notEqual(checkRequestOrigin(req, port, false), null);
    assert.equal(checkRequestOrigin(req, port, true), null);
  });
});

describe("serveur HTTP (fournisseur factice, aucun appel réseau)", () => {
  let tmp: ReturnType<typeof tmpDir>;
  let server: InternalRunningServer;
  const fake = new FakeProvider();

  before(async () => {
    tmp = tmpDir();
    server = await startServerInternal(
      { port: 0, dataDir: tmp.dir },
      {
        // Comme la fabrique réelle : aucun moteur en mode clé API sans clé.
        providerFactory: (cfg) => (cfg.authMode === "apiKey" && !cfg.apiKey ? null : fake),
        logger: silentLogger,
        idleCheck: false,
        defaultWorkspaceDir: path.join(tmp.dir, "ws"),
      },
    );
  });
  after(async () => {
    await server.close();
    tmp.cleanup();
  });

  const req = (o: Parameters<typeof rawRequest>[1]) => rawRequest(server.port, o);

  test("health", async () => {
    const r = await req({ path: "/api/health" });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, true);
  });

  test("Host étranger → 403", async () => {
    const r = await req({ path: "/api/health", headers: { host: `evil.example:${server.port}` } });
    assert.equal(r.status, 403);
    assert.ok(JSON.parse(r.body).error);
  });

  test("Origin étranger sur POST → 403, rien n'est créé", async () => {
    const r = await req({ method: "POST", path: "/api/sessions", body: {}, headers: { origin: "https://evil.example" } });
    assert.equal(r.status, 403);
    const list = JSON.parse((await req({ path: "/api/sessions" })).body) as SessionMeta[];
    assert.equal(list.length, 0);
  });

  test("la clé API n'est jamais renvoyée", async () => {
    const put = await req({ method: "PUT", path: "/api/config", body: { apiKey: "sk-ant-secret-123", effort: "high" } });
    assert.equal(put.status, 200);
    assert.ok(!put.body.includes("sk-ant-secret-123"));
    const cfg = JSON.parse(put.body);
    assert.equal(cfg.hasApiKey, true);
    assert.equal(cfg.effort, "high");
    assert.equal(cfg.availableModels.length, 6);
    assert.equal(cfg.authMode, "subscription");
    assert.equal(cfg.engineReady, true);
    assert.equal(cfg.account.email, "test@example.com");
    const get = await req({ path: "/api/config" });
    assert.ok(!get.body.includes("sk-ant-secret-123"));
    assert.equal((await req({ method: "PUT", path: "/api/config", body: { model: "gpt-4" } })).status, 400);
  });

  test("identifiant de session invalide → 404", async () => {
    for (const p of ["/api/sessions/..%2F..%2Fconfig", "/api/sessions/..", "/api/sessions/abc"]) {
      assert.equal((await req({ path: p })).status, 404, p);
    }
  });

  test("flux SSE complet puis journalisation", async () => {
    const s = JSON.parse((await req({ method: "POST", path: "/api/sessions", body: {} })).body) as SessionMeta;
    const r = await req({ method: "POST", path: `/api/sessions/${s.id}/messages`, body: { text: "Salut Claude" } });
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /text\/event-stream/);
    const events = parseSse(r.body);
    assert.deepEqual(
      events.map((e) => e.event),
      ["user", "thinking", "delta", "delta", "done"],
    );
    const done = events.at(-1)!.data as ChatMessage;
    assert.equal(done.text, "Bonjour !");
    assert.equal(done.thinking, "Je réfléchis.");

    const got = JSON.parse((await req({ path: `/api/sessions/${s.id}` })).body);
    assert.equal(got.messages.length, 2);
    assert.equal(got.session.title, "Salut Claude");

    // Session close → 409
    await req({ method: "POST", path: `/api/sessions/${s.id}/close` });
    const r2 = await req({ method: "POST", path: `/api/sessions/${s.id}/messages`, body: { text: "Encore" } });
    assert.equal(r2.status, 409);
  });

  test("déconnexion du client en cours de flux → appel interrompu, réponse partielle journalisée", async () => {
    fake.hangAfterFirstDelta = true;
    try {
      const s = JSON.parse((await req({ method: "POST", path: "/api/sessions", body: {} })).body) as SessionMeta;
      await new Promise<void>((resolve, reject) => {
        const data = JSON.stringify({ text: "Raconte une longue histoire" });
        const cr = http.request(
          {
            host: "127.0.0.1",
            port: server.port,
            method: "POST",
            path: `/api/sessions/${s.id}/messages`,
            headers: { host: `127.0.0.1:${server.port}`, "content-type": "application/json" },
          },
          (res) => {
            res.setEncoding("utf8");
            let buf = "";
            res.on("data", (c: string) => {
              buf += c;
              if (buf.includes("event: delta")) {
                cr.destroy(); // le client s'en va
                resolve();
              }
            });
          },
        );
        cr.on("error", () => {});
        cr.on("close", () => resolve());
        setTimeout(() => reject(new Error("timeout")), 5000);
        cr.end(data);
      });

      let messages: ChatMessage[] = [];
      for (let i = 0; i < 50; i++) {
        messages = JSON.parse((await req({ path: `/api/sessions/${s.id}` })).body).messages;
        if (messages.length >= 2) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(messages.length, 2);
      const partial = messages[1]!;
      assert.equal(partial.role, "assistant");
      assert.equal(partial.text, "Bonjour");
      assert.match(partial.error ?? "", /interrompue/);
    } finally {
      fake.hangAfterFirstDelta = false;
    }
  });

  test("mode clé API sans clé : erreur SSE claire, moteur non prêt", async () => {
    const put = await req({ method: "PUT", path: "/api/config", body: { authMode: "apiKey", apiKey: null } });
    const cfg = JSON.parse(put.body);
    assert.equal(cfg.authMode, "apiKey");
    assert.equal(cfg.engineReady, false);
    assert.match(cfg.engineError, /clé API/);
    const s = JSON.parse((await req({ method: "POST", path: "/api/sessions", body: {} })).body) as SessionMeta;
    const r = await req({ method: "POST", path: `/api/sessions/${s.id}/messages`, body: { text: "Test" } });
    const events = parseSse(r.body);
    assert.deepEqual(
      events.map((e) => e.event),
      ["user", "error"],
    );
    assert.match((events[1]!.data as { error: string }).error, /clé API/);
  });
});
