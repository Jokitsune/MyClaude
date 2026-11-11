// Faux serveur en mémoire pour développer l'interface sans le serveur (VITE_MOCK=1 ou `npm run dev:mock`).
import type { Api } from "./api";
import { ApiError } from "./errors";
import type { AppConfig, ChatMessage, Lesson, SessionMeta } from "./types";

const MODELS: AppConfig["availableModels"] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-2", label: "Fable 5.2" },
];

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Interrompu", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Interrompu", "AbortError"));
      },
      { once: true },
    );
  });

const iso = (offsetMs = 0) => new Date(Date.now() - offsetMs).toISOString();
let counter = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(counter++).toString(36)}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const SAMPLE_REPLY = `Voici une réponse de démonstration (mode **maquette**), pour vérifier le rendu.

## Exemple de code

\`\`\`ts
function saluer(nom: string): string {
  return \`Bonjour, \${nom} !\`;
}
\`\`\`

## Un petit tableau

| Élément | État |
|---|---|
| Interface | prête |
| Serveur | simulé |

- Les conversations restent **locales**.
- Seuls les appels au modèle sortent vers l'API.

Du \`code en ligne\` et un [lien](https://example.com) pour finir.`;

export function createMockApi(): Api {
  const config = {
    apiKey: "sk-mock" as string | null,
    model: "claude-opus-5-5",
    effort: "medium" as AppConfig["effort"],
  };
  const sessions = new Map<string, { meta: SessionMeta; messages: ChatMessage[] }>();
  const lessons: Lesson[] = [];
  let memory = "# Mémoire\n\n- L'utilisateur préfère des réponses concises en français.\n";

  // Données d'exemple
  {
    const id = "2026-11-10_091500_ab12";
    const meta: SessionMeta = {
      id,
      title: "Plan de migration vers Vite",
      status: "closed",
      closeReason: "user",
      createdAt: iso(26 * 3600e3),
      updatedAt: iso(25 * 3600e3),
      lastHeartbeat: iso(25 * 3600e3),
      model: "claude-opus-5-5",
      review: "done",
    };
    sessions.set(id, {
      meta,
      messages: [
        { id: uid("m"), role: "user", text: "Comment migrer un projet Webpack vers Vite ?", createdAt: iso(26 * 3600e3) },
        {
          id: uid("m"),
          role: "assistant",
          thinking: "L'utilisateur veut un plan pratique. Je résume les étapes clés.",
          text: "1. Installer `vite` et le plugin adapté.\n2. Déplacer `index.html` à la racine.\n3. Remplacer les variables `process.env` par `import.meta.env`.",
          createdAt: iso(26 * 3600e3 - 5000),
        },
      ],
    });
    const id2 = "2026-11-09_180200_cd34";
    sessions.set(id2, {
      meta: {
        id: id2,
        title: "Idées de recettes d'automne",
        status: "interrupted",
        closeReason: "recovered",
        createdAt: iso(3 * 86400e3),
        updatedAt: iso(3 * 86400e3),
        lastHeartbeat: iso(3 * 86400e3),
        model: "claude-sonnet-5-5",
        review: "pending",
      },
      messages: [
        { id: uid("m"), role: "user", text: "Des idées de recettes avec du potimarron ?", createdAt: iso(3 * 86400e3) },
        {
          id: uid("m"),
          role: "assistant",
          text: "Velouté de potimarron, gratin, risotto…",
          error: "Réponse interrompue (coupure).",
          createdAt: iso(3 * 86400e3),
        },
      ],
    });
    lessons.push(
      {
        id: uid("l"),
        sessionId: id,
        createdAt: iso(25 * 3600e3),
        status: "pending",
        kind: "preference",
        text: "Donner des étapes numérotées pour les migrations techniques.",
        rationale: "L'utilisateur a bien réagi au plan en étapes.",
      },
      {
        id: uid("l"),
        sessionId: id,
        createdAt: iso(25 * 3600e3),
        status: "pending",
        kind: "fact",
        text: "L'utilisateur travaille sous Windows 11 avec Node 24.",
        rationale: "Mentionné explicitement pendant la session.",
      },
      {
        id: uid("l"),
        sessionId: id,
        createdAt: iso(5 * 86400e3),
        status: "approved",
        kind: "preference",
        text: "Répondre en français, de façon concise.",
        rationale: "Demande explicite.",
      },
      {
        id: uid("l"),
        sessionId: id,
        createdAt: iso(6 * 86400e3),
        status: "rejected",
        kind: "mistake",
        text: "Éviter les tableaux.",
        rationale: "Supposition non confirmée.",
      },
    );
  }

  const cfg = (): AppConfig => ({
    hasApiKey: !!config.apiKey,
    model: config.model,
    effort: config.effort,
    dataDir: "C:\\Users\\vous\\AppData\\Roaming\\MyClaude\\data",
    availableModels: MODELS,
  });

  const get = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new ApiError(404, "Session introuvable.");
    return s;
  };

  const lesson = (id: string) => {
    const l = lessons.find((x) => x.id === id);
    if (!l) throw new ApiError(404, "Leçon introuvable.");
    return l;
  };

  return {
    async health() {
      return { ok: true, version: "mock" };
    },
    async getConfig() {
      await wait(80);
      return cfg();
    },
    async putConfig(u) {
      await wait(120);
      if (u.apiKey !== undefined) config.apiKey = u.apiKey;
      if (u.model) config.model = u.model;
      if (u.effort) config.effort = u.effort;
      return cfg();
    },
    async listSessions() {
      await wait(60);
      return [...sessions.values()]
        .map((s) => clone(s.meta))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async createSession(title) {
      await wait(60);
      const now = iso();
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const id = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(
        d.getMinutes(),
      )}${p(d.getSeconds())}_${Math.random().toString(16).slice(2, 6)}`;
      const meta: SessionMeta = {
        id,
        title: title || "Nouvelle session",
        status: "open",
        createdAt: now,
        updatedAt: now,
        lastHeartbeat: now,
        model: config.model,
        review: "pending",
      };
      sessions.set(id, { meta, messages: [] });
      return clone(meta);
    },
    async getSession(id) {
      await wait(80);
      const s = get(id);
      return { session: clone(s.meta), messages: clone(s.messages) };
    },
    async deleteSession(id) {
      get(id);
      sessions.delete(id);
      for (let i = lessons.length - 1; i >= 0; i--) {
        if (lessons[i].sessionId === id && lessons[i].status === "pending") lessons.splice(i, 1);
      }
      return { ok: true };
    },
    async heartbeat(id) {
      get(id).meta.lastHeartbeat = iso();
      return { ok: true };
    },
    async closeSession(id) {
      await wait(150);
      const s = get(id);
      s.meta.status = "closed";
      s.meta.closeReason = "user";
      s.meta.updatedAt = iso();
      if (s.messages.length > 0) {
        s.meta.review = "running";
        setTimeout(() => {
          s.meta.review = "done";
          lessons.push({
            id: uid("l"),
            sessionId: id,
            createdAt: iso(),
            status: "pending",
            kind: "success",
            text: "Inclure un exemple de code court quand une notion technique est expliquée.",
            rationale: "Leçon simulée par le mode maquette.",
          });
        }, 2500);
      }
      return clone(s.meta);
    },
    async sendMessage(id, text, onEvent, signal) {
      const s = get(id);
      if (s.meta.status !== "open") throw new ApiError(409, "Cette session n'est plus ouverte.");
      if (!config.apiKey) throw new ApiError(400, "Aucune clé API n'est configurée.");
      await wait(150, signal);
      const user: ChatMessage = { id: uid("m"), role: "user", text, createdAt: iso() };
      s.messages.push(user);
      if (s.meta.title === "Nouvelle session") s.meta.title = text.split(/\s+/).slice(0, 6).join(" ");
      s.meta.updatedAt = iso();
      onEvent({ type: "user", message: clone(user) });

      let thinking = "";
      let out = "";
      const persistPartial = (error: string) => {
        s.messages.push({ id: uid("m"), role: "assistant", text: out, thinking, error, createdAt: iso() });
      };
      try {
        for (const chunk of ["Je réfléchis à la demande ", "et je prépare une réponse ", "structurée."]) {
          await wait(180, signal);
          thinking += chunk;
          onEvent({ type: "thinking", text: chunk });
        }
        if (/erreur/i.test(text)) {
          await wait(300, signal);
          const error = "Erreur simulée : le modèle est momentanément indisponible.";
          persistPartial(error);
          onEvent({ type: "error", error });
          return;
        }
        const tokens = SAMPLE_REPLY.match(/[\s\S]{1,6}/g) ?? [];
        for (const t of tokens) {
          await wait(18, signal);
          out += t;
          onEvent({ type: "delta", text: t });
        }
      } catch (e) {
        persistPartial("Réponse interrompue.");
        throw e;
      }
      const done: ChatMessage = {
        id: uid("m"),
        role: "assistant",
        text: out,
        thinking,
        createdAt: iso(),
        usage: { input_tokens: 42, output_tokens: 180 },
      };
      s.messages.push(done);
      s.meta.updatedAt = iso();
      onEvent({ type: "done", message: clone(done) });
    },
    async listLessons(status) {
      await wait(80);
      return clone(status ? lessons.filter((l) => l.status === status) : lessons);
    },
    async approveLesson(id, text) {
      await wait(120);
      const l = lesson(id);
      if (text !== undefined) l.text = text;
      l.status = "approved";
      memory = `${memory.replace(/\s*$/, "")}\n- ${l.text}\n`;
      return clone(l);
    },
    async rejectLesson(id) {
      await wait(120);
      const l = lesson(id);
      l.status = "rejected";
      return clone(l);
    },
    async getMemory() {
      await wait(60);
      return { content: memory };
    },
    async putMemory(content) {
      await wait(150);
      memory = content;
      return { content };
    },
  };
}
