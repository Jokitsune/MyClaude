// Prépare build/server et build/web pour electron-builder (copiés dans resources/ du paquet).
// - build/server : package.json + lockfile + dist/ du serveur, puis dépendances de production
//   seulement (npm ci --omit=dev --ignore-scripts) : pas de typescript/tsx dans l'installeur.
// - build/web    : copie de web/dist.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "..");
const serverSrc = path.join(repoRoot, "server");
const webDist = path.join(repoRoot, "web", "dist");
const out = path.join(desktopDir, "build");

function fail(msg) {
  console.error(`[stage] ${msg}`);
  process.exit(1);
}

if (!existsSync(path.join(serverSrc, "dist", "index.js")))
  fail("server/dist/index.js absent : lancez `npm run build` à la racine du dépôt.");
if (!existsSync(path.join(webDist, "index.html")))
  fail("web/dist/index.html absent : lancez `npm run build` à la racine du dépôt.");

rmSync(out, { recursive: true, force: true });
const serverOut = path.join(out, "server");
mkdirSync(serverOut, { recursive: true });

// package.json sans scripts (aucun hook prepare/postinstall exécuté) ni devDependencies.
const pkg = JSON.parse(readFileSync(path.join(serverSrc, "package.json"), "utf8"));
delete pkg.scripts;
delete pkg.devDependencies;
writeFileSync(path.join(serverOut, "package.json"), JSON.stringify(pkg, null, 2));

const lock = path.join(serverSrc, "package-lock.json");
if (existsSync(lock)) cpSync(lock, path.join(serverOut, "package-lock.json"));
cpSync(path.join(serverSrc, "dist"), path.join(serverOut, "dist"), { recursive: true });

const installCmd = existsSync(lock)
  ? "npm ci --omit=dev --ignore-scripts --no-audit --no-fund"
  : "npm install --omit=dev --ignore-scripts --no-audit --no-fund";
console.log(`[stage] ${installCmd} (dans build/server)`);
execSync(installCmd, { cwd: serverOut, stdio: "inherit" });

cpSync(webDist, path.join(out, "web"), { recursive: true });
console.log("[stage] build/server et build/web prêts.");
