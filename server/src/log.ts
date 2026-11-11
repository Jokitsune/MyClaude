/** Journal console minimal. Ne jamais y passer la clé API ni le contenu des conversations. */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[myclaude] ${m}`),
  warn: (m) => console.warn(`[myclaude] ${m}`),
  error: (m, e) => console.error(`[myclaude] ${m}${e === undefined ? "" : ` — ${errText(e)}`}`),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
