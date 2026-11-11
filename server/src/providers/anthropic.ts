import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ContentTooLargeError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
  RequestTimeoutError,
} from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  ProviderError,
  type Provider,
  type ProviderChatParams,
  type ProviderChatResult,
  type ProviderJsonParams,
  type ProviderStopReason,
} from "./types.js";

/** Seul hôte autorisé pour les appels sortants. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const MAX_TOKENS = 64000;
const REVIEW_MAX_TOKENS = 16000;

/** Modèles bénéficiant du fallback serveur en cas de refus (pas Haiku). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]);

/**
 * Construit le client UNIQUEMENT à partir de la clé de l'app.
 * - `apiKey` explicite : le SDK ne lit alors ni ANTHROPIC_API_KEY, ni
 *   ANTHROPIC_AUTH_TOKEN, ni les profils `ant` (chaîne d'identifiants désactivée).
 * - `authToken: null` : jamais de jeton Bearer hérité.
 * - `baseURL` explicite : ANTHROPIC_BASE_URL est ignoré, aucun profil ne peut le remplacer.
 * - `openTelemetry: false` : aucun span / propagation de trace.
 * - `logLevel: "off"` : ANTHROPIC_LOG ignoré, rien n'est journalisé par le SDK.
 */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL: ANTHROPIC_BASE_URL,
    openTelemetry: false,
    logLevel: "off",
    maxRetries: 2,
  });
}

/** Paramètres communs (thinking adaptatif résumé, effort, fallback). */
export function buildStreamParams(opts: {
  model: string;
  effort: ProviderChatParams["effort"];
  system: string;
  messages: BetaMessageParam[];
  maxTokens?: number;
  format?: Record<string, unknown>;
}): BetaMessageStreamParams {
  const params: BetaMessageStreamParams = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? MAX_TOKENS,
    system: opts.system,
    messages: opts.messages,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: opts.format
      ? { effort: opts.effort, format: { type: "json_schema", schema: opts.format } }
      : { effort: opts.effort },
  };
  if (FALLBACK_MODELS.has(opts.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

function mapStopReason(reason: BetaMessage["stop_reason"]): ProviderStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
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

export function refusalMessage(category?: string | null): string {
  const base = "Claude a refusé de répondre à cette demande (refus de sécurité).";
  return category ? `${base} Catégorie : ${category}.` : base;
}

/** Traduit les erreurs typées du SDK en ProviderError (messages FR). Ne contient jamais la clé. */
export function mapSdkError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof APIUserAbortError) return new ProviderError("aborted", "Réponse interrompue.");
  if (err instanceof APIConnectionTimeoutError)
    return new ProviderError("timeout", "Délai dépassé en attendant l'API Anthropic. Réessayez.");
  if (err instanceof APIConnectionError)
    return new ProviderError(
      "connection",
      "Impossible de joindre l'API Anthropic. Vérifiez votre connexion Internet.",
    );
  if (err instanceof AuthenticationError)
    return new ProviderError("auth", "Clé API invalide ou révoquée. Vérifiez-la dans les Réglages.");
  if (err instanceof PermissionDeniedError)
    return new ProviderError("permission", "Accès refusé : cette clé API n'a pas les droits nécessaires pour ce modèle.");
  if (err instanceof NotFoundError)
    return new ProviderError("not_found", "Modèle introuvable ou indisponible pour cette clé API.");
  if (err instanceof RateLimitError)
    return new ProviderError("rate_limit", "Limite de débit atteinte. Patientez un peu puis réessayez.");
  if (err instanceof OverloadedError)
    return new ProviderError("overloaded", "Les serveurs d'Anthropic sont surchargés. Réessayez dans un instant.");
  if (err instanceof ContentTooLargeError)
    return new ProviderError("too_large", "La conversation est trop volumineuse pour être envoyée. Commencez une nouvelle session.");
  if (err instanceof RequestTimeoutError)
    return new ProviderError("timeout", "Délai dépassé côté API Anthropic. Réessayez.");
  if (err instanceof BadRequestError)
    return new ProviderError("bad_request", `Requête refusée par l'API Anthropic : ${apiErrorDetail(err)}`);
  if (err instanceof InternalServerError)
    return new ProviderError("server", `Erreur du serveur Anthropic (code ${err.status}). Réessayez plus tard.`);
  if (err instanceof APIError) {
    if (err.status === 402)
      return new ProviderError("permission", "Crédit API insuffisant. Vérifiez la facturation de votre compte Anthropic.");
    return new ProviderError("unknown", `Erreur de l'API Anthropic${err.status ? ` (code ${err.status})` : ""}.`);
  }
  return new ProviderError("unknown", "Erreur inattendue lors de l'appel au modèle.");
}

function apiErrorDetail(err: APIError): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const msg = body?.error?.message;
  return typeof msg === "string" && msg ? msg : "paramètres invalides.";
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = createAnthropicClient(apiKey);
  }

  async chat(p: ProviderChatParams): Promise<ProviderChatResult> {
    const params = buildStreamParams({
      model: p.model,
      effort: p.effort,
      system: p.system,
      messages: p.messages.map((m) => ({ role: m.role, content: m.text })),
    });
    try {
      const stream = this.client.beta.messages.stream(params, { signal: p.signal });
      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "thinking_delta") p.onThinking(event.delta.thinking);
          else if (event.delta.type === "text_delta") p.onText(event.delta.text);
        }
      }
      const final = await stream.finalMessage();
      return {
        stopReason: mapStopReason(final.stop_reason),
        usage: { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens },
        servedBy: final.model,
        refusalCategory: final.stop_details?.category ?? null,
      };
    } catch (err) {
      throw mapSdkError(err);
    }
  }

  async generateJson(p: ProviderJsonParams): Promise<unknown> {
    const params = buildStreamParams({
      model: p.model,
      effort: p.effort,
      system: p.system,
      messages: [{ role: "user", content: p.prompt }],
      maxTokens: REVIEW_MAX_TOKENS,
      format: p.schema,
    });
    let final: BetaMessage;
    try {
      // Streaming + finalMessage() : évite le refus SDK des requêtes longues non diffusées.
      final = await this.client.beta.messages.stream(params, { signal: p.signal }).finalMessage();
    } catch (err) {
      throw mapSdkError(err);
    }
    if (final.stop_reason === "refusal")
      throw new ProviderError("refusal", refusalMessage(final.stop_details?.category));
    if (final.stop_reason === "max_tokens")
      throw new ProviderError("invalid_output", "Le bilan a été tronqué (limite de longueur atteinte).");
    const text = final.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("");
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("invalid_output", "Le bilan renvoyé par le modèle n'est pas un JSON valide.");
    }
  }
}
