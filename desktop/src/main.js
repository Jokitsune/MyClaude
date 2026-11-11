// @ts-check
// Processus principal Electron de MyClaude.
// Rôle : démarrer le serveur local (127.0.0.1, port libre), ouvrir une fenêtre verrouillée
// dessus, et fermer proprement le serveur (sessions clôturées "app-quit") avant de quitter.
//
// Pas de preload, pas d'IPC : l'interface web parle uniquement au serveur HTTP local.
// Le renderer n'a donc aucun accès privilégié à exposer ni à valider.

import { app, BrowserWindow, dialog, nativeTheme, session, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHUTDOWN_TIMEOUT_MS = 8000;

// Couleurs de fond affichées avant le premier rendu (évite le flash blanc).
// Alignées sur le thème crème clair / sombre de l'interface web.
const BG_LIGHT = "#FAF9F5";
const BG_DARK = "#262624";

// CSP appliquée uniquement si le serveur n'en fournit pas. Compatible avec une sortie
// `vite build` standard (scripts modules externes, pas de script inline) ; les styles
// inline restent autorisés pour React (attribut style=) et le rendu Markdown.
const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** @typedef {{ port: number, url: string, close(): Promise<void> }} RunningServer */

/** @type {RunningServer | null} */
let server = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {string | null} origine autorisée, ex. "http://127.0.0.1:53124" */
let allowedOrigin = null;
let shuttingDown = false;
let readyToExit = false;

function log(...args) {
  console.log("[myclaude-desktop]", ...args);
}

// ---------------------------------------------------------------------------
// Résolution des chemins (dev vs paquet installé)
// ---------------------------------------------------------------------------

/**
 * En dev : desktop/ est l'app, server/ et web/ sont ses voisins dans le dépôt.
 * Une fois empaqueté : electron-builder copie server/ et web/ dans resources/ (hors asar).
 * Les variables d'environnement permettent de surcharger pour le débogage.
 */
function resolvePaths() {
  if (app.isPackaged) {
    return {
      serverEntry: path.join(process.resourcesPath, "server", "dist", "index.js"),
      webDir: path.join(process.resourcesPath, "web"),
    };
  }
  const repoRoot = path.resolve(app.getAppPath(), "..");
  return {
    serverEntry:
      process.env.MYCLAUDE_SERVER_ENTRY ?? path.join(repoRoot, "server", "dist", "index.js"),
    webDir: process.env.MYCLAUDE_WEB_DIR ?? path.join(repoRoot, "web", "dist"),
  };
}

// ---------------------------------------------------------------------------
// Erreurs de démarrage
// ---------------------------------------------------------------------------

class StartupError extends Error {}

/** @param {unknown} err */
function showStartupError(err) {
  const detail =
    err instanceof StartupError
      ? err.message
      : `Erreur inattendue : ${err instanceof Error ? err.message : String(err)}`;
  console.error("[myclaude-desktop] échec du démarrage :", err);
  dialog.showErrorBox(
    "MyClaude — démarrage impossible",
    `MyClaude n'a pas pu démarrer.\n\n${detail}\n\n` +
      "Vos données et votre historique ne sont pas affectés.",
  );
}

// ---------------------------------------------------------------------------
// Serveur local
// ---------------------------------------------------------------------------

async function startLocalServer() {
  const { serverEntry, webDir } = resolvePaths();

  if (!existsSync(serverEntry)) {
    throw new StartupError(
      `Le serveur local est introuvable :\n${serverEntry}\n\n` +
        "En développement, compilez-le d'abord (npm run build à la racine du dépôt).",
    );
  }
  if (!existsSync(path.join(webDir, "index.html"))) {
    throw new StartupError(
      `L'interface web est introuvable :\n${webDir}\n\n` +
        "En développement, compilez-la d'abord (npm run build à la racine du dépôt).",
    );
  }

  // userData = %APPDATA%\MyClaude (nom = productName) : reste local au compte Windows.
  const dataDir = path.join(app.getPath("userData"), "data");

  /** @type {{ startServer(opts: { port?: number, host?: "127.0.0.1", dataDir?: string, webDir?: string }): Promise<RunningServer> }} */
  let mod;
  try {
    // Import dynamique par URL file:// : fonctionne en dev et hors asar une fois empaqueté.
    mod = await import(pathToFileURL(serverEntry).href);
  } catch (err) {
    throw new StartupError(
      `Impossible de charger le serveur local : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof mod.startServer !== "function") {
    throw new StartupError("Le module serveur n'exporte pas startServer().");
  }

  try {
    const running = await mod.startServer({ port: 0, host: "127.0.0.1", dataDir, webDir });
    log(`serveur démarré sur ${running.url} (données : ${dataDir})`);
    return running;
  } catch (err) {
    throw new StartupError(
      `Le serveur local n'a pas pu démarrer : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Sécurité
// ---------------------------------------------------------------------------

/** @param {string} raw */
function isLocalUrl(raw) {
  try {
    return allowedOrigin !== null && new URL(raw).origin === allowedOrigin;
  } catch {
    return false;
  }
}

/** Ouvre un lien http(s) dans le navigateur système ; tout autre schéma est ignoré. */
/** @param {string} raw */
function openExternalSafely(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    log(`lien externe refusé (schéma ${url.protocol})`);
    return;
  }
  shell.openExternal(url.href).catch((err) => log("openExternal a échoué :", err));
}

function hardenSession() {
  const ses = session.defaultSession;

  // Aucune permission (caméra, micro, notifications, géolocalisation…), sauf l'écriture
  // presse-papiers depuis l'origine locale : sans elle, les boutons « Copier » de l'interface
  // (navigator.clipboard.writeText) échouent.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const allowed =
      permission === "clipboard-sanitized-write" && isLocalUrl(details.requestingUrl);
    if (!allowed) log(`permission refusée : ${permission}`);
    callback(allowed);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return permission === "clipboard-sanitized-write" && requestingOrigin === allowedOrigin;
  });

  // CSP de repli : seulement pour les réponses du serveur local, et seulement s'il n'en
  // envoie pas lui-même.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    const hasCsp = Object.keys(headers).some(
      (k) => k.toLowerCase() === "content-security-policy",
    );
    if (!hasCsp && details.resourceType === "mainFrame" && isLocalUrl(details.url)) {
      headers["Content-Security-Policy"] = [DEFAULT_CSP];
    }
    callback({ responseHeaders: headers });
  });
}

// Règles appliquées à TOUT webContents créé (fenêtre principale ou autre).
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (isLocalUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });
  contents.on("will-redirect", (event, url) => {
    if (!isLocalUrl(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    // window.open et target=_blank : jamais de nouvelle fenêtre Electron.
    if (!isLocalUrl(url)) openExternalSafely(url);
    return { action: "deny" };
  });
});

// ---------------------------------------------------------------------------
// Fenêtre
// ---------------------------------------------------------------------------

/** @param {string} url */
function createWindow(url) {
  const win = new BrowserWindow({
    title: "MyClaude",
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  });
  win.removeMenu();

  // Garde le titre « MyClaude » même si la page définit un <title> différent.
  win.on("page-title-updated", (e) => e.preventDefault());
  win.once("ready-to-show", () => win.show());

  // Fermeture de session Windows (déconnexion / arrêt) : au mieux, on clôt le serveur.
  win.on("session-end", () => {
    log("fin de session Windows : arrêt du serveur");
    void shutdown();
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    log("processus de rendu arrêté :", details.reason);
  });
  win.webContents.on("did-fail-load", (_e, code, description, failedUrl) => {
    log(`échec de chargement ${failedUrl} : ${code} ${description}`);
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.loadURL(url).catch((err) => log("loadURL a échoué :", err));
  return win;
}

// ---------------------------------------------------------------------------
// Arrêt
// ---------------------------------------------------------------------------

/** Ferme le serveur une seule fois, avec un délai maximal, puis quitte. */
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const running = server;
  server = null;
  if (running) {
    log("arrêt du serveur…");
    try {
      await Promise.race([
        running.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("délai dépassé")), SHUTDOWN_TIMEOUT_MS),
        ),
      ]);
      log("serveur arrêté proprement");
    } catch (err) {
      log("arrêt du serveur incomplet :", err instanceof Error ? err.message : err);
    }
  }
  readyToExit = true;
  app.quit();
}

app.on("before-quit", (event) => {
  if (readyToExit) return;
  event.preventDefault();
  void shutdown();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Arrêt depuis le terminal en dev (Ctrl+C).
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(signal, () => app.quit());
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // Une autre instance tourne déjà : elle recevra « second-instance » et se mettra au premier plan.
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (!mainWindow && server) mainWindow = createWindow(server.url);
  });

  main().catch((err) => {
    showStartupError(err);
    readyToExit = true;
    app.exit(1);
  });
}

async function main() {
  await app.whenReady();
  hardenSession();
  server = await startLocalServer();
  allowedOrigin = new URL(server.url).origin;
  mainWindow = createWindow(server.url);
}
