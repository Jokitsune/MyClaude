import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { startServerInternal, type InternalRunningServer } from "../src/app.js";
import {
  MAX_TRANSCRIPT_BYTES,
  PREVIEW_MAX,
  TranscriptBuilder,
  isValidCcProjectId,
  isValidCcSessionId,
  parseTranscriptFile,
} from "../src/claudecode.js";
import { silentLogger } from "../src/log.js";
import { canonicalize } from "../src/pathguard.js";
import type { CcProject, CcSessionSummary, CcTranscript, ChatMessage, SessionMeta } from "../src/types.js";
import { FakeProvider, parseSse, rawRequest, simulateTool, tmpDir } from "./helpers.js";

// ------------------------------------------------------------ fixtures synthétiques

type Line = Record<string, unknown>;

/** Transcription synthétique au format Claude Code (aucune donnée réelle). */
function transcript(opts: { sessionId: string; cwd: string; branch?: string; t0?: number }): Line[] {
  const { sessionId, cwd } = opts;
  const t0 = opts.t0 ?? Date.parse("2026-03-01T10:00:00.000Z");
  const ts = (s: number) => new Date(t0 + s * 1000).toISOString();
  const base = { sessionId, cwd, version: "2.0.0", gitBranch: opts.branch ?? "main", isSidechain: false, userType: "external" };
  const u1 = randomUUID();
  const a1 = randomUUID();
  const a2 = randomUUID();
  const r1 = randomUUID();
  const a3 = randomUUID();
  return [
    { type: "permission-mode", permissionMode: "default", sessionId },
    { type: "file-history-snapshot", messageId: u1, snapshot: {}, isSnapshotUpdate: false },
    { ...base, type: "user", parentUuid: null, uuid: u1, timestamp: ts(0), message: { role: "user", content: "Question synthétique alpha" } },
    { ...base, type: "user", isMeta: true, parentUuid: u1, uuid: randomUUID(), timestamp: ts(1), message: { role: "user", content: "méta cachée" } },
    { ...base, type: "assistant", parentUuid: u1, uuid: a1, timestamp: ts(2), message: { id: "msg_A", role: "assistant", model: "m", content: [{ type: "thinking", thinking: "réflexion synthétique", signature: "x" }] } },
    { ...base, type: "assistant", parentUuid: a1, uuid: a2, timestamp: ts(3), message: { id: "msg_A", role: "assistant", model: "m", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.txt" } }] } },
    { ...base, type: "user", parentUuid: a2, uuid: r1, timestamp: ts(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x".repeat(5000) }] }, toolUseResult: {} },
    { ...base, type: "assistant", parentUuid: r1, uuid: a3, timestamp: ts(5), message: { id: "msg_B", role: "assistant", model: "m", content: [{ type: "text", text: "Réponse synthétique alpha" }] } },
    { ...base, type: "assistant", isSidechain: true, parentUuid: a3, uuid: randomUUID(), timestamp: ts(6), message: { id: "msg_S", role: "assistant", content: [{ type: "text", text: "sous-agent caché" }] } },
    { ...base, type: "user", parentUuid: a3, uuid: randomUUID(), timestamp: ts(7), message: { role: "user", content: "<command-name>/clear</command-name>" } },
    { ...base, type: "system", subtype: "turn_duration", parentUuid: a3, uuid: randomUUID(), timestamp: ts(8) },
    { type: "ai-title", aiTitle: "Titre IA synthétique", sessionId },
    { ...base, type: "user", parentUuid: a3, uuid: randomUUID(), timestamp: ts(9), message: { role: "user", content: [{ type: "text", text: "Deuxième question bêta" }] } },
    { ...base, type: "assistant", parentUuid: null, uuid: randomUUID(), timestamp: ts(10), message: { id: "msg_C", role: "assistant", model: "m", content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "false" } }] } },
    { ...base, type: "user", parentUuid: null, uuid: randomUUID(), timestamp: ts(11), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: [{ type: "text", text: "échec" }] }] } },
    { ...base, type: "assistant", parentUuid: null, uuid: randomUUID(), timestamp: ts(12), message: { id: "msg_D", role: "assistant", model: "m", content: [{ type: "text", text: "Réponse bêta" }] } },
  ];
}

function writeJsonl(file: string, lines: (Line | string)[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

// ------------------------------------------------------------ unitaires (parseur)

describe("parseur de transcriptions Claude Code", () => {
  test("conversion en ChatMessage : tours, outils, réflexion ; entrées techniques ignorées", () => {
    const b = new TranscriptBuilder();
    for (const l of transcript({ sessionId: randomUUID(), cwd: "C:\\synthetique" })) b.addLine(JSON.stringify(l));
    const msgs = b.messages;
    assert.deepEqual(
      msgs.map((m) => [m.role, m.text]),
      [
        ["user", "Question synthétique alpha"],
        ["assistant", "Réponse synthétique alpha"],
        ["user", "Deuxième question bêta"],
        ["assistant", "Réponse bêta"],
      ],
    );
    assert.equal(msgs[1]!.thinking, "réflexion synthétique");
    const t1 = msgs[1]!.tools![0]!;
    assert.equal(t1.name, "Read");
    assert.equal(t1.status, "done");
    assert.equal(t1.resultPreview!.length, PREVIEW_MAX);
    assert.equal(msgs[3]!.tools![0]!.status, "error");
    assert.equal(msgs[3]!.tools![0]!.resultPreview, "échec");
    assert.equal(b.cwd, "C:\\synthetique");
    assert.equal(b.gitBranch, "main");
    assert.equal(b.title, "Titre IA synthétique");
    assert.equal(b.startedAt, "2026-03-01T10:00:00.000Z");
  });

  test("lignes invalides, non-objets, dernière ligne tronquée : ignorées sans erreur", () => {
    const b = new TranscriptBuilder();
    for (const l of ["", "pas du json", "[1,2]", "42", "null", '{"type":"user","message":', '{"type":"user"}', '{"type":"assistant","message":{"content":"oops"}}'])
      b.addLine(l);
    b.addLine(JSON.stringify({ type: "user", message: { role: "user", content: 12 } }));
    b.addLine(JSON.stringify({ type: "user", message: { role: "user", content: [null, { type: "text" }, { type: "text", text: "ok" }] } }));
    assert.deepEqual(
      b.messages.map((m) => [m.role, m.text]),
      [
        ["assistant", "oops"],
        ["user", "ok"],
      ],
    );
    assert.equal(b.title, "ok");
  });

  test("titre : titre personnalisé > résumé > titre IA > 1er message", () => {
    const b = new TranscriptBuilder();
    b.addLine(JSON.stringify({ type: "user", message: { content: "premier" }, timestamp: "2026-01-01T00:00:00Z" }));
    assert.equal(b.title, "premier");
    b.addLine(JSON.stringify({ type: "ai-title", aiTitle: "ia" }));
    assert.equal(b.title, "ia");
    b.addLine(JSON.stringify({ type: "summary", summary: "résumé" }));
    assert.equal(b.title, "résumé");
    b.addLine(JSON.stringify({ type: "custom-title", customTitle: "perso" }));
    assert.equal(b.title, "perso");
  });

  test("gros fichier : lecture plafonnée et `truncated`", async () => {
    const tmp = tmpDir();
    try {
      const file = path.join(tmp.dir, "big.jsonl");
      const lines: Line[] = [];
      for (let i = 0; i < 200; i++)
        lines.push({ type: "user", uuid: randomUUID(), timestamp: "2026-01-01T00:00:00Z", message: { content: `message ${i} ${"z".repeat(200)}` } });
      writeJsonl(file, lines);
      const size = statSync(file).size;
      const cut = await parseTranscriptFile(file, size, { maxBytes: 5000 });
      assert.equal(cut.truncated, true);
      assert.ok(cut.builder.messages.length > 0 && cut.builder.messages.length < 200);
      const capped = await parseTranscriptFile(file, size, { maxMessages: 10 });
      assert.equal(capped.truncated, true);
      assert.equal(capped.builder.messages.length, 10);
      const full = await parseTranscriptFile(file, size);
      assert.equal(full.truncated, false);
      assert.equal(full.builder.messages.length, 200);
      assert.ok(MAX_TRANSCRIPT_BYTES >= 1024 * 1024);
    } finally {
      tmp.cleanup();
    }
  });

  test("validation des identifiants (aucune traversée)", () => {
    for (const bad of ["..", ".", "../x", "a/b", "a\\b", "C:", "", "a\0b", "x".repeat(300)]) assert.equal(isValidCcProjectId(bad), false, bad);
    assert.equal(isValidCcProjectId("C--Users-moi-projet"), true);
    assert.equal(isValidCcSessionId(randomUUID()), true);
    for (const bad of ["../" + randomUUID(), randomUUID() + ".jsonl", "abc", ""]) assert.equal(isValidCcSessionId(bad), false, bad);
  });
});

// ------------------------------------------------------------ serveur (HTTP)

describe("API /api/cc (fixtures synthétiques, CLAUDE_CONFIG_DIR temporaire)", () => {
  let tmp: ReturnType<typeof tmpDir>;
  let server: InternalRunningServer;
  let fake: FakeProvider;
  let projectsDir: string;
  let originCwd: string; // dossier d'origine de la session A (existe)
  let globalWs: string;
  const sidA = randomUUID();
  const sidB = randomUUID();
  const sidOld = randomUUID();
  const projA = "C--synthetique-projet-a";
  const projB = "C--synthetique-projet-b";
  let fileA: string;
  let forkCalls: string[] = [];
  let forkMode: "real" | "fail" = "real";
  const prevEnv = process.env.CLAUDE_CONFIG_DIR;

  const get = async <T>(p: string): Promise<{ status: number; body: T }> => {
    const r = await rawRequest(server.port, { path: p });
    return { status: r.status, body: JSON.parse(r.body) as T };
  };
  const post = async <T>(p: string, body: unknown): Promise<{ status: number; body: T }> => {
    const r = await rawRequest(server.port, { method: "POST", path: p, body });
    return { status: r.status, body: JSON.parse(r.body) as T };
  };
  const send = async (id: string, text: string) => {
    const r = await rawRequest(server.port, { method: "POST", path: `/api/sessions/${id}/messages`, body: { text } });
    return parseSse(r.body);
  };

  before(async () => {
    tmp = tmpDir();
    const ccRoot = path.join(tmp.dir, "claude-config");
    process.env.CLAUDE_CONFIG_DIR = ccRoot; // utilisé par forkSession du SDK
    projectsDir = path.join(ccRoot, "projects");
    originCwd = path.join(tmp.dir, "origine");
    globalWs = path.join(tmp.dir, "ws-global");
    mkdirSync(originCwd, { recursive: true });
    fileA = path.join(projectsDir, projA, `${sidA}.jsonl`);
    writeJsonl(fileA, transcript({ sessionId: sidA, cwd: originCwd, t0: Date.parse("2026-03-02T10:00:00Z") }));
    writeJsonl(path.join(projectsDir, projA, `${sidOld}.jsonl`), [
      ...transcript({ sessionId: sidOld, cwd: originCwd, t0: Date.parse("2026-01-01T10:00:00Z") }),
      { type: "custom-title", customTitle: "Ancienne gamma", sessionId: sidOld },
    ]);
    // Session sans aucun message affichable : non listée.
    writeJsonl(path.join(projectsDir, projA, `${randomUUID()}.jsonl`), [{ type: "permission-mode", permissionMode: "default" }]);
    // Bruit : fichier non-UUID, sous-dossier de sous-agents.
    writeFileSync(path.join(projectsDir, projA, "notes.jsonl"), "{}\n");
    mkdirSync(path.join(projectsDir, projA, sidA, "subagents"), { recursive: true });
    writeJsonl(path.join(projectsDir, projB, `${sidB}.jsonl`), transcript({ sessionId: sidB, cwd: "C:\\inexistant\\synthetique-b" }));
    mkdirSync(path.join(projectsDir, "C--projet-vide"), { recursive: true });

    fake = new FakeProvider();
    server = await startServerInternal(
      { port: 0, dataDir: path.join(tmp.dir, "home", "AppData", "MyClaude", "data") },
      {
        providerFactory: () => fake,
        logger: silentLogger,
        idleCheck: false,
        defaultWorkspaceDir: globalWs,
        claudeProjectsDir: () => projectsDir,
        forkSession: async (id) => {
          forkCalls.push(id);
          if (forkMode === "fail") throw new Error("fork indisponible");
          return (await forkSession(id)).sessionId; // vrai fork du SDK, sur les fixtures temporaires
        },
      },
    );
  });
  after(async () => {
    await server.close();
    if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevEnv;
    tmp.cleanup();
  });

  test("GET /api/cc/projects : projets triés, cwd, nombre de sessions", async () => {
    const r = await get<CcProject[]>("/api/cc/projects");
    assert.equal(r.status, 200);
    const a = r.body.find((p) => p.id === projA)!;
    const b = r.body.find((p) => p.id === projB)!;
    assert.ok(a && b);
    assert.equal(r.body.some((p) => p.id === "C--projet-vide"), false);
    assert.equal(a.sessionCount, 3);
    assert.equal(a.path, originCwd);
    const order = r.body.map((p) => p.lastActivity!);
    assert.deepEqual([...order].sort().reverse(), order);
  });

  test("GET sessions : résumés, tri, filtre q", async () => {
    const r = await get<CcSessionSummary[]>(`/api/cc/projects/${projA}/sessions`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((s) => s.id), [sidA, sidOld]);
    const s = r.body[0]!;
    assert.equal(s.title, "Titre IA synthétique");
    assert.equal(s.messageCount, 4);
    assert.equal(s.cwd, originCwd);
    assert.equal(s.gitBranch, "main");
    assert.equal(s.fromMyClaude, false);
    assert.equal(s.startedAt, "2026-03-02T10:00:00.000Z");
    const q = await get<CcSessionSummary[]>(`/api/cc/projects/${projA}/sessions?q=GAMMA`);
    assert.deepEqual(q.body.map((x) => x.id), [sidOld]);
  });

  test("GET transcription", async () => {
    const r = await get<CcTranscript>(`/api/cc/projects/${projA}/sessions/${sidA}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.truncated, false);
    assert.equal(r.body.messages.length, 4);
    assert.equal(r.body.session.id, sidA);
    assert.equal(r.body.messages[1]!.tools![0]!.resultPreview!.length, PREVIEW_MAX);
  });

  test("traversée / identifiants invalides : 404, rien lu hors de projects", async () => {
    // Secret hors du dossier projects, au même niveau.
    writeJsonl(path.join(tmp.dir, "claude-config", `${sidB}.jsonl`), [{ type: "user", message: { content: "secret" } }]);
    const paths = [
      `/api/cc/projects/..%2F..%2Fx/sessions`,
      `/api/cc/projects/%2E%2E/sessions`,
      `/api/cc/projects/..%5C/sessions/${sidB}`,
      `/api/cc/projects/${projA}/sessions/..%2F${sidB}`,
      `/api/cc/projects/${projA}/sessions/not-a-uuid`,
      `/api/cc/projects/${projA}/sessions/${sidB}`, // existe dans un autre projet seulement
      `/api/cc/projects/inconnu/sessions`,
    ];
    for (const p of paths) {
      const r = await rawRequest(server.port, { path: p });
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes("secret"), p);
    }
    const svc = server.service;
    await assert.rejects(svc.listCcSessions(".."), (e: Error & { status?: number }) => e.status === 404);
    await assert.rejects(svc.getCcTranscript(projA, `../${sidB}`), (e: Error & { status?: number }) => e.status === 404);
  });

  test("protections Host / Origin conservées sur les nouvelles routes", async () => {
    const r1 = await rawRequest(server.port, { path: "/api/cc/projects", headers: { host: "evil.example" } });
    assert.equal(r1.status, 403);
    const r2 = await rawRequest(server.port, {
      method: "POST",
      path: `/api/cc/projects/${projA}/sessions/${sidA}/continue`,
      headers: { origin: "https://evil.example" },
      body: { workspaceDir: originCwd },
    });
    assert.equal(r2.status, 403);
    const r3 = await rawRequest(server.port, { method: "DELETE", path: "/api/cc/projects" });
    assert.equal(r3.status, 405);
  });

  test("continue : dossier refusé → 400 avec raison en français", async () => {
    const url = `/api/cc/projects/${projA}/sessions/${sidA}/continue`;
    const dataDir = server.service.storage.dataDir;
    const cases: unknown[] = [
      {},
      { workspaceDir: "" },
      { workspaceDir: "relatif\\dossier" },
      { workspaceDir: path.parse(originCwd).root },
      { workspaceDir: path.join(tmp.dir, "n-existe-pas") },
      { workspaceDir: path.join(tmp.dir, "home") }, // « dossier perso » qui contient le dataDir (AppData)
      { workspaceDir: path.join(dataDir, "sessions") }, // dans le dataDir
    ];
    const before = (await server.service.listSessions()).length;
    for (const body of cases) {
      const r = await post<{ error: string }>(url, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, /dossier|chemin/i);
    }
    assert.equal((await server.service.listSessions()).length, before, "aucune session créée");
    assert.ok(!existsSync(path.join(tmp.dir, "n-existe-pas")), "le dossier n'est pas créé");
    const r404 = await post<{ error: string }>(`/api/cc/projects/${projA}/sessions/${randomUUID()}/continue`, { workspaceDir: originCwd });
    assert.equal(r404.status, 404);
  });

  test("continue (même dossier) : fork, import, reprise de la COPIE ; original intact", async () => {
    const origBytes = readFileSync(fileA);
    const origMtime = statSync(fileA).mtimeMs;
    forkMode = "real";
    forkCalls = [];
    const r = await post<SessionMeta>(`/api/cc/projects/${projA}/sessions/${sidA}/continue`, { workspaceDir: originCwd });
    assert.equal(r.status, 200);
    const meta = r.body;
    assert.equal(meta.status, "open");
    assert.deepEqual(meta.origin, { type: "claude-code", projectId: projA, sessionId: sidA });
    assert.equal(meta.workspaceDir, path.resolve(originCwd));
    assert.equal(meta.title, "Titre IA synthétique");
    assert.deepEqual(forkCalls, [sidA]);
    assert.ok(meta.engineSessionId && isValidCcSessionId(meta.engineSessionId));
    assert.notEqual(meta.engineSessionId, sidA);
    assert.equal(meta.engineCwd, canonicalize(originCwd));
    const forkFile = path.join(projectsDir, projA, `${meta.engineSessionId}.jsonl`);
    assert.ok(existsSync(forkFile), "la copie forkée est un nouveau fichier");

    const s = await get<{ session: SessionMeta; messages: ChatMessage[] }>(`/api/sessions/${meta.id}`);
    assert.equal(s.body.messages.length, 4);
    assert.ok(s.body.messages.every((m) => m.imported === true));

    // Échange : la copie est reprise, dans le dossier de la session, avec pathguard sur ce dossier.
    const inside = path.join(originCwd, "fichier.txt");
    const outside = path.join(globalWs, "fichier.txt");
    const verdicts: string[] = [];
    fake.script = async (p) => {
      verdicts.push(await simulateTool(p, "t-in", "Read", { file_path: inside }));
      verdicts.push(await simulateTool(p, "t-out", "Read", { file_path: outside }));
      p.onText("Suite");
    };
    const callsBefore = fake.calls.length;
    const ev = await send(meta.id, "On continue ?");
    fake.script = null;
    assert.ok(ev.some((e) => e.event === "done"));
    const call = fake.calls[callsBefore]!;
    assert.equal(call.resume, meta.engineSessionId);
    assert.notEqual(call.resume, sidA);
    assert.equal(call.cwd, canonicalize(originCwd));
    assert.equal(call.prompt, "On continue ?");
    assert.deepEqual(verdicts, ["allow", "deny"]);

    // L'original n'a pas bougé (octets + mtime).
    assert.equal(Buffer.compare(readFileSync(fileA), origBytes), 0);
    assert.equal(statSync(fileA).mtimeMs, origMtime);

    // La copie apparaît comme venant de MyClaude ; l'original non.
    const list = await get<CcSessionSummary[]>(`/api/cc/projects/${projA}/sessions`);
    assert.equal(list.body.find((x) => x.id === meta.engineSessionId)?.fromMyClaude, true);
    assert.equal(list.body.find((x) => x.id === sidA)?.fromMyClaude, false);

    // Suppression : seule la copie est visée, jamais l'original.
    fake.deletedTranscripts = [];
    const del = await rawRequest(server.port, { method: "DELETE", path: `/api/sessions/${meta.id}` });
    assert.equal(del.status, 200);
    assert.deepEqual(fake.deletedTranscripts.map((d) => d.id), [meta.engineSessionId]);
    assert.equal(Buffer.compare(readFileSync(fileA), origBytes), 0);
  });

  test("continue (autre dossier) : pas de fork, réinjection de la transcription importée", async () => {
    const other = path.join(tmp.dir, "autre-dossier");
    mkdirSync(other, { recursive: true });
    forkCalls = [];
    const filesBefore = readdirSync(path.join(projectsDir, projA)).length;
    const r = await post<SessionMeta>(`/api/cc/projects/${projA}/sessions/${sidA}/continue`, { workspaceDir: other });
    assert.equal(r.status, 200);
    assert.equal(r.body.engineSessionId, undefined);
    assert.deepEqual(forkCalls, []);
    assert.equal(readdirSync(path.join(projectsDir, projA)).length, filesBefore);
    const callsBefore = fake.calls.length;
    await send(r.body.id, "Nouveau message");
    const call = fake.calls[callsBefore]!;
    assert.equal(call.resume, undefined);
    assert.equal(call.cwd, canonicalize(other));
    assert.match(call.prompt, /Question synthétique alpha/);
    assert.match(call.prompt, /Nouveau message/);
  });

  test("continue : fork en échec → session créée quand même, réinjection, original jamais repris", async () => {
    forkMode = "fail";
    const r = await post<SessionMeta>(`/api/cc/projects/${projA}/sessions/${sidA}/continue`, { workspaceDir: originCwd });
    forkMode = "real";
    assert.equal(r.status, 200);
    assert.equal(r.body.engineSessionId, undefined);
    // Même si une meta pointait l'original, il ne serait pas repris.
    await server.service.storage.updateMeta(r.body.id, (m) => {
      m.engineSessionId = sidA;
      m.engineCwd = canonicalize(originCwd);
    });
    const callsBefore = fake.calls.length;
    await send(r.body.id, "Encore");
    const call = fake.calls[callsBefore]!;
    assert.notEqual(call.resume, sidA);
    assert.match(call.prompt, /Réponse synthétique alpha/);
  });

  test("bilan : seuls les messages non importés sont analysés", async () => {
    const svc = server.service;
    // 1) Uniquement des messages importés → bilan « done » sans appel au modèle.
    const r1 = await post<SessionMeta>(`/api/cc/projects/${projA}/sessions/${sidOld}/continue`, { workspaceDir: originCwd });
    const jsonBefore = fake.jsonCalls;
    await post(`/api/sessions/${r1.body.id}/close`, {});
    await svc.reviews.idle();
    assert.equal(fake.jsonCalls, jsonBefore);
    assert.equal((await svc.storage.getMeta(r1.body.id))!.review, "done");

    // 2) Avec un échange MyClaude → le prompt du bilan ne contient pas les messages importés.
    const r2 = await post<SessionMeta>(`/api/cc/projects/${projA}/sessions/${sidOld}/continue`, { workspaceDir: originCwd });
    await send(r2.body.id, "Message fait dans MyClaude");
    fake.jsonPrompts = [];
    await post(`/api/sessions/${r2.body.id}/close`, {});
    await svc.reviews.idle();
    assert.equal(fake.jsonPrompts.length, 1);
    assert.match(fake.jsonPrompts[0]!, /Message fait dans MyClaude/);
    assert.doesNotMatch(fake.jsonPrompts[0]!, /Question synthétique alpha|Réponse synthétique alpha/);
  });
});
