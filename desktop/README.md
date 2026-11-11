# MyClaude — application de bureau (Electron)

Fenêtre native qui démarre le serveur local MyClaude (sur `127.0.0.1`, port libre aléatoire)
et affiche l'interface web. Aucune donnée ne quitte la machine, hormis les appels au modèle.

## Lancer en développement

Depuis la racine du dépôt :

```sh
npm run install:all     # installe server/, web/ et desktop/ (indépendamment)
npm run desktop         # compile server + web, puis ouvre la fenêtre
```

Ou, si `server/dist` et `web/dist` sont déjà compilés :

```sh
cd desktop
npm install
npm start
```

Au premier `npm start`, Electron télécharge son binaire (une seule fois).

## Données

Les données sont stockées dans `%APPDATA%\MyClaude\data` (propre à chaque compte Windows) :
configuration, clé API, historique des sessions, leçons et mémoire. C'est le même dossier que
celui utilisé par le serveur lancé seul en ligne de commande.

## Créer l'installeur Windows

```sh
npm run build           # à la racine : compile server + web
cd desktop
npm run dist            # prépare build/ puis produit release/MyClaude Setup <version>.exe (NSIS)
```

`npm run stage` copie le serveur compilé (avec ses seules dépendances de production) et
l'interface web dans `desktop/build/`, qu'electron-builder place dans `resources/` du paquet.

L'installeur n'est **pas signé** : Windows SmartScreen affichera un avertissement au premier
lancement. Pour signer, fournir un certificat via les variables `CSC_LINK` / `CSC_KEY_PASSWORD`
(prises en charge nativement par electron-builder).

## Sécurité

- `contextIsolation`, `sandbox`, pas de `nodeIntegration`, pas de preload ni d'IPC.
- Navigation limitée à l'origine du serveur local ; les liens `http(s)` externes s'ouvrent dans
  le navigateur système, les autres schémas sont ignorés ; `window.open` est toujours refusé.
- Toutes les permissions sont refusées, sauf l'écriture dans le presse-papiers (boutons « Copier »).
- CSP stricte ajoutée si le serveur n'en envoie pas (scripts et connexions limités à l'origine locale).

## Variables de débogage (développement uniquement)

- `MYCLAUDE_SERVER_ENTRY` : chemin d'un autre `index.js` serveur.
- `MYCLAUDE_WEB_DIR` : chemin d'un autre build web.
- `ELECTRON_ENABLE_LOGGING=1` : affiche la console de la page dans le terminal.
