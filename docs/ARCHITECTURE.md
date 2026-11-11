# MyClaude — Architecture & contrat

Interface personnelle pour Claude, **100 % locale** (interface + historique), **indépendante du compte
Claude connecté** (clé API personnelle propre à l'app, jamais de login claude.ai).

## Principes non négociables

1. **Rien n'est hébergé ailleurs que sur la machine.** Le serveur écoute uniquement sur `127.0.0.1`.
   Seuls les appels au modèle sortent (vers `https://api.anthropic.com`), rien d'autre (pas de télémétrie).
2. **Indépendant du compte.** Le client Anthropic est construit avec la clé de `config.json` de l'app,
   `authToken: null` et `baseURL: "https://api.anthropic.com"` explicites, pour ne jamais hériter de
   `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / profils `ant` / login Claude Code.
3. **Résistant aux coupures.** Tout événement est écrit sur disque immédiatement (append JSONL).
   Les sessions jamais clôturées sont détectées au démarrage suivant (heartbeat périmé) et récupérées.
4. **Auto-amélioration supervisée.** Le bilan de fin de session propose des leçons ; rien n'entre dans la
   mémoire sans validation explicite de l'utilisateur.
5. **Zéro dépendance native** (pas de better-sqlite3) pour que le serveur tourne pareil sous Node et Electron.

## Arborescence

```
MyClaude/
  package.json          scripts racine uniquement (pas de workspaces npm)
  docs/ARCHITECTURE.md  ce contrat
  server/               Node 20+ / TypeScript ESM — API locale + stockage + Claude
  web/                  React + Vite + TypeScript — l'interface
  desktop/              Electron — fenêtre native qui embarque server + web
```

Chaque paquet a son propre `package.json` et `node_modules` (installations indépendantes).

## server/

- Point d'entrée librairie : `server/src/index.ts` exporte
  ```ts
  export interface StartOptions { port?: number; host?: "127.0.0.1"; dataDir?: string; webDir?: string }
  export interface RunningServer { port: number; url: string; close(): Promise<void> }
  export function startServer(opts?: StartOptions): Promise<RunningServer>
  ```
  - `port` par défaut `4317` ; `0` = port libre aléatoire (utilisé par Electron).
  - `dataDir` par défaut : `process.env.MYCLAUDE_DATA_DIR` sinon `%APPDATA%/MyClaude/data`
    (`~/.config/MyClaude/data` hors Windows).
  - `webDir` : si fourni, sert les fichiers statiques du build web (fallback SPA vers `index.html`).
  - `close()` : arrête le serveur proprement et clôt les sessions ouvertes (`closeReason: "app-quit"`).
- CLI : `server/src/cli.ts` → `startServer({ webDir: "../web/dist" si présent })`.
- Build : `tsc` → `server/dist/` (ESM). `package.json` : `"type": "module"`, `"main": "dist/index.js"`,
  `"types": "dist/index.d.ts"`. Dev : `tsx watch src/cli.ts`.
- Sécurité HTTP : refuser toute requête dont l'en-tête `Host` n'est pas `127.0.0.1:<port>` ou
  `localhost:<port>` (anti DNS-rebinding) et toute requête mutante dont l'`Origin` est présent et
  différent de ces hôtes (anti-CSRF). En dev, autoriser aussi l'origine Vite `http://localhost:5173`.
  Ne jamais renvoyer la clé API au client (seulement `hasApiKey`).

### Stockage (`dataDir`)

```
config.json                 { apiKey?, model, effort }      écriture atomique (tmp + rename)
memory.md                   mémoire validée, injectée dans le prompt système
sessions/<id>/meta.json     SessionMeta                      écriture atomique
sessions/<id>/events.jsonl  un événement JSON par ligne, append + flush immédiat
lessons/<id>.json           Lesson                           écriture atomique
```

### Types partagés (copiés à l'identique dans `web/src/types.ts`)

```ts
type SessionStatus = "open" | "closed" | "interrupted";
type CloseReason = "user" | "idle" | "app-quit" | "recovered";
type ReviewStatus = "pending" | "running" | "done" | "failed";

interface SessionMeta {
  id: string;               // ex. "2026-11-11_143207_ab12"
  title: string;            // "Nouvelle session" puis titre auto (premiers mots du 1er message)
  status: SessionStatus;
  closeReason?: CloseReason;
  createdAt: string;        // ISO
  updatedAt: string;
  lastHeartbeat: string;
  model: string;
  review: ReviewStatus;
  reviewError?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;             // texte affiché
  thinking?: string;        // résumé de réflexion (assistant)
  createdAt: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;           // si la réponse a échoué / été interrompue
}

interface Lesson {
  id: string;
  sessionId: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
  kind: "preference" | "mistake" | "success" | "fact";
  text: string;             // la leçon, une phrase actionnable
  rationale: string;        // pourquoi
}

interface AppConfig {       // forme renvoyée au client (jamais la clé)
  hasApiKey: boolean;
  model: string;            // défaut "claude-opus-5-5"
  effort: "low" | "medium" | "high" | "xhigh" | "max";   // défaut "medium"
  dataDir: string;
  availableModels: { id: string; label: string }[];
}
```

`availableModels` : `claude-opus-5-5` (Opus 5.5, défaut), `claude-sonnet-5-5` (Sonnet 5.5),
`claude-haiku-5-5` (Haiku 5.5), `claude-fable-5-2` (Fable 5.2).

Événements `events.jsonl` : `{ "t": ISO, "type": "message", "message": ChatMessage }`,
`{ "type": "heartbeat" }` n'est PAS journalisé (seul `meta.lastHeartbeat` est mis à jour),
`{ "type": "closed", "reason": CloseReason }`. Les messages sont reconstruits en relisant le journal ;
une dernière ligne tronquée (coupure) est ignorée sans erreur.

### API HTTP (JSON, préfixe `/api`)

| Méthode | Route | Corps / réponse |
|---|---|---|
| GET | `/api/health` | `{ ok: true, version }` |
| GET | `/api/config` | `AppConfig` |
| PUT | `/api/config` | `{ apiKey?: string \| null, model?, effort? }` → `AppConfig` (`apiKey: null` efface) |
| GET | `/api/sessions` | `SessionMeta[]` triées `updatedAt` desc |
| POST | `/api/sessions` | `{ title? }` → `SessionMeta` |
| GET | `/api/sessions/:id` | `{ session: SessionMeta, messages: ChatMessage[] }` |
| DELETE | `/api/sessions/:id` | `{ ok: true }` (supprime dossier + leçons pending associées) |
| POST | `/api/sessions/:id/heartbeat` | `{ ok: true }` |
| POST | `/api/sessions/:id/close` | → `SessionMeta` ; déclenche le bilan en arrière-plan |
| POST | `/api/sessions/:id/messages` | `{ text }` → **flux SSE** (voir ci-dessous) ; refusé (409) si session non `open` |
| GET | `/api/lessons?status=pending` | `Lesson[]` (filtre optionnel) |
| POST | `/api/lessons/:id/approve` | `{ text? }` (édition possible) → `Lesson` ; ajoute la leçon à `memory.md` |
| POST | `/api/lessons/:id/reject` | → `Lesson` |
| GET | `/api/memory` | `{ content: string }` |
| PUT | `/api/memory` | `{ content }` → `{ content }` |

Erreurs : statut HTTP adapté + `{ error: string }` (message en français).

#### Flux SSE de `POST /api/sessions/:id/messages`

`Content-Type: text/event-stream`. Événements :

```
event: user        data: ChatMessage                  (message utilisateur enregistré)
event: thinking    data: { "text": "..." }            (delta de résumé de réflexion)
event: delta       data: { "text": "..." }            (delta de texte)
event: done        data: ChatMessage                  (message assistant final, déjà journalisé)
event: error       data: { "error": "..." }           (le message assistant partiel est journalisé avec `error`)
```

Si le client se déconnecte en cours de route, le serveur interrompt l'appel et journalise la réponse partielle.

### Appel au modèle

- `@anthropic-ai/sdk` (TypeScript officiel). `client.beta.messages.stream(...)` avec
  `thinking: { type: "adaptive", display: "summarized" }`, `output_config: { effort }`, `max_tokens: 64000`.
- Fallback en cas de refus pour Opus 5.5 / Sonnet 5.5 / Fable 5.2 : `betas: ["server-side-fallback-2026-07-01"]`,
  `fallbacks: "default"`. Pas pour Haiku 5.5. Toujours vérifier `stop_reason` (`refusal` → message d'erreur clair).
- Prompt système = consignes de base (FR, concis) + contenu de `memory.md`.
- Erreurs typées SDK (`Anthropic.AuthenticationError`, `RateLimitError`, `APIConnectionError`…) → messages FR.
- Abstraction `Provider` (`server/src/providers/`) pour pouvoir ajouter Ollama (100 % hors ligne) plus tard.

### Cycle de vie & récupération

- Heartbeat : le client appelle `/heartbeat` toutes les 30 s pour la session affichée.
- Inactivité : une tâche toutes les 60 s clôt (`idle`) les sessions `open` sans message ni heartbeat depuis 30 min.
- Démarrage : toute session `open` dont `lastHeartbeat` a plus de 2 min → `interrupted` (`recovered`).
- Bilan : toute session non `open` avec `review` ∈ {`pending`, `failed`} et au moins un échange est
  passée au bilan (au démarrage + après chaque clôture), une à la fois. `running` resté bloqué
  au démarrage → repassé en `pending`. Idempotent : `done` n'est jamais refait.
- Bilan = un appel Claude (sorties structurées JSON) sur la transcription → 0 à 5 `Lesson` `pending`.
  Sans clé API : le bilan reste `pending` et sera retenté.

## web/

React 18 + Vite + TypeScript, CSS pur (pas de framework CSS). Style proche de l'interface Claude :
barre latérale des sessions, fil de discussion centré, zone de saisie arrondie en bas, rendu Markdown,
thème clair (fond crème) et sombre (`prefers-color-scheme` + bascule manuelle). Interface en français.
Vues : Discussion, Apprentissage (leçons en attente + éditeur de mémoire), Réglages (clé API, modèle, effort).
En dev, Vite proxifie `/api` vers `http://127.0.0.1:4317`. Build → `web/dist/`.

## desktop/

Electron. Le processus principal importe `startServer({ port: 0, dataDir, webDir })` depuis `../server`,
puis ouvre une `BrowserWindow` sur `http://127.0.0.1:<port>`. `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, navigation externe bloquée (liens ouverts dans le navigateur
système). À la fermeture : `await server.close()` avant de quitter. Instance unique.
