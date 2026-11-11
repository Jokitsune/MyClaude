import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, startServerInternal } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "..", "..", "web", "dist");
// Lancé depuis les sources (tsx) ⇒ mode dev : origine Vite autorisée.
const dev = process.env.MYCLAUDE_DEV === "1" || fileURLToPath(import.meta.url).endsWith(".ts");
const port = process.env.MYCLAUDE_PORT ? Number(process.env.MYCLAUDE_PORT) : DEFAULT_PORT;

const server = await startServerInternal(
  { port, webDir: existsSync(path.join(webDist, "index.html")) ? webDist : undefined },
  { dev },
);
console.log(`[myclaude] serveur prêt sur ${server.url}${dev ? " (dev)" : ""}`);
console.log(`[myclaude] données : ${(await server.service.getConfig()).dataDir}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log("[myclaude] arrêt…");
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGBREAK", stop);
