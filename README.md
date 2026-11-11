# MyClaude

Interface personnelle pour travailler avec Claude, **100 % locale**, avec une **gouvernance indépendante du compte**.

- **Moteur = le compte connecté.** MyClaude utilise l'abonnement du compte actuellement connecté à
  Claude Code sur ce PC (via le Claude Agent SDK). Une clé API perso reste possible en option.
- **Gouvernance = MyClaude.** Sessions, mémoire, leçons, consignes, outils permis, serveurs MCP et
  sous-agents appartiennent à MyClaude (`%APPDATA%\MyClaude\data`) et sont identiques quel que soit
  le compte connecté. Aucun réglage `~/.claude` du compte n'est chargé.
- **Outils sous contrôle.** Claude ne peut agir que dans le dossier de travail
  (défaut `%USERPROFILE%\MyClaude-workspace`). Lecture automatique ; écriture, commandes, web, MCP et
  sous-agents demandent ta validation (Autoriser / Toujours pour cette session / Refuser). Tout est journalisé.
- **Résiste aux coupures.** Chaque message est écrit immédiatement ; les sessions coupées net sont
  détectées et récupérées au démarrage suivant.
- **Auto-amélioration supervisée.** À la fin de chaque session, Claude propose des leçons ; rien n'entre
  dans sa mémoire sans ta validation (page **Apprentissage**).

Usage personnel : ne redistribue pas MyClaude branché sur un login claude.ai.

## Démarrage

Prérequis : Node.js 20+, et Claude Code connecté (`claude` puis `/login`).

```bash
npm run install:all     # installe server, web et desktop

npm start               # version web locale -> http://127.0.0.1:4317
npm run desktop         # version application Windows (Electron)
```

Développement : `npm run dev:server` et `npm run dev:web` (Vite sur http://localhost:5173),
ou `npm --prefix web run dev:mock` pour l'interface seule avec un faux serveur.

Installateur Windows : `npm run build` puis `cd desktop && npm run dist` (sortie dans `desktop/release/`).

## Structure

| Dossier | Rôle |
|---|---|
| `server/` | Serveur local (Node/TypeScript) : API sur 127.0.0.1, stockage, récupération, gouvernance, permissions, moteur Claude, bilan |
| `web/` | Interface (React + Vite) : discussion, actions et validations, Apprentissage, Gouvernance, Réglages |
| `desktop/` | Fenêtre Electron qui embarque le serveur et l'interface |
| `docs/ARCHITECTURE.md` | Le contrat technique complet (v1 + v2) |

Tests du serveur : `npm --prefix server test`.
