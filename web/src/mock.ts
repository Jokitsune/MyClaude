// Faux serveur en mémoire pour développer l'interface sans le serveur (VITE_MOCK=1 ou `npm run dev:mock`).
import type { Api } from "./api";
import { ApiError } from "./errors";
import type {
  AppConfig,
  ChatMessage,
  Governance,
  Lesson,
  PermissionDecision,
  PermissionRequest,
  SessionMeta,
  ToolCall,
} from "./types";
import { summaryText } from "./tools";

const MODELS: AppConfig["availableModels"] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "opus", label: "Opus (alias, dernière version)" },
  { id: "sonnet", label: "Sonnet (alias, dernière version)" },
  { id: "haiku", label: "Haiku (alias, dernière version)" },
];

/** `?engine=off` dans l'URL : simule l'absence de compte Claude Code connecté. */
const ENGINE_OFF = typeof location !== "undefined" && new URLSearchParams(location.search).get("engine") === "off";

const DEFAULT_SYSTEM = `# Consignes de base de MyClaude

- Réponds en français, de façon claire et concise.
- Travaille uniquement dans le dossier de travail.
- Explique brièvement ce que tu fais avant d'utiliser un outil qui modifie quelque chose.
`;

const NOTES_MD = `# Notes du projet

- Migrer le build vers Vite
- TODO : ajouter des tests pour le parseur
- TODO : documenter la configuration`;

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
    apiKey: null as string | null,
    model: "claude-opus-5-5",
    effort: "medium" as AppConfig["effort"],
    authMode: "subscription" as AppConfig["authMode"],
    workspaceDir: "C:\\Users\\vous\\MyClaude-workspace",
  };
  let governance: Governance = {
    system: DEFAULT_SYSTEM,
    tools: { allowed: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "WebSearch", "TodoWrite"] },
    mcp: { mcpServers: {} },
    agents: {},
  };
  /** Demandes d'autorisation en attente de réponse. */
  const pendingPerms = new Map<string, { sessionId: string; tool: string; resolve(d: PermissionDecision): void }>();
  /** Outils autorisés « pour cette session ». */
  const sessionAllowed = new Map<string, Set<string>>();
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
          tools: [
            {
              id: "t_seed_1",
              name: "Read",
              input: { file_path: "C:\\Users\\vous\\MyClaude-workspace\\webpack.config.js" },
              status: "done",
              resultPreview: "module.exports = {\n  entry: './src/index.js',\n  output: { path: __dirname + '/dist' },\n};",
            },
            {
              id: "t_seed_2",
              name: "Bash",
              input: { command: "npm ls webpack", description: "Version de webpack installée" },
              status: "denied",
              resultPreview: "Refusé par l'utilisateur.",
            },
          ],
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

  const cfg = (): AppConfig => {
    const subscription = config.authMode === "subscription";
    const engineReady = subscription ? !ENGINE_OFF : !!config.apiKey;
    return {
      hasApiKey: !!config.apiKey,
      model: config.model,
      effort: config.effort,
      dataDir: "C:\\Users\\vous\\AppData\\Roaming\\MyClaude\\data",
      availableModels: MODELS,
      authMode: config.authMode,
      workspaceDir: config.workspaceDir,
      account:
        subscription && !ENGINE_OFF
          ? { email: "vous@example.com", organization: "Personnel", subscription: "Claude Max" }
          : null,
      engineReady,
      engineError: engineReady
        ? undefined
        : subscription
          ? "Connecte-toi à Claude Code (`claude` puis `/login`)."
          : "Aucune clé API n'est configurée.",
    };
  };

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
      if (u.workspaceDir !== undefined) {
        if (!/^[a-zA-Z]:[\\/]/.test(u.workspaceDir) && !u.workspaceDir.startsWith("/")) {
          throw new ApiError(400, "Le dossier de travail doit être un chemin absolu.");
        }
        config.workspaceDir = u.workspaceDir;
      }
      if (u.authMode) config.authMode = u.authMode;
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
      const c = cfg();
      if (!c.engineReady) throw new ApiError(400, c.engineError ?? "Moteur indisponible.");
      await wait(150, signal);
      const user: ChatMessage = { id: uid("m"), role: "user", text, createdAt: iso() };
      s.messages.push(user);
      if (s.meta.title === "Nouvelle session") s.meta.title = text.split(/\s+/).slice(0, 6).join(" ");
      s.meta.updatedAt = iso();
      onEvent({ type: "user", message: clone(user) });

      let thinking = "";
      let out = "";
      const tools: ToolCall[] = [];
      const persistPartial = (error: string) => {
        for (const t of tools) {
          if (t.status === "running" || t.status === "pending_approval") {
            t.status = "error";
            t.resultPreview = "Interrompu.";
          }
        }
        s.messages.push({
          id: uid("m"),
          role: "assistant",
          text: out,
          thinking,
          error,
          tools: tools.length ? clone(tools) : undefined,
          createdAt: iso(),
        });
      };
      const ws = config.workspaceDir;
      const startTool = (name: string, input: unknown, status: ToolCall["status"] = "running") => {
        const t: ToolCall = { id: uid("tool"), name, input, status };
        tools.push(t);
        onEvent({ type: "tool_use", tool: clone(t) });
        return t;
      };
      const endTool = (t: ToolCall, status: ToolCall["status"], resultPreview: string) => {
        t.status = status;
        t.resultPreview = resultPreview;
        onEvent({ type: "tool_result", result: { id: t.id, status, resultPreview } });
      };
      /** Outil soumis à validation : renvoie true si autorisé. */
      const gated = async (name: string, input: unknown): Promise<ToolCall | null> => {
        const allowedHere = sessionAllowed.get(id);
        if (allowedHere?.has(name)) return startTool(name, input);
        const t = startTool(name, input, "pending_approval");
        const req: PermissionRequest = {
          id: uid("perm"),
          sessionId: id,
          toolCallId: t.id,
          tool: name,
          input,
          summary: summaryText(name, input),
        };
        const decision = await new Promise<PermissionDecision>((resolve, reject) => {
          pendingPerms.set(req.id, { sessionId: id, tool: name, resolve });
          onEvent({ type: "permission_request", request: clone(req) });
          signal?.addEventListener(
            "abort",
            () => {
              pendingPerms.delete(req.id);
              reject(new DOMException("Interrompu", "AbortError"));
            },
            { once: true },
          );
        });
        if (decision === "deny") {
          endTool(t, "denied", "Refusé par l'utilisateur.");
          return null;
        }
        t.status = "running";
        return t;
      };

      try {
        for (const chunk of ["Je réfléchis à la demande ", "et je regarde les fichiers ", "du dossier de travail."]) {
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

        let reply = SAMPLE_REPLY;
        if (!/markdown|démo/i.test(text)) {
          // 1. Lecture (auto-autorisée)
          const read = startTool("Read", { file_path: `${ws}\\notes.md` });
          await wait(450, signal);
          endTool(read, "done", NOTES_MD);
          // 2. Recherche (auto-autorisée)
          const grep = startTool("Grep", { pattern: "TODO", path: ws, output_mode: "content" });
          await wait(350, signal);
          endTool(grep, "done", "notes.md:4:- TODO : ajouter des tests pour le parseur\nnotes.md:5:- TODO : documenter la configuration");
          // 3. Modification (validation) si demandé
          let edited: boolean | null = null;
          if (/écri|fichier|modifi/i.test(text)) {
            const t = await gated("Edit", {
              file_path: `${ws}\\notes.md`,
              old_string: "- TODO : documenter la configuration",
              new_string: "- FAIT : documenter la configuration (voir README.md)",
            });
            if (t) {
              await wait(300, signal);
              endTool(t, "done", "Le fichier notes.md a été mis à jour (1 remplacement).");
            }
            edited = !!t;
          }
          // 4. Commande (validation, sensible)
          const bash = await gated("Bash", { command: "npm test -- --reporter=dot", description: "Lancer la suite de tests" });
          let tested = false;
          if (bash) {
            await wait(900, signal);
            if (/échec|echec|fail/i.test(text)) {
              endTool(bash, "error", "npm ERR! Test failed.\n  1 failing\n  parseur › gère les lignes vides");
            } else {
              endTool(bash, "done", "> projet@1.0.0 test\n> vitest run --reporter=dot\n\n············\n\n12 tests réussis (1,4 s)");
              tested = true;
            }
          }
          reply =
            "J'ai lu `notes.md` et trouvé **2 tâches** marquées TODO :\n\n" +
            "1. Ajouter des tests pour le parseur\n2. Documenter la configuration\n\n" +
            (edited === true
              ? "J'ai marqué la seconde comme faite dans `notes.md`.\n\n"
              : edited === false
                ? "Je n'ai pas modifié `notes.md`, puisque vous avez refusé.\n\n"
                : "") +
            (bash
              ? tested
                ? "La suite de tests passe : **12 tests réussis**."
                : "La suite de tests échoue sur `parseur › gère les lignes vides` : je propose de commencer par là."
              : "Je n'ai pas lancé les tests, puisque la commande a été refusée.");
        }

        const tokens = reply.match(/[\s\S]{1,6}/g) ?? [];
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
        tools: tools.length ? clone(tools) : undefined,
        createdAt: iso(),
        usage: { input_tokens: 42, output_tokens: 180 },
      };
      s.messages.push(done);
      s.meta.updatedAt = iso();
      onEvent({ type: "done", message: clone(done) });
    },
    async respondPermission(sessionId, reqId, decision) {
      await wait(120);
      const p = pendingPerms.get(reqId);
      if (!p || p.sessionId !== sessionId) throw new ApiError(404, "Demande d'autorisation introuvable ou expirée.");
      pendingPerms.delete(reqId);
      if (decision === "allow_session") {
        const set = sessionAllowed.get(sessionId) ?? new Set<string>();
        set.add(p.tool);
        sessionAllowed.set(sessionId, set);
      }
      p.resolve(decision);
      return { ok: true };
    },
    async getGovernance() {
      await wait(80);
      return clone(governance);
    },
    async putGovernance(u) {
      await wait(150);
      if (u.tools !== undefined) {
        if (!u.tools || !Array.isArray(u.tools.allowed) || u.tools.allowed.some((t) => typeof t !== "string")) {
          throw new ApiError(400, "tools.json : « allowed » doit être une liste de noms d'outils.");
        }
      }
      if (u.mcp !== undefined) {
        const servers = u.mcp?.mcpServers;
        if (!servers || typeof servers !== "object") throw new ApiError(400, "mcp.json : « mcpServers » doit être un objet.");
        for (const [name, conf] of Object.entries(servers)) {
          const c = conf as Record<string, unknown>;
          if (typeof c.command !== "string" && typeof c.url !== "string") {
            throw new ApiError(400, `mcp.json : le serveur « ${name} » doit définir « command » ou « url ».`);
          }
        }
      }
      if (u.agents !== undefined) {
        for (const [name, conf] of Object.entries(u.agents ?? {})) {
          const c = conf as Record<string, unknown>;
          if (typeof c.description !== "string" || typeof c.prompt !== "string") {
            throw new ApiError(400, `agents.json : l'agent « ${name} » doit avoir « description » et « prompt » (texte).`);
          }
        }
      }
      governance = {
        system: u.system ?? governance.system,
        tools: u.tools ?? governance.tools,
        mcp: u.mcp ?? governance.mcp,
        agents: u.agents ?? governance.agents,
      };
      return clone(governance);
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
