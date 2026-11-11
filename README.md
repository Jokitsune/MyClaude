# MyClaude

Interface personnelle pour Claude, **100 % locale** et **indépendante du compte Claude connecté**.

- L'interface et tout l'historique restent sur ta machine (`%APPDATA%\MyClaude\data`).
- Seuls les messages envoyés au modèle sortent, vers `api.anthropic.com`, avec **ta propre clé API**
  (saisie dans Réglages). L'app n'utilise jamais ton login claude.ai / Claude Code ni les variables
  d'environnement `ANTHROPIC_*`.
- Résiste aux coupures : chaque message est écrit sur le disque immédiatement, et les sessions coupées
  net (crash, PC éteint) sont détectées et récupérées au démarrage suivant.
- Auto-amélioration supervisée : à la fin de chaque session, Claude propose des leçons ; tu les
  valides (page **Apprentissage**) avant qu'elles n'entrent dans sa mémoire.

## Démarrage

Prérequis : Node.js 20+.

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
| `server/` | Serveur local (Node/TypeScript) : API sur 127.0.0.1, stockage, récupération, bilan, appel à Claude |
| `web/` | Interface (React + Vite) |
| `desktop/` | Fenêtre Electron qui embarque le serveur et l'interface |
| `docs/ARCHITECTURE.md` | Le contrat technique complet |

Tests du serveur : `npm --prefix server test`.
