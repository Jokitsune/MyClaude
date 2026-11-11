import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { startServerInternal, type InternalRunningServer } from "../src/app.js";
import { silentLogger } from "../src/log.js";
import { AgentSdkProvider, buildEngineEnv, NOT_LOGGED_IN_MESSAGE } from "../src/providers/agent-sdk.js";
import { ProviderError, type ProviderChatParams, type ToolGate } from "../src/providers/types.js";
import type { SessionMeta } from "../src/types.js";
import { FakeProvider, parseSse, rawRequest, tmpDir } from "./helpers.js";

const BASE_ENV = {
  PATH: "C:\\Windows",
  USERPROFILE: "C:\\Users\\x",
  ANTHROPIC_API_KEY: "sk-env-hérité",
  anthropic_auth_token: "jeton-hérité", // casse différente (Windows)
  ANTHROPIC_BASE_URL: "http://evil.example",
  ANTHROPIC_MODEL: "garde",
};

describe("environnement du moteur", () => {
  test("abonnement : identifiants Anthropic hérités retirés, le reste conservé", () => {
    const env = buildEngineEnv(BASE_ENV, { mode: "subscription" });
    for (const k of Object.keys(env)) {
      assert.ok(!["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].includes(k.toUpperCase()), k);
    }
    assert.equal(env.PATH, "C:\\Windows");
    assert.equal(env.USERPROFILE, "C:\\Users\\x");
    assert.equal(env.ANTHROPIC_MODEL, "garde");
  });

  test("clé API : seule la clé de config.json est transmise", () => {
    const env = buildEngineEnv(BASE_ENV, { mode: "apiKey", apiKey: "sk-ant-app" });
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-app");
    assert.equal(Object.keys(env).filter((k) => k.toUpperCase() === "ANTHROPIC_API_KEY").length, 1);
    assert.ok(!Object.keys(env).some((k) => ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].includes(k.toUpperCase())));
    assert.ok(!Object.values(env).includes("sk-env-hérité"));
  });

  test("clé API absente en mode apiKey : aucune clé, pas même celle de l'environnement", () => {
    const env = buildEngineEnv(BASE_ENV, { mode: "apiKey" });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });
});

// ------------------------------------------------------------ fausse query()

type FakeQuery = AsyncGenerator<SDKMessage, void> & { close(): void; accountInfo(): Promise<unknown> };

function fakeQueryFn(
  messages: (opts: Options) => SDKMessage[] | Promise<SDKMessage[]>,
  extra: { account?: unknown; throwAfter?: Error } = {},
) {
  const seen: { prompt: unknown; options: Options }[] = [];
  const fn = ((params: { prompt: unknown; options: Options }) => {
    seen.push(params);
    async function* gen() {
      for (const m of await messages(params.options)) yield m;
      if (extra.throwAfter) throw extra.throwAfter;
    }
    const g = gen() as unknown as FakeQuery;
    g.close = () => {};
    g.accountInfo = async () => extra.account ?? {};
    return g;
  }) as unknown as ConstructorParameters<typeof AgentSdkProvider>[0]["queryFn"];
  return { fn, seen };
}

const m = (x: Record<string, unknown>) => x as unknown as SDKMessage;
const gate: ToolGate = {
  preToolUse: async () => ({ decision: "ask" }),
  canUseTool: async () => ({ behavior: "deny", message: "non" }),
};

function chatParams(over: Partial<ProviderChatParams> = {}): ProviderChatParams & { log: string[] } {
  const log: string[] = [];
  return {
    model: "claude-sonnet-5-5",
    effort: "high",
    system: "SYSTEME",
    prompt: "Bonjour",
    cwd: "C:\\ws",
    tools: ["Read", "Write"],
    mcpServers: { srv: { command: "node", args: ["x.js"] } },
    agents: {},
    gate,
    signal: new AbortController().signal,
    onSessionId: (id) => log.push(`sid:${id}`),
    onThinking: (d) => log.push(`think:${d}`),
    onText: (d) => log.push(`text:${d}`),
    onToolUse: (c) => log.push(`tool:${c.id}:${c.name}`),
    onToolResult: (r) => log.push(`result:${r.id}:${r.isError}:${r.preview}`),
    log,
    ...over,
  };
}

const SID = "11111111-2222-4333-8444-555555555555";

describe("fournisseur Agent SDK (query factice, aucun sous-processus)", () => {
  test("options : isolation de la gouvernance, prompt système, outils, permissions, reprise", async () => {
    const { fn, seen } = fakeQueryFn(() => [
      m({ type: "system", subtype: "init", session_id: SID }),
      m({ type: "result", subtype: "success", is_error: false, result: "", stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 }, session_id: SID }),
    ]);
    const provider = new AgentSdkProvider({ auth: { mode: "subscription" }, queryFn: fn, baseEnv: BASE_ENV });
    const p = chatParams({ resume: SID, agents: { relecteur: { description: "d", prompt: "p" } } });
    const r = await provider.chat(p);
    assert.equal(r.sessionId, SID);
    assert.deepEqual(r.usage, { input_tokens: 3, output_tokens: 2 });
    const o = seen[0]!.options;
    assert.equal(seen[0]!.prompt, "Bonjour");
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(o.skills, []);
    assert.deepEqual(o.plugins, []);
    assert.deepEqual(o.systemPrompt, { type: "custom", prompt: "SYSTEME", snapshot: false });
    assert.deepEqual(o.tools, ["Read", "Write", "Agent"]);
    assert.equal(o.allowedTools, undefined, "aucun outil pré-autorisé : tout passe par le hook / canUseTool");
    assert.equal(o.permissionMode, "default");
    assert.equal(typeof o.canUseTool, "function");
    assert.equal(o.hooks?.PreToolUse?.length, 1);
    assert.equal(o.cwd, "C:\\ws");
    assert.equal(o.resume, SID);
    assert.equal(o.model, "claude-sonnet-5-5");
    assert.equal(o.effort, "high");
    assert.equal(o.includePartialMessages, true);
    assert.deepEqual(Object.keys(o.mcpServers ?? {}), ["srv"]);
    assert.ok(o.env && !("ANTHROPIC_API_KEY" in o.env));
    assert.ok(o.abortController instanceof AbortController);
    assert.deepEqual(p.log, [`sid:${SID}`]);
  });

  test("flux : réflexion, texte, outils et résultats", async () => {
    const { fn } = fakeQueryFn(() => [
      m({ type: "system", subtype: "init", session_id: SID }),
      m({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg1" } } }),
      m({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } }),
      m({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", content_block: { type: "text" } } }),
      m({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Je lis." } } }),
      m({ type: "assistant", parent_tool_use_id: null, message: { id: "msg1", content: [{ type: "text", text: "Je lis." }] } }),
      m({ type: "assistant", parent_tool_use_id: null, message: { id: "msg1", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "a" } }] } }),
      m({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "contenu" }] }] } }),
      // Message suivant sans flux partiel : repli sur le texte complet.
      m({ type: "assistant", parent_tool_use_id: null, message: { id: "msg2", content: [{ type: "text", text: "Fini." }] } }),
      m({ type: "result", subtype: "success", is_error: false, result: "Fini.", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, session_id: SID }),
    ]);
    const provider = new AgentSdkProvider({ auth: { mode: "subscription" }, queryFn: fn, baseEnv: BASE_ENV });
    const p = chatParams();
    const r = await provider.chat(p);
    assert.equal(r.stopReason, "end");
    assert.deepEqual(p.log, [
      `sid:${SID}`,
      "think:hmm",
      "text:Je lis.",
      "tool:tu1:Read",
      "result:tu1:false:contenu",
      "text:\n\n",
      "text:Fini.",
    ]);
  });

  test("reprise impossible (session inconnue) → resume_failed ; sans reprise → erreur normale", async () => {
    const msgs = () => [
      m({ type: "result", subtype: "error_during_execution", is_error: true, errors: [`No conversation found with session ID: ${SID}`], session_id: "x" }),
    ];
    const thrown = new Error(`Claude Code returned an error result: No conversation found with session ID: ${SID}`);
    const { fn } = fakeQueryFn(msgs, { throwAfter: thrown });
    const provider = new AgentSdkProvider({ auth: { mode: "subscription" }, queryFn: fn, baseEnv: BASE_ENV });
    await assert.rejects(provider.chat(chatParams({ resume: SID })), (e: unknown) => e instanceof ProviderError && e.code === "resume_failed");
    await assert.rejects(provider.chat(chatParams()), (e: unknown) => e instanceof ProviderError && e.code === "unknown");
  });

  test("non connecté : message FR clair (pas de reprise tentée)", async () => {
    const { fn } = fakeQueryFn(() => [
      m({ type: "assistant", parent_tool_use_id: null, error: "authentication_failed", message: { id: "e", content: [{ type: "text", text: "Not logged in · Please run /login" }] } }),
      m({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 }, session_id: SID }),
    ]);
    const provider = new AgentSdkProvider({ auth: { mode: "subscription" }, queryFn: fn, baseEnv: BASE_ENV });
    await assert.rejects(provider.chat(chatParams({ resume: SID })), (e: unknown) => e instanceof ProviderError && e.code === "not_logged_in" && e.message === NOT_LOGGED_IN_MESSAGE);
  });

  test("état du compte : connecté / non connecté / clé API absente", async () => {
    const logged = new AgentSdkProvider({
      auth: { mode: "subscription" },
      queryFn: fakeQueryFn(() => [], { account: { email: "a@b.c", organization: "Org", subscriptionType: "max", apiProvider: "firstParty" } }).fn,
      baseEnv: BASE_ENV,
    });
    assert.deepEqual(await logged.status(), { ready: true, account: { email: "a@b.c", organization: "Org", subscription: "max" } });

    const out = new AgentSdkProvider({
      auth: { mode: "subscription" },
      queryFn: fakeQueryFn(() => [], { account: { tokenSource: "none", apiProvider: "firstParty" } }).fn,
      baseEnv: BASE_ENV,
    });
    assert.deepEqual(await out.status(), { ready: false, account: null, error: NOT_LOGGED_IN_MESSAGE });

    const noKey = new AgentSdkProvider({ auth: { mode: "apiKey" }, queryFn: fakeQueryFn(() => []).fn, baseEnv: BASE_ENV });
    const s = await noKey.status();
    assert.equal(s.ready, false);
    assert.match(s.error ?? "", /clé/);
  });

  test("bilan : aucun outil, pas de transcription, JSON structuré", async () => {
    const { fn, seen } = fakeQueryFn(() => [
      m({ type: "result", subtype: "success", is_error: false, result: "", structured_output: { lessons: [] }, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, session_id: SID }),
    ]);
    const provider = new AgentSdkProvider({ auth: { mode: "subscription" }, queryFn: fn, baseEnv: BASE_ENV });
    const out = await provider.generateJson({ model: "haiku", effort: "medium", system: "S", prompt: "P", schema: { type: "object" } });
    assert.deepEqual(out, { lessons: [] });
    const o = seen[0]!.options;
    assert.deepEqual(o.tools, []);
    assert.deepEqual(o.mcpServers, {});
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.persistSession, false);
    assert.deepEqual(o.outputFormat, { type: "json_schema", schema: { type: "object" } });
    const decision = await o.canUseTool!("Bash", {}, { signal: new AbortController().signal, toolUseID: "x" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    assert.equal(decision.behavior, "deny");

    // Texte non JSON → invalid_output.
    const bad = new AgentSdkProvider({
      auth: { mode: "subscription" },
      queryFn: fakeQueryFn(() => [
        m({ type: "result", subtype: "success", is_error: false, result: "pas du json", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, session_id: SID }),
      ]).fn,
      baseEnv: BASE_ENV,
    });
    await assert.rejects(bad.generateJson({ model: "haiku", effort: "medium", system: "S", prompt: "P", schema: {} }), (e: unknown) => e instanceof ProviderError && e.code === "invalid_output");
  });
});

// ------------------------------------------------- continuité côté service

describe("continuité : reprise de la session moteur et repli", () => {
  let tmp: ReturnType<typeof tmpDir>;
  let server: InternalRunningServer;
  const fake = new FakeProvider();

  before(async () => {
    tmp = tmpDir();
    server = await startServerInternal(
      { port: 0, dataDir: path.join(tmp.dir, "data") },
      { providerFactory: () => fake, logger: silentLogger, idleCheck: false, defaultWorkspaceDir: path.join(tmp.dir, "ws") },
    );
  });
  after(async () => {
    await server.close();
    tmp.cleanup();
  });
  const req = (o: Parameters<typeof rawRequest>[1]) => rawRequest(server.port, o);

  test("engineSessionId stocké puis repris ; en cas d'échec, nouvelle session avec la transcription", async () => {
    const s = JSON.parse((await req({ method: "POST", path: "/api/sessions", body: {} })).body) as SessionMeta;
    const send = async (text: string) =>
      parseSse((await req({ method: "POST", path: `/api/sessions/${s.id}/messages`, body: { text } })).body);
    const meta = async () => (JSON.parse((await req({ path: `/api/sessions/${s.id}` })).body) as { session: SessionMeta }).session;

    await send("Premier message");
    const first = fake.calls.at(-1)!;
    assert.equal(first.resume, undefined);
    assert.equal(first.prompt, "Premier message");
    const sid1 = (await meta()).engineSessionId!;
    assert.ok(sid1);

    // Reprise normale.
    await send("Deuxième");
    assert.equal(fake.calls.at(-1)!.resume, sid1);
    assert.equal(fake.calls.at(-1)!.prompt, "Deuxième");

    // La reprise échoue : un second appel sans reprise, transcription injectée.
    fake.failResumeOf = sid1;
    const before = fake.chatCalls;
    const events = await send("Troisième");
    assert.equal(fake.chatCalls - before, 2);
    const retry = fake.calls.at(-1)!;
    assert.equal(retry.resume, undefined);
    assert.match(retry.prompt, /<transcription>[\s\S]*Premier message[\s\S]*Bonjour ![\s\S]*Deuxième[\s\S]*<\/transcription>/);
    assert.match(retry.prompt, /Nouveau message de l'utilisateur :\nTroisième$/);
    assert.equal(events.at(-1)!.event, "done");
    const sid2 = (await meta()).engineSessionId!;
    assert.ok(sid2 && sid2 !== sid1);

    // Suppression : la transcription moteur correspondante est supprimée (ID + cwd exacts).
    fake.failResumeOf = null;
    await req({ method: "DELETE", path: `/api/sessions/${s.id}` });
    assert.equal(fake.deletedTranscripts.at(-1)!.id, sid2);
  });

  test("prompt système = governance/system.md + memory.md", async () => {
    await req({ method: "PUT", path: "/api/governance", body: { system: "Consignes MyClaude." } });
    await req({ method: "PUT", path: "/api/memory", body: { content: "- Préférer les tableaux." } });
    const s = JSON.parse((await req({ method: "POST", path: "/api/sessions", body: {} })).body) as SessionMeta;
    await req({ method: "POST", path: `/api/sessions/${s.id}/messages`, body: { text: "x" } });
    const sys = fake.calls.at(-1)!.system;
    assert.match(sys, /^Consignes MyClaude\./);
    assert.match(sys, /# Mémoire[\s\S]*- Préférer les tableaux\./);
  });
});
