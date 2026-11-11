import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { startServerInternal, type InternalRunningServer } from "../src/app.js";
import { silentLogger } from "../src/log.js";
import type { ChatMessage, PermissionRequest, SessionMeta, ToolCall } from "../src/types.js";
import { FakeProvider, openSse, rawRequest, simulateTool, tmpDir } from "./helpers.js";

const TIMEOUT_MS = 1200;

describe("permissions des outils (moteur factice)", () => {
  let tmp: ReturnType<typeof tmpDir>;
  let server: InternalRunningServer;
  let ws: string;
  const fake = new FakeProvider();

  before(async () => {
    tmp = tmpDir();
    ws = path.join(tmp.dir, "ws");
    server = await startServerInternal(
      { port: 0, dataDir: path.join(tmp.dir, "data") },
      {
        providerFactory: () => fake,
        logger: silentLogger,
        idleCheck: false,
        permissionTimeoutMs: TIMEOUT_MS,
        defaultWorkspaceDir: ws,
      },
    );
  });
  after(async () => {
    await server.close();
    tmp.cleanup();
  });
  afterEach(() => {
    fake.script = null;
  });

  const req = (o: Parameters<typeof rawRequest>[1]) => rawRequest(server.port, o);
  const newSession = async () =>
    JSON.parse((await req({ method: "POST", path: "/api/sessions", body: {} })).body) as SessionMeta;
  const send = (id: string, text = "Fais-le") => openSse(server.port, `/api/sessions/${id}/messages`, { text });
  const decide = (sid: string, reqId: string, decision: string) =>
    req({ method: "POST", path: `/api/sessions/${sid}/permissions/${reqId}`, body: { decision } });
  const journal = (sid: string) =>
    readFileSync(path.join(tmp.dir, "data", "sessions", sid, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; tool?: string; decision?: string; by?: string; toolCallId?: string });
  const permissionEvents = (sid: string) => journal(sid).filter((e) => e.type === "permission");

  /** Écrit un fichier via l'outil Write puis rend compte du résultat. */
  const writeScript = (count = 1, tool = "Write") =>
    (fake.script = async (p) => {
      for (let i = 1; i <= count; i++) {
        const input = tool === "Bash" ? { command: "dir" } : { file_path: `notes${i}.txt`, content: "x" };
        const d = await simulateTool(p, `toolu_${i}`, tool, input);
        p.onText(d === "allow" ? `ok${i} ` : `refus${i} `);
      }
    });

  test("allow : demande émise, validation, outil exécuté et journalisé", async () => {
    writeScript();
    const s = await newSession();
    const sse = send(s.id);
    const pr = (await sse.waitFor("permission_request")).data as PermissionRequest;
    assert.equal(pr.sessionId, s.id);
    assert.equal(pr.tool, "Write");
    assert.equal(pr.toolCallId, "toolu_1");
    assert.match(pr.summary, /Écrire le fichier notes1\.txt/);
    assert.equal((await decide(s.id, pr.id, "allow")).status, 200);
    await sse.finished;

    const types = sse.events.map((e) => e.event);
    // Un seul tool_use par appel ; permission_request le référence ; tool_result donne le statut final.
    assert.deepEqual(types, ["user", "tool_use", "permission_request", "tool_result", "delta", "done"]);
    assert.equal((sse.events[1]!.data as ToolCall).id, pr.toolCallId);
    assert.deepEqual(sse.events[3]!.data, { id: "toolu_1", status: "done", resultPreview: "ok" });
    const done = sse.events.at(-1)!.data as ChatMessage;
    assert.equal(done.text, "ok1 ");
    assert.equal(done.tools?.length, 1);
    assert.equal(done.tools![0]!.status, "done");
    assert.equal(done.tools![0]!.name, "Write");

    // Persisté dans le message assistant.
    const got = JSON.parse((await req({ path: `/api/sessions/${s.id}` })).body) as { messages: ChatMessage[] };
    assert.equal(got.messages[1]!.tools![0]!.status, "done");
    assert.deepEqual(
      permissionEvents(s.id).map((e) => [e.tool, e.decision, e.by]),
      [["Write", "allow", "user"]],
    );
    // Demande déjà traitée → 404.
    assert.equal((await decide(s.id, pr.id, "allow")).status, 404);
  });

  test("deny : outil refusé, statut denied, journalisé", async () => {
    writeScript();
    const s = await newSession();
    const sse = send(s.id);
    const pr = (await sse.waitFor("permission_request")).data as PermissionRequest;
    await decide(s.id, pr.id, "deny");
    await sse.finished;
    const result = sse.events.find((e) => e.event === "tool_result")!.data as { status: string; resultPreview: string };
    assert.equal(result.status, "denied");
    assert.match(result.resultPreview, /refusé/);
    const done = sse.events.at(-1)!.data as ChatMessage;
    assert.equal(done.text, "refus1 ");
    assert.equal(done.tools![0]!.status, "denied");
    assert.deepEqual(
      permissionEvents(s.id).map((e) => [e.decision, e.by]),
      [["deny", "user"]],
    );
  });

  test("allow_session : plus de demande pour cet outil dans la session (mais Bash redemande)", async () => {
    writeScript(3);
    const s = await newSession();
    const sse = send(s.id);
    const pr = (await sse.waitFor("permission_request")).data as PermissionRequest;
    await decide(s.id, pr.id, "allow_session");
    await sse.finished;
    assert.equal(sse.events.filter((e) => e.event === "permission_request").length, 1);
    assert.equal((sse.events.at(-1)!.data as ChatMessage).text, "ok1 ok2 ok3 ");
    assert.deepEqual(
      permissionEvents(s.id).map((e) => e.by),
      ["user", "session", "session"],
    );

    // Message suivant, même session : toujours autorisé ; Bash, lui, redemande.
    writeScript(1);
    const sse2 = send(s.id, "Encore");
    await sse2.finished;
    assert.equal(sse2.events.filter((e) => e.event === "permission_request").length, 0);

    writeScript(1, "Bash");
    const sse3 = send(s.id, "Commande");
    const pr3 = (await sse3.waitFor("permission_request")).data as PermissionRequest;
    assert.equal(pr3.tool, "Bash");
    assert.match(pr3.summary, /Exécuter la commande : dir/);
    await decide(s.id, pr3.id, "deny");
    await sse3.finished;

    // Une autre session n'hérite pas de l'autorisation.
    writeScript(1);
    const other = await newSession();
    const sse4 = send(other.id);
    const pr4 = (await sse4.waitFor("permission_request")).data as PermissionRequest;
    // Une session ne peut pas répondre pour une autre.
    assert.equal((await decide(s.id, pr4.id, "allow")).status, 404);
    await decide(other.id, pr4.id, "deny");
    await sse4.finished;
  });

  test("sans réponse dans le délai → refus (timeout)", async () => {
    writeScript();
    const s = await newSession();
    const sse = send(s.id);
    await sse.waitFor("permission_request");
    await sse.finished;
    const done = sse.events.at(-1)!.data as ChatMessage;
    assert.equal(done.tools![0]!.status, "denied");
    assert.match(done.tools![0]!.resultPreview ?? "", /délai/);
    assert.deepEqual(
      permissionEvents(s.id).map((e) => [e.decision, e.by]),
      [["deny", "timeout"]],
    );
  });

  test("client déconnecté pendant l'attente → refus (disconnect), réponse journalisée", async () => {
    writeScript();
    const s = await newSession();
    const sse = send(s.id);
    await sse.waitFor("permission_request");
    sse.destroy();
    let messages: ChatMessage[] = [];
    for (let i = 0; i < 100; i++) {
      messages = (JSON.parse((await req({ path: `/api/sessions/${s.id}` })).body) as { messages: ChatMessage[] }).messages;
      if (messages.length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(messages.length, 2);
    assert.match(messages[1]!.error ?? "", /interrompue/);
    assert.equal(messages[1]!.tools![0]!.status, "denied");
    assert.deepEqual(
      permissionEvents(s.id).map((e) => [e.decision, e.by]),
      [["deny", "disconnect"]],
    );
    assert.equal(server.service.permissions.pendingCount, 0);
  });

  test("décisions automatiques : lecture dans le dossier autorisée, hors dossier et hors gouvernance refusées", async () => {
    fake.script = async (p) => {
      const results = [
        await simulateTool(p, "r1", "Read", { file_path: "notes1.txt" }),
        await simulateTool(p, "r2", "Read", { file_path: "../data/config.json" }),
        await simulateTool(p, "r3", "Write", { file_path: path.join(tmp.dir, "data", "memory.md"), content: "x" }),
        await simulateTool(p, "r4", "NotebookEdit", { notebook_path: "a.ipynb", new_source: "" }),
        await simulateTool(p, "r5", "Grep", { pattern: "x", path: "." }),
      ];
      p.onText(results.join(","));
    };
    const s = await newSession();
    const sse = send(s.id);
    await sse.finished;
    assert.equal(sse.events.filter((e) => e.event === "permission_request").length, 0);
    const done = sse.events.at(-1)!.data as ChatMessage;
    assert.equal(done.text, "allow,deny,deny,deny,allow");
    assert.deepEqual(
      done.tools!.map((t) => t.status),
      ["done", "denied", "denied", "denied", "done"],
    );
    assert.match(done.tools![1]!.resultPreview ?? "", /en dehors du dossier de travail/);
    assert.match(done.tools![3]!.resultPreview ?? "", /pas autorisé par la gouvernance/);
    assert.deepEqual(
      permissionEvents(s.id).map((e) => [e.tool, e.decision, e.by]),
      [
        ["Read", "allow", "auto"],
        ["Read", "deny", "auto"],
        ["Write", "deny", "auto"],
        ["NotebookEdit", "deny", "auto"],
        ["Grep", "allow", "auto"],
      ],
    );
    // Le moteur reçoit le dossier de travail comme cwd et les outils de la gouvernance.
    const last = fake.calls.at(-1)!;
    assert.equal(last.cwd.toLowerCase(), ws.toLowerCase());
    assert.ok(last.tools.includes("Read") && last.tools.includes("Bash"));
  });

  test("route de décision : validation", async () => {
    const s = await newSession();
    assert.equal((await decide(s.id, "00000000-0000-4000-8000-000000000000", "allow")).status, 404);
    assert.equal((await decide(s.id, "00000000-0000-4000-8000-000000000000", "peut-être")).status, 400);
    assert.equal((await decide(s.id, "..%2F..", "allow")).status, 404);
    assert.equal((await req({ path: `/api/sessions/${s.id}/permissions/abcdefgh123` })).status, 405);
  });
});
