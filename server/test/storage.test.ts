import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { silentLogger } from "../src/log.js";
import { ProviderError } from "../src/providers/types.js";
import { AppService } from "../src/service.js";
import { Storage, isValidSessionId, nowIso } from "../src/storage.js";
import type { ChatMessage } from "../src/types.js";
import { FakeProvider, tmpDir } from "./helpers.js";

const msg = (role: ChatMessage["role"], text: string): ChatMessage => ({
  id: `${role}-${Math.random().toString(36).slice(2)}`,
  role,
  text,
  createdAt: nowIso(),
});

let tmp: ReturnType<typeof tmpDir>;
let storage: Storage;

beforeEach(async () => {
  tmp = tmpDir();
  storage = new Storage(tmp.dir);
  await storage.init();
});
afterEach(() => tmp.cleanup());

describe("stockage", () => {
  test("une dernière ligne JSONL tronquée est ignorée et l'ajout suivant reste lisible", async () => {
    const s = await storage.createSession({ model: "claude-opus-5-5" });
    await storage.appendMessage(s.id, msg("user", "Salut"));
    const file = path.join(tmp.dir, "sessions", s.id, "events.jsonl");
    appendFileSync(file, '{"t":"2026-11-11T10:00:00Z","type":"message","message":{"id":"x","ro'); // coupure

    let messages = await storage.readMessages(s.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.text, "Salut");

    await storage.appendMessage(s.id, msg("assistant", "Bonjour"));
    messages = await storage.readMessages(s.id);
    assert.deepEqual(
      messages.map((m) => m.text),
      ["Salut", "Bonjour"],
    );
    // La ligne tronquée n'a pas été soudée à la nouvelle.
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 3);
  });

  test("identifiants de session : traversée de chemin refusée", async () => {
    assert.equal(isValidSessionId("2026-11-11_143207_ab12"), true);
    for (const bad of ["..", "../config", "2026-11-11_143207_ab12/..", "..\\x", "", "a".repeat(30)]) {
      assert.equal(isValidSessionId(bad), false, bad);
      assert.equal(await storage.getMeta(bad), undefined);
    }
  });

  test("config : écriture atomique, valeurs par défaut", async () => {
    const cfg = await storage.readConfig();
    assert.equal(cfg.model, "claude-opus-5-5");
    assert.equal(cfg.effort, "medium");
    await storage.updateConfig((c) => ({ ...c, apiKey: "sk-test", effort: "high" }));
    const raw = JSON.parse(readFileSync(path.join(tmp.dir, "config.json"), "utf8"));
    assert.equal(raw.apiKey, "sk-test");
    assert.equal(raw.effort, "high");
  });
});

describe("récupération au démarrage", () => {
  test("session open au heartbeat périmé → interrupted (recovered) ; heartbeat récent → reste open", async () => {
    const stale = await storage.createSession({ model: "claude-opus-5-5" });
    const fresh = await storage.createSession({ model: "claude-opus-5-5" });
    await storage.updateMeta(stale.id, (m) => {
      m.lastHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();
    });
    const svc = new AppService(storage, () => null, silentLogger);
    await svc.recover();

    const s1 = await storage.requireMeta(stale.id);
    assert.equal(s1.status, "interrupted");
    assert.equal(s1.closeReason, "recovered");
    const events = await storage.readEvents(stale.id);
    assert.deepEqual(events.at(-1) && { type: events.at(-1)!.type, reason: (events.at(-1) as { reason?: string }).reason }, {
      type: "closed",
      reason: "recovered",
    });
    assert.equal((await storage.requireMeta(fresh.id)).status, "open");

    // Une seconde récupération ne rajoute pas d'événement.
    await svc.recover();
    assert.equal((await storage.readEvents(stale.id)).length, events.length);
  });

  test("bilan resté `running` → repassé en `pending`", async () => {
    const s = await storage.createSession({ model: "claude-opus-5-5" });
    await storage.closeSession(s.id, "user");
    await storage.updateMeta(s.id, (m) => {
      m.review = "running";
    });
    await new AppService(storage, () => null, silentLogger).recover();
    assert.equal((await storage.requireMeta(s.id)).review, "pending");
  });

  test("inactivité > 30 min → closed (idle)", async () => {
    const s = await storage.createSession({ model: "claude-opus-5-5" });
    const svc = new AppService(storage, () => null, silentLogger);
    await svc.checkIdle(Date.now() + 31 * 60_000);
    const m = await storage.requireMeta(s.id);
    assert.equal(m.status, "closed");
    assert.equal(m.closeReason, "idle");
    await svc.reviews.stop();
  });
});

describe("bilan", () => {
  async function closedSessionWithExchange() {
    const s = await storage.createSession({ model: "claude-opus-5-5" });
    await storage.appendMessage(s.id, msg("user", "Réponds toujours en français."));
    await storage.appendMessage(s.id, msg("assistant", "D'accord."));
    await storage.closeSession(s.id, "user");
    return s;
  }

  test("idempotent : une seule exécution malgré plusieurs déclenchements, `done` jamais refait", async () => {
    const fake = new FakeProvider();
    const svc = new AppService(storage, () => fake, silentLogger);
    const s = await closedSessionWithExchange();

    svc.reviews.enqueue(s.id);
    svc.reviews.enqueue(s.id);
    await svc.reviews.scan();
    await svc.reviews.idle();
    assert.equal(fake.jsonCalls, 1);
    assert.equal((await storage.requireMeta(s.id)).review, "done");
    assert.equal((await storage.listLessons("pending")).length, 1);

    await svc.reviews.scan();
    svc.reviews.enqueue(s.id);
    await svc.reviews.idle();
    assert.equal(fake.jsonCalls, 1);
    assert.equal((await storage.listLessons()).length, 1);
  });

  test("sans clé API : reste `pending` ; une session open n'est jamais traitée", async () => {
    const svc = new AppService(storage, () => null, silentLogger);
    const s = await closedSessionWithExchange();
    const open = await storage.createSession({ model: "claude-opus-5-5" });
    svc.reviews.enqueue(s.id);
    svc.reviews.enqueue(open.id);
    await svc.reviews.idle();
    assert.equal((await storage.requireMeta(s.id)).review, "pending");
    assert.equal((await storage.requireMeta(open.id)).review, "pending");
  });

  test("échec → `failed` avec message, retenté au scan suivant", async () => {
    const fake = new FakeProvider();
    fake.jsonError = new ProviderError("rate_limit", "Limite de débit atteinte.");
    const svc = new AppService(storage, () => fake, silentLogger);
    const s = await closedSessionWithExchange();
    svc.reviews.enqueue(s.id);
    await svc.reviews.idle();
    let m = await storage.requireMeta(s.id);
    assert.equal(m.review, "failed");
    assert.equal(m.reviewError, "Limite de débit atteinte.");

    fake.jsonError = null;
    await svc.reviews.scan();
    await svc.reviews.idle();
    m = await storage.requireMeta(s.id);
    assert.equal(m.review, "done");
    assert.equal(m.reviewError, undefined);
    assert.equal(fake.jsonCalls, 2);
  });

  test("moteur non connecté → bilan reste `pending` (retenté), pas `failed`", async () => {
    const fake = new FakeProvider();
    fake.jsonError = new ProviderError("not_logged_in", "Connecte-toi à Claude Code (`claude` puis `/login`).");
    const svc = new AppService(storage, () => fake, silentLogger);
    const s = await closedSessionWithExchange();
    svc.reviews.enqueue(s.id);
    await svc.reviews.idle();
    const m = await storage.requireMeta(s.id);
    assert.equal(m.review, "pending");
    assert.equal(m.reviewError, undefined);
  });

  test("bilan au JSON invalide → `failed`", async () => {
    const fake = new FakeProvider();
    fake.jsonResult = { pasDeLecons: true };
    const svc = new AppService(storage, () => fake, silentLogger);
    const s = await closedSessionWithExchange();
    svc.reviews.enqueue(s.id);
    await svc.reviews.idle();
    assert.equal((await storage.requireMeta(s.id)).review, "failed");
  });

  test("approbation : ajout à memory.md sans doublon", async () => {
    const fake = new FakeProvider();
    const svc = new AppService(storage, () => fake, silentLogger);
    const s = await closedSessionWithExchange();
    svc.reviews.enqueue(s.id);
    await svc.reviews.idle();
    const [lesson] = await storage.listLessons("pending");
    const approved = await svc.approveLesson(lesson!.id, { text: "Toujours répondre en français." });
    assert.equal(approved.status, "approved");
    await svc.approveLesson(lesson!.id, {});
    assert.equal(await storage.readMemory(), "- Toujours répondre en français.\n");
  });
});
