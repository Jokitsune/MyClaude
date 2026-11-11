import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { startServerInternal, type InternalRunningServer } from "../src/app.js";
import { DEFAULT_TOOLS } from "../src/governance.js";
import { silentLogger } from "../src/log.js";
import { FakeProvider, rawRequest, tmpDir } from "./helpers.js";

describe("gouvernance et configuration v2", () => {
  let tmp: ReturnType<typeof tmpDir>;
  let server: InternalRunningServer;
  let dataDir: string;
  const fake = new FakeProvider();

  before(async () => {
    tmp = tmpDir();
    dataDir = path.join(tmp.dir, "data");
    server = await startServerInternal(
      { port: 0, dataDir },
      { providerFactory: () => fake, logger: silentLogger, idleCheck: false, defaultWorkspaceDir: path.join(tmp.dir, "ws") },
    );
  });
  after(async () => {
    await server.close();
    tmp.cleanup();
  });
  const req = (o: Parameters<typeof rawRequest>[1]) => rawRequest(server.port, o);
  const put = (body: unknown) => req({ method: "PUT", path: "/api/governance", body });

  test("fichiers par défaut créés au premier démarrage (FR)", async () => {
    for (const f of ["system.md", "tools.json", "mcp.json", "agents.json"]) {
      assert.ok(existsSync(path.join(dataDir, "governance", f)), f);
    }
    const g = JSON.parse((await req({ path: "/api/governance" })).body);
    assert.match(g.system, /français/);
    assert.deepEqual(g.tools, DEFAULT_TOOLS);
    assert.deepEqual(g.mcp, { mcpServers: {} });
    assert.deepEqual(g.agents, {});
  });

  test("PUT partiel valide : écrit sur disque, le reste inchangé", async () => {
    const r = await put({
      tools: { allowed: ["Read", "Grep", "mcp__notes__search"] },
      mcp: { mcpServers: { notes: { command: "node", args: ["notes.js"], env: { A: "1" } }, web: { type: "http", url: "https://x.example/mcp" } } },
      agents: { relecteur: { description: "Relit", prompt: "Tu relis.", tools: ["Read"], model: "haiku" } },
    });
    assert.equal(r.status, 200, r.body);
    const g = JSON.parse(r.body);
    assert.deepEqual(g.tools.allowed, ["Read", "Grep", "mcp__notes__search"]);
    assert.match(g.system, /français/);
    const onDisk = JSON.parse(readFileSync(path.join(dataDir, "governance", "mcp.json"), "utf8"));
    assert.equal(onDisk.mcpServers.web.url, "https://x.example/mcp");
  });

  test("PUT invalide → 400 en français, rien n'est écrit", async () => {
    const before = readFileSync(path.join(dataDir, "governance", "tools.json"), "utf8");
    const cases: [unknown, RegExp][] = [
      [[], /Corps/],
      [{ inconnu: 1 }, /Champ inconnu/],
      [{ system: 42 }, /system/],
      [{ tools: ["Read"] }, /allowed/],
      [{ tools: { allowed: ["Read", "Destroy"] } }, /outil inconnu « Destroy »/],
      [{ tools: { allowed: [1] } }, /nom d'outil invalide/],
      [{ mcp: { servers: {} } }, /mcpServers/],
      [{ mcp: { mcpServers: { "x y": { command: "a" } } } }, /nom de serveur invalide/],
      [{ mcp: { mcpServers: { a: { args: [] } } } }, /command/],
      [{ mcp: { mcpServers: { a: { type: "http", url: "file:///c:/x" } } } }, /url/],
      [{ mcp: { mcpServers: { a: { type: "ws", url: "https://x" } } } }, /type inconnu/],
      [{ agents: { a: { description: "d" } } }, /prompt/],
      [{ agents: { a: { description: "d", prompt: "p", tools: "Read" } } }, /liste/],
      // Un champ valide + un invalide : rien n'est écrit.
      [{ tools: { allowed: ["Read"] }, agents: { "": {} } }, /nom invalide/],
    ];
    for (const [body, re] of cases) {
      const r = await put(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(JSON.parse(r.body).error, re, JSON.stringify(body));
    }
    assert.equal(readFileSync(path.join(dataDir, "governance", "tools.json"), "utf8"), before);
  });

  test("fichier modifié à la main et invalide : valeur sûre par défaut", async () => {
    writeFileSync(path.join(dataDir, "governance", "agents.json"), "{ pas du json");
    const g = JSON.parse((await req({ path: "/api/governance" })).body);
    assert.deepEqual(g.agents, {});
  });

  test("PUT /api/config : authMode et workspaceDir validés, dossier créé", async () => {
    const ws = path.join(tmp.dir, "nouveau", "travail");
    let r = await req({ method: "PUT", path: "/api/config", body: { workspaceDir: ws, authMode: "apiKey", apiKey: "sk-ant-x" } });
    assert.equal(r.status, 200, r.body);
    const cfg = JSON.parse(r.body);
    assert.equal(cfg.workspaceDir, ws);
    assert.equal(cfg.authMode, "apiKey");
    assert.ok(existsSync(ws));
    assert.ok(!r.body.includes("sk-ant-x"));

    const bad: [unknown, RegExp][] = [
      [{ workspaceDir: "relatif/dossier" }, /absolu/],
      [{ workspaceDir: "" }, /chemin/],
      [{ workspaceDir: 3 }, /chemin/],
      [{ workspaceDir: path.parse(tmp.dir).root }, /racine/],
      [{ workspaceDir: dataDir }, /données de MyClaude/],
      [{ workspaceDir: path.join(dataDir, "sous") }, /données de MyClaude/],
      [{ workspaceDir: tmp.dir }, /données de MyClaude/],
      [{ authMode: "oauth" }, /subscription ou apiKey/],
    ];
    for (const [body, re] of bad) {
      r = await req({ method: "PUT", path: "/api/config", body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(JSON.parse(r.body).error, re, JSON.stringify(body));
    }
    r = await req({ method: "PUT", path: "/api/config", body: { authMode: "subscription" } });
    assert.equal(JSON.parse(r.body).authMode, "subscription");
  });

  test("état du moteur mis en cache, rafraîchi sur demande", async () => {
    fake.engineStatus = { ready: false, account: null, error: "Connecte-toi à Claude Code (`claude` puis `/login`)." };
    let cfg = JSON.parse((await req({ path: "/api/config?refresh=1" })).body);
    assert.equal(cfg.engineReady, false);
    assert.match(cfg.engineError, /login/);
    assert.equal(cfg.account, null);
    const n = fake.statusCalls;
    await req({ path: "/api/config" });
    assert.equal(fake.statusCalls, n, "pas de nouveau sondage dans le délai de cache");
    fake.engineStatus = { ready: true, account: { email: "a@b.c" } };
    cfg = JSON.parse((await req({ path: "/api/config?refresh=1" })).body);
    assert.equal(cfg.engineReady, true);
    assert.equal(cfg.engineError, undefined);
  });
});
