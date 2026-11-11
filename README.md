# MyClaude

**Ton interface personnelle pour Claude — locale, gouvernée, et qui apprend avec toi.**

*English summary: MyClaude is a local web/desktop interface for Claude. It uses the Claude Code
subscription of whoever is logged in on the machine as its engine, but sessions, memory, rules, tools
and agents belong to MyClaude and stay on your computer. Claude can work in a dedicated folder, and
every risky action needs your approval.*

---

## Pourquoi MyClaude ?

| | |
|---|---|
| 🖥️ **100 % local** | L'interface et tout l'historique restent sur ton PC. Le serveur n'écoute que ta machine (`127.0.0.1`). Seuls les messages envoyés au modèle partent chez Anthropic. |
| 🔑 **Ton abonnement comme moteur** | MyClaude utilise le compte connecté à Claude Code (Pro, Max, Team…). Pas de clé API à payer — mais tu peux en utiliser une si tu préfères. |
| 🧭 **Gouvernance indépendante du compte** | Consignes, mémoire, outils autorisés, serveurs MCP et sous-agents appartiennent à MyClaude. Si quelqu'un d'autre se connecte, ces règles ne changent pas, et ton historique n'est jamais rattaché à son compte. |
| 🛡️ **Actions sous contrôle** | Claude ne peut toucher qu'un **dossier de travail**. Il lit librement dedans, mais **te demande ton accord** avant d'écrire, de lancer une commande, d'aller sur le web ou d'utiliser un outil externe. Tout est journalisé. |
| 💾 **Résiste aux coupures** | Chaque message est écrit sur le disque immédiatement. Crash, coupure de courant : les sessions interrompues sont récupérées au démarrage suivant. |
| 🧠 **Apprend avec ton accord** | À la fin de chaque session, Claude propose des leçons (tes préférences, ses erreurs…). Rien n'entre dans sa mémoire sans ta validation. |
| 📂 **Tes sessions Claude Code** | Parcours et relis tes conversations Claude Code existantes, et continue-les dans MyClaude — sur une copie, l'original n'est jamais modifié. |

---

## Installation

### 1. Prérequis

- **Windows 10/11** recommandé (la version fenêtre et l'installateur sont prévus pour Windows ; la version
  web locale fonctionne aussi sous macOS et Linux).
- **[Node.js](https://nodejs.org) 20 ou plus récent** — vérifie avec `node --version`.
- **[Git](https://git-scm.com)**.
- **Claude Code installé et connecté** à ton compte Claude (abonnement Pro, Max, Team ou Enterprise) :
  suis la [documentation officielle de Claude Code](https://code.claude.com/docs), puis dans un terminal :
  ```bash
  claude
  ```
  et tape `/login` si ce n'est pas déjà fait. *(Pas d'abonnement ? Tu peux utiliser une clé API
  [console.anthropic.com](https://console.anthropic.com) à la place, voir plus bas.)*

### 2. Récupérer et installer MyClaude

```bash
git clone https://github.com/Jokitsune/MyClaude.git
cd MyClaude
npm run install:all
```

> npm peut afficher des avertissements `install-scripts` : c'est normal, l'app fonctionne sans.
> Le binaire Electron (version fenêtre) est téléchargé automatiquement au premier lancement.

### 3. Lancer

**Version fenêtre (Windows)** :
```bash
npm run desktop
```

**Version web locale** (n'importe quel navigateur) :
```bash
npm start
```
puis ouvre **http://127.0.0.1:4317**.

### 4. Premier démarrage

1. Va dans **Réglages** :
   - **Moteur** : laisse « Abonnement (Claude Code) ». Ton compte doit apparaître. Sinon, lance `claude`
     dans un terminal, fais `/login`, puis clique sur « Revérifier ».
     *Ou* choisis « Clé API » et colle ta clé.
   - **Dossier de travail** : le seul dossier où Claude pourra lire, écrire et lancer des commandes.
     Par défaut `C:\Users\<toi>\MyClaude-workspace` (créé automatiquement).
   - **Modèle** et **niveau de réflexion**.
2. Clique sur **Nouvelle session** et discute.

### Installateur Windows (optionnel)

Pour obtenir un `.exe` installable :
```bash
npm run build
cd desktop
npm run dist
```
L'installateur est créé dans `desktop/release/`. Il n'est pas signé : Windows SmartScreen affichera un
avertissement au premier lancement (« Informations complémentaires » → « Exécuter quand même »).

---

## Utilisation

### Discuter et laisser Claude agir
Quand Claude veut agir, une carte apparaît dans la conversation :
- **Lecture** dans le dossier de travail → automatique.
- **Écriture, commande, web, outil MCP, sous-agent** → carte de validation :
  **Autoriser**, **Toujours pour cette session**, ou **Refuser**.
- **Tout ce qui sort du dossier de travail** → refusé automatiquement.
- Pas de réponse en 10 minutes, ou page fermée → refusé.

Le bouton **Terminer la session** clôt la session et lance son bilan.

### Apprentissage
Les leçons proposées après chaque session attendent ici. Valide-les (éventuellement après les avoir
modifiées) ou refuse-les. Les leçons validées rejoignent la **mémoire**, que tu peux aussi éditer
directement. **Relis-les vraiment** : une leçon peut être fausse.

### Gouvernance
Les règles qui appartiennent à MyClaude, quel que soit le compte connecté :
- **Consignes** (prompt système de base) ;
- **Outils autorisés** ;
- **Serveurs MCP** (`mcp.json`, même format que Claude Code) ;
- **Sous-agents** (`agents.json`).

### Sessions Claude Code
Liste tes projets et conversations Claude Code de ce PC, lis-les, puis **Continuer dans MyClaude** :
la conversation reprend avec tout son contexte, mais sous les règles de MyClaude. Une copie est faite,
l'original n'est jamais modifié.

---

## Où sont mes données ?

| Système | Dossier |
|---|---|
| Windows | `%APPDATA%\MyClaude\data` |
| macOS / Linux | `~/.config/MyClaude/data` |

Tu peux le changer avec la variable d'environnement `MYCLAUDE_DATA_DIR`. Il contient tes sessions,
leçons, mémoire, règles et réglages (dont ta clé API si tu en as saisi une). **Ne le partage pas.**

À noter : en mode abonnement, Claude Code garde aussi sa propre copie des échanges dans
`~/.claude/projects` (nécessaire pour reprendre les conversations). MyClaude la supprime quand tu
supprimes la session.

---

## Sécurité

- Le serveur n'écoute que `127.0.0.1` et refuse les requêtes venant d'autres sites (protection contre
  le DNS rebinding et le CSRF).
- La clé API n'est jamais renvoyée à l'interface ni écrite dans les journaux.
- Le dossier de travail ne peut pas être une racine de disque ni contenir les données de MyClaude.
- Aucun réglage de `~/.claude` n'est chargé : seuls les règles et serveurs MCP de MyClaude s'appliquent.
- La version fenêtre est verrouillée (isolation, sandbox, navigation externe bloquée).

Ce n'est pas un audit de sécurité : n'autorise que les actions que tu comprends.

---

## Dépannage

| Problème | Solution |
|---|---|
| « Moteur indisponible » / pas de compte détecté | Lance `claude` dans un terminal, fais `/login`, puis « Revérifier » dans Réglages. |
| Le port 4317 est déjà utilisé | Lance avec un autre port : `MYCLAUDE_PORT=4400 npm start` (PowerShell : `$env:MYCLAUDE_PORT=4400; npm start`). |
| « Dossier de travail refusé » | Choisis un dossier plus précis que ton dossier personnel (il contient les données de MyClaude). |
| Limite d'usage atteinte | C'est la limite de ton abonnement Claude : attends sa réinitialisation, ou passe en mode clé API. |
| La fenêtre ne s'ouvre pas | Vérifie que `npm run build` a réussi, puis relance `npm run desktop`. |

---

## Développement

```bash
npm run dev:server              # serveur avec rechargement auto (port 4317)
npm run dev:web                 # interface Vite sur http://localhost:5173
npm --prefix web run dev:mock   # interface seule, avec un faux serveur
npm --prefix server test        # tests du serveur
```

| Dossier | Rôle |
|---|---|
| `server/` | Serveur local Node/TypeScript : API, stockage, récupération, gouvernance, permissions, moteur (Claude Agent SDK), bilan, sessions Claude Code |
| `web/` | Interface React + Vite |
| `desktop/` | Application Electron qui embarque le serveur et l'interface |
| `docs/ARCHITECTURE.md` | Le contrat technique complet |

---

## Conditions d'utilisation

MyClaude pilote **ta propre installation** de Claude Code, avec **ton propre compte**, sur **ta propre
machine**. Tu restes soumis aux [conditions d'utilisation d'Anthropic](https://www.anthropic.com/legal)
et aux règles de ton abonnement. N'utilise pas MyClaude pour faire profiter d'autres personnes de ton
abonnement, et ne le redistribue pas comme un service branché sur un login claude.ai. Pour un usage
partagé ou un produit, utilise le mode **clé API**.

MyClaude est un projet indépendant, non affilié à Anthropic.

## Licence

[MIT](LICENSE) — libre d'utiliser, modifier et redistribuer le code, en conservant la mention de copyright.
