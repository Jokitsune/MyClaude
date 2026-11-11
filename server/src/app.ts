import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequestHandler } from "./http.js";
import { consoleLogger, type Logger } from "./log.js";
import { defaultProviderFactory } from "./providers/index.js";
import type { ProviderFactory } from "./providers/types.js";
import { AppService } from "./service.js";
import { Storage } from "./storage.js";

export interface StartOptions {
  port?: number;
  host?: "127.0.0.1";
  dataDir?: string;
  webDir?: string;
}

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Dépendances internes (injectables pour les tests). */
export interface InternalOptions {
  providerFactory?: ProviderFactory;
  logger?: Logger;
  /** Mode dev : autorise aussi l'origine Vite http://localhost:5173. */
  dev?: boolean;
  /** Désactive la tâche d'inactivité périodique (tests). */
  idleCheck?: boolean;
}

export interface InternalRunningServer extends RunningServer {
  service: AppService;
}

export const DEFAULT_PORT = 4317;

export function defaultDataDir(): string {
  if (process.env.MYCLAUDE_DATA_DIR) return path.resolve(process.env.MYCLAUDE_DATA_DIR);
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "MyClaude", "data");
  }
  return path.join(os.homedir(), ".config", "MyClaude", "data");
}

export function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function startServerInternal(opts: StartOptions = {}, internal: InternalOptions = {}): Promise<InternalRunningServer> {
  const host = "127.0.0.1"; // jamais d'écoute sur une autre interface
  if (opts.host !== undefined && opts.host !== host) throw new Error("MyClaude n'écoute que sur 127.0.0.1.");
  const log = internal.logger ?? consoleLogger;
  const dataDir = path.resolve(opts.dataDir ?? defaultDataDir());
  const storage = new Storage(dataDir);
  const service = new AppService(storage, internal.providerFactory ?? defaultProviderFactory, log);
  await service.start({ idleCheck: internal.idleCheck });

  let port = 0;
  const server = http.createServer(
    createRequestHandler({
      service,
      version: readVersion(),
      webDir: opts.webDir ? path.resolve(opts.webDir) : undefined,
      dev: internal.dev ?? false,
      log,
      getPort: () => port,
    }),
  );
  server.requestTimeout = 0; // les flux SSE peuvent durer longtemps
  server.headersTimeout = 30_000;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? DEFAULT_PORT, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    await service.shutdown();
    throw err;
  }
  port = (server.address() as AddressInfo).port;
  const url = `http://${host}:${port}`;

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await service.shutdown(); // interrompt les flux, journalise, clôt les sessions (app-quit)
      server.closeAllConnections();
      await closed;
    })());

  return { port, url, close, service };
}
