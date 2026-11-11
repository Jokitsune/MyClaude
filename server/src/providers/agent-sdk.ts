import os from "node:os";
import {
  USAGE_LIMIT_ERROR_PREFIXES,
  deleteSession,
  forkSession,
  query,
  type HookCallback,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AuthMode } from "../types.js";
import {
  ProviderError,
  type EngineStatus,
  type Provider,
  type ProviderChatParams,
  type ProviderChatResult,
  type ProviderErrorCode,
  type ProviderJsonParams,
  type ProviderStopReason,
} from "./types.js";

/**
 * Moteur = Claude Agent SDK (sous-processus Claude Code).
 *
 * Isolation de la gouvernance : aucun réglage Claude Code de l'utilisateur n'est chargé
 * (`settingSources: []`, donc ni CLAUDE.md, ni hooks, ni permissions, ni MCP de ~/.claude),
 * MCP strictement limités à ceux de MyClaude (`strictMcpConfig`), aucune compétence (`skills: []`),
 * aucun plugin, prompt système entièrement fourni par MyClaude.
 */

export const SCRUBBED_ENV_VARS: readonly string[] = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
const PREVIEW_MAX = 2000;
const STATUS_TIMEOUT_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOT_LOGGED_IN_MESSAGE = "Connecte-toi à Claude Code (`claude` puis `/login`).";

export interface EngineAuth {
  mode: AuthMode;
  apiKey?: string;
}

/**
 * Environnement du sous-processus : copie de process.env SANS identifiants Anthropic hérités
 * (comparaison insensible à la casse, les variables Windows l'étant).
 * - subscription : le login Claude Code de la machine est utilisé ;
 * - apiKey : ANTHROPIC_API_KEY = clé de config.json (et rien d'autre).
 */
export function buildEngineEnv(base: NodeJS.ProcessEnv, auth: EngineAuth): Record<string, string> {
  const scrub = new Set(SCRUBBED_ENV_VARS.map((k) => k.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !scrub.has(k.toUpperCase())) env[k] = v;
  }
  if (auth.mode === "apiKey" && auth.apiKey) env.ANTHROPIC_API_KEY = auth.apiKey;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "myclaude";
  return env;
}

/** Options communes : isolation complète vis-à-vis de la configuration Claude Code du compte. */
export function isolationOptions(auth: EngineAuth, env: NodeJS.ProcessEnv = process.env): Partial<Options> {
  return {
    env: buildEngineEnv(env, auth),
    settingSources: [],
    strictMcpConfig: true,
    skills: [],
    plugins: [],
  };
}

function preview(content: unknown): string {
  let s: string;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    s = content
      .map((b) => {
        const block = b as { type?: string; text?: string };
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        if (block?.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else if (content === undefined || content === null) s = "";
  else s = JSON.stringify(content);
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX - 1) + "…" : s;
}

function mapStopReason(r: string | null | undefined): ProviderStopReason {
  switch (r) {
    case null:
    case undefined:
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
      return "end";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

const AUTH_TEXT_RE = /not logged in|please run \/login|\/login|invalid api key|oauth token|authenticat|credential/i;

/** Traduit une erreur du moteur en ProviderError (FR). Ne contient jamais la clé. */
export function mapEngineError(info: {
  authMode: AuthMode;
  assistantError?: SDKAssistantMessageError;
  resultText?: string;
  thrown?: unknown;
}): ProviderError {
  const { authMode, assistantError: ae } = info;
  if (info.thrown instanceof ProviderError) return info.thrown;
  const thrownMsg = info.thrown instanceof Error ? info.thrown.message : info.thrown ? String(info.thrown) : "";
  const text = (info.resultText ?? "").trim() || thrownMsg.replace(/^Claude Code returned an error result:\s*/i, "");
  const authErr = (): ProviderError =>
    authMode === "apiKey"
      ? new ProviderError("auth", "Clé API invalide ou révoquée. Vérifiez-la dans les Réglages.")
      : new ProviderError("not_logged_in", NOT_LOGGED_IN_MESSAGE);

  if (USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.startsWith(p)))
    return new ProviderError("rate_limit", `Limite d'utilisation atteinte : ${text}`);
  switch (ae) {
    case "authentication_failed":
      return authErr();
    case "oauth_org_not_allowed":
      return new ProviderError("permission", "L'organisation de ce compte n'autorise pas cet usage de Claude Code.");
    case "account_on_hold":
      return new ProviderError("permission", "Le compte Claude est suspendu.");
    case "verification_required":
      return new ProviderError("permission", "Le compte Claude doit être vérifié (ouvre Claude Code pour le faire).");
    case "billing_error":
      return new ProviderError("permission", "Problème de facturation ou crédit insuffisant sur le compte.");
    case "rate_limit":
      return new ProviderError("rate_limit", text ? `Limite d'utilisation atteinte : ${text}` : "Limite d'utilisation atteinte. Réessayez plus tard.");
    case "overloaded":
      return new ProviderError("overloaded", "Les serveurs d'Anthropic sont surchargés. Réessayez dans un instant.");
    case "model_not_found":
      return new ProviderError("not_found", "Modèle introuvable ou indisponible pour ce compte.");
    case "server_error":
      return new ProviderError("server", "Erreur du serveur Anthropic. Réessayez plus tard.");
    case "invalid_request":
      return new ProviderError("bad_request", `Requête refusée${text ? ` : ${text}` : "."}`);
    default:
      break;
  }
  if (AUTH_TEXT_RE.test(text)) return authErr();
  const code = (info.thrown as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || /ENOENT|spawn|executable/i.test(thrownMsg))
    return new ProviderError("engine_missing", "Claude Code n'a pas pu être lancé (exécutable introuvable).");
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|connection/i.test(text))
    return new ProviderError("connection", "Impossible de joindre Anthropic. Vérifiez votre connexion Internet.");
  return new ProviderError("unknown", text ? `Erreur du moteur Claude : ${text.slice(0, 500)}` : "Erreur inattendue du moteur Claude.");
}

/** Codes qui ne justifient pas de retenter sans reprise. */
const NO_FRESH_RETRY: ReadonlySet<ProviderErrorCode> = new Set([
  "aborted",
  "auth",
  "not_logged_in",
  "engine_missing",
  "rate_limit",
  "permission",
  "overloaded",
]);

export interface AgentSdkProviderOptions {
  auth: EngineAuth;
  /** Remplace `query` (tests). */
  queryFn?: typeof query;
  /** Environnement de base (tests). */
  baseEnv?: NodeJS.ProcessEnv;
}

export class AgentSdkProvider implements Provider {
  readonly name = "claude-agent-sdk";
  private readonly auth: EngineAuth;
  private readonly queryFn: typeof query;
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(opts: AgentSdkProviderOptions) {
    this.auth = opts.auth;
    this.queryFn = opts.queryFn ?? query;
    this.baseEnv = opts.baseEnv ?? process.env;
  }

  /** Options de base partagées (exposées pour les tests). */
  baseOptions(): Partial<Options> {
    return isolationOptions(this.auth, this.baseEnv);
  }

  async chat(p: ProviderChatParams): Promise<ProviderChatResult> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (p.signal.aborted) throw new ProviderError("aborted", "Réponse interrompue.");
    p.signal.addEventListener("abort", onAbort, { once: true });

    const preToolUse: HookCallback = async (input, toolUseID) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const r = await p.gate.preToolUse(input.tool_name, input.tool_input, input.tool_use_id ?? toolUseID ?? "");
      if (r.decision === "allow" || r.decision === "deny" || r.decision === "ask") {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: r.decision,
            ...(r.reason ? { permissionDecisionReason: r.reason } : {}),
          },
        };
      }
      return {};
    };

    const tools = [...p.tools];
    if (Object.keys(p.agents).length && !tools.includes("Agent") && !tools.includes("Task")) tools.push("Agent");

    const options: Options = {
      ...this.baseOptions(),
      cwd: p.cwd,
      model: p.model,
      effort: p.effort,
      thinking: { type: "adaptive", display: "summarized" },
      // snapshot: false → system.md / memory.md modifiés s'appliquent aussi aux sessions reprises.
      systemPrompt: { type: "custom", prompt: p.system, snapshot: false },
      tools,
      mcpServers: p.mcpServers as Options["mcpServers"],
      agents: p.agents,
      permissionMode: "default",
      canUseTool: async (toolName, input, o) => {
        const r = await p.gate.canUseTool(toolName, input, { toolUseId: o.toolUseID, signal: o.signal });
        return r.behavior === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: r.message };
      },
      hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: 60 }] },
      includePartialMessages: true,
      abortController,
    };
    if (p.resume) options.resume = p.resume;

    let gotContent = false;
    let sessionId: string | undefined;
    let usage: ProviderChatResult["usage"];
    let stopReason: ProviderStopReason = "end";
    let refusalCategory: string | null | undefined;
    let assistantError: SDKAssistantMessageError | undefined;
    let resultError: string | undefined;
    let hadText = false;
    let currentMsgId: string | undefined;
    const streamedMsgIds = new Set<string>();

    const emitText = (t: string) => {
      if (!t) return;
      gotContent = true;
      hadText = true;
      p.onText(t);
    };

    const handle = (m: SDKMessage) => {
      switch (m.type) {
        case "system":
          if (m.subtype === "init") {
            if (m.session_id && m.session_id !== sessionId) {
              sessionId = m.session_id;
              p.onSessionId(m.session_id);
            }
          } else if (m.subtype === "model_refusal_no_fallback") {
            stopReason = "refusal";
            refusalCategory = m.api_refusal_category ?? null;
          }
          return;
        case "stream_event": {
          if (m.parent_tool_use_id) return;
          const ev = m.event;
          if (ev.type === "message_start") currentMsgId = ev.message.id;
          else if (ev.type === "content_block_start" && ev.content_block.type === "text" && hadText) emitText("\n\n");
          else if (ev.type === "content_block_delta") {
            if (ev.delta.type === "text_delta") {
              if (currentMsgId) streamedMsgIds.add(currentMsgId);
              emitText(ev.delta.text);
            } else if (ev.delta.type === "thinking_delta") {
              gotContent = true;
              p.onThinking(ev.delta.thinking);
            }
          }
          return;
        }
        case "assistant": {
          if (m.error) assistantError = m.error;
          for (const block of m.message.content ?? []) {
            if (block.type === "tool_use") {
              gotContent = true;
              p.onToolUse({ id: block.id, name: block.name, input: block.input });
            } else if (block.type === "text" && !m.parent_tool_use_id && !streamedMsgIds.has(m.message.id) && !m.error) {
              // Repli si le flux partiel n'a rien transmis pour ce message.
              if (hadText) emitText("\n\n");
              emitText(block.text);
            }
          }
          return;
        }
        case "user": {
          const content = (m as SDKUserMessage).message?.content;
          if (!Array.isArray(content)) return;
          for (const block of content) {
            const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
            if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
              p.onToolResult({ id: b.tool_use_id, isError: !!b.is_error, preview: preview(b.content) });
            }
          }
          return;
        }
        case "result": {
          if (m.session_id) sessionId = m.session_id;
          if (m.usage) usage = { input_tokens: m.usage.input_tokens ?? 0, output_tokens: m.usage.output_tokens ?? 0 };
          if (m.subtype === "success") {
            if (m.is_error) resultError = m.result || "erreur";
            const sr = mapStopReason(m.stop_reason);
            if (stopReason !== "refusal") stopReason = sr;
          } else {
            resultError = (m.errors ?? []).join("\n") || m.subtype;
          }
          return;
        }
        default:
          return;
      }
    };

    const q = this.queryFn({ prompt: p.prompt, options });
    try {
      for await (const m of q) handle(m);
    } catch (err) {
      if (p.signal.aborted) throw new ProviderError("aborted", "Réponse interrompue.");
      const mapped = mapEngineError({ authMode: this.auth.mode, assistantError, resultText: resultError, thrown: err });
      if (p.resume && !gotContent && !NO_FRESH_RETRY.has(mapped.code))
        throw new ProviderError("resume_failed", `Reprise impossible : ${mapped.message}`);
      throw mapped;
    } finally {
      p.signal.removeEventListener("abort", onAbort);
      try {
        q.close();
      } catch {
        // déjà fermé
      }
    }
    if (p.signal.aborted) throw new ProviderError("aborted", "Réponse interrompue.");
    if (resultError !== undefined || (assistantError && assistantError !== "max_output_tokens")) {
      const mapped = mapEngineError({ authMode: this.auth.mode, assistantError, resultText: resultError });
      if (p.resume && !gotContent && !NO_FRESH_RETRY.has(mapped.code))
        throw new ProviderError("resume_failed", `Reprise impossible : ${mapped.message}`);
      throw mapped;
    }
    if (assistantError === "max_output_tokens") stopReason = "max_tokens";
    return { stopReason, usage, sessionId, refusalCategory };
  }

  async generateJson(p: ProviderJsonParams): Promise<unknown> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    p.signal?.addEventListener("abort", onAbort, { once: true });
    const options: Options = {
      ...this.baseOptions(),
      cwd: os.tmpdir(),
      model: p.model,
      effort: p.effort,
      systemPrompt: { type: "custom", prompt: p.system, snapshot: false },
      tools: [], // aucun outil intégré
      mcpServers: {},
      agents: {},
      permissionMode: "default",
      canUseTool: async () => ({ behavior: "deny", message: "Aucun outil n'est autorisé pendant le bilan." }),
      outputFormat: { type: "json_schema", schema: p.schema },
      persistSession: false, // pas de transcription Claude Code pour les bilans
      maxTurns: 4,
      abortController,
    };
    let structured: unknown;
    let resultText: string | undefined;
    let resultError: string | undefined;
    let assistantError: SDKAssistantMessageError | undefined;
    let stop: ProviderStopReason = "end";
    const q = this.queryFn({ prompt: p.prompt, options });
    try {
      for await (const m of q) {
        if (m.type === "assistant" && m.error) assistantError = m.error;
        if (m.type === "system" && m.subtype === "model_refusal_no_fallback") stop = "refusal";
        if (m.type === "result") {
          if (m.subtype === "success") {
            if (m.is_error) resultError = m.result || "erreur";
            structured = m.structured_output;
            resultText = m.result;
            if (stop !== "refusal") stop = mapStopReason(m.stop_reason);
          } else resultError = (m.errors ?? []).join("\n") || m.subtype;
        }
      }
    } catch (err) {
      if (p.signal?.aborted) throw new ProviderError("aborted", "Bilan interrompu.");
      throw mapEngineError({ authMode: this.auth.mode, assistantError, resultText: resultError, thrown: err });
    } finally {
      p.signal?.removeEventListener("abort", onAbort);
      try {
        q.close();
      } catch {
        // déjà fermé
      }
    }
    if (resultError !== undefined || assistantError)
      throw mapEngineError({ authMode: this.auth.mode, assistantError, resultText: resultError });
    if (stop === "refusal") throw new ProviderError("refusal", "Claude a refusé de produire le bilan.");
    if (stop === "max_tokens") throw new ProviderError("invalid_output", "Le bilan a été tronqué (limite de longueur atteinte).");
    if (structured !== undefined && structured !== null) return structured;
    return parseJsonText(resultText ?? "");
  }

  async status(): Promise<EngineStatus> {
    if (this.auth.mode === "apiKey" && !this.auth.apiKey)
      return { ready: false, account: null, error: "Mode clé API : aucune clé configurée. Ajoutez-la dans les Réglages." };
    let release: (() => void) | undefined;
    const idle = (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((r) => (release = r));
    })();
    const abortController = new AbortController();
    const q = this.queryFn({
      prompt: idle,
      options: { ...this.baseOptions(), cwd: os.tmpdir(), tools: [], persistSession: false, abortController },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const info = await Promise.race([
        q.accountInfo(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("délai dépassé")), STATUS_TIMEOUT_MS);
        }),
      ]);
      if (this.auth.mode === "apiKey") return { ready: true, account: null };
      const account = {
        ...(info.email ? { email: info.email } : {}),
        ...(info.organization ? { organization: info.organization } : {}),
        ...(info.subscriptionType ? { subscription: info.subscriptionType } : {}),
      };
      const thirdParty = !!info.apiProvider && info.apiProvider !== "firstParty";
      const loggedIn =
        Object.keys(account).length > 0 || (!!info.tokenSource && info.tokenSource !== "none") || thirdParty;
      if (!loggedIn) return { ready: false, account: null, error: NOT_LOGGED_IN_MESSAGE };
      return { ready: true, account };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ready: false, account: null, error: `Claude Code n'a pas pu être lancé : ${msg.slice(0, 300)}` };
    } finally {
      if (timer) clearTimeout(timer);
      try {
        q.close();
      } catch {
        // déjà fermé
      }
      abortController.abort();
      release?.();
    }
  }

  /** Supprime la transcription Claude Code (fichier {id}.jsonl du projet `cwd` uniquement). */
  async deleteTranscript(sessionId: string, cwd: string): Promise<void> {
    if (!UUID_RE.test(sessionId)) return;
    await deleteSession(sessionId, { dir: cwd });
  }
}

/**
 * v3 : fork d'une session Claude Code locale via `forkSession` du SDK.
 * Le SDK lit le fichier source et écrit les entrées (UUID remappés) dans un NOUVEAU fichier
 * `<nouvel-id>.jsonl` du même dossier projet ; le fichier d'origine n'est jamais réécrit.
 */
export async function forkClaudeCodeSession(sessionId: string): Promise<string> {
  if (!UUID_RE.test(sessionId)) throw new Error("identifiant de session invalide");
  const { sessionId: forkId } = await forkSession(sessionId);
  return forkId;
}

/** JSON éventuellement entouré d'un bloc de code Markdown. */
export function parseJsonText(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  try {
    return JSON.parse(t);
  } catch {
    throw new ProviderError("invalid_output", "Le bilan renvoyé par le modèle n'est pas un JSON valide.");
  }
}
