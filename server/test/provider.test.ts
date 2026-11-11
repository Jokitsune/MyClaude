import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AuthenticationError } from "@anthropic-ai/sdk";
import { buildStreamParams, createAnthropicClient, mapSdkError } from "../src/providers/anthropic.js";

describe("fournisseur Anthropic (sans réseau)", () => {
  test("le client ignore ANTHROPIC_* de l'environnement", () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "env-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "env-token";
    process.env.ANTHROPIC_BASE_URL = "http://evil.example";
    try {
      const c = createAnthropicClient("app-key");
      assert.equal(c.apiKey, "app-key");
      assert.equal(c.authToken, null);
      assert.equal(c.baseURL, "https://api.anthropic.com");
    } finally {
      for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  test("paramètres : thinking adaptatif résumé, effort, fallback sauf Haiku, pas de température", () => {
    const base = { effort: "high" as const, system: "s", messages: [{ role: "user" as const, content: "x" }] };
    const opus = buildStreamParams({ ...base, model: "claude-opus-5-5" });
    assert.deepEqual(opus.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(opus.output_config, { effort: "high" });
    assert.equal(opus.max_tokens, 64000);
    assert.deepEqual(opus.betas, ["server-side-fallback-2026-07-01"]);
    assert.equal(opus.fallbacks, "default");
    for (const k of ["temperature", "top_p", "top_k"]) assert.ok(!(k in opus));
    const haiku = buildStreamParams({ ...base, model: "claude-haiku-5-5" });
    assert.equal(haiku.betas, undefined);
    assert.equal(haiku.fallbacks, undefined);
  });

  test("requête sortante : hôte, en-têtes et erreur typée → message FR", async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      seen = {
        url: String(input instanceof Request ? input.url : input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
      return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    };
    const client = createAnthropicClient("app-key").withOptions({ fetch: fakeFetch as typeof fetch, maxRetries: 0 });
    const params = buildStreamParams({
      model: "claude-sonnet-5-5",
      effort: "medium",
      system: "s",
      messages: [{ role: "user", content: "x" }],
    });
    await assert.rejects(
      client.beta.messages.stream(params).finalMessage(),
      (err: unknown) => err instanceof AuthenticationError,
    );
    assert.ok(seen);
    const s = seen as { url: string; headers: Headers; body: Record<string, unknown> };
    assert.ok(s.url.startsWith("https://api.anthropic.com/v1/messages"), s.url);
    // SDK 1.x : la clé API part en "Authorization: Bearer <clé>" ; seule la clé de l'app est utilisée.
    assert.equal(s.headers.get("authorization"), "Bearer app-key");
    assert.match(s.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
    assert.equal(s.body.fallbacks, "default");
    assert.equal(s.body.stream, true);
    assert.equal(mapSdkError(new AuthenticationError(401, undefined, "x", new Headers())).code, "auth");
  });
});
