import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { ApiError, errorMessage, isAbortError } from "../errors";
import type { AppConfig, ChatMessage, PermissionDecision, SessionMeta, ToolCall } from "../types";
import { STATUS_LABEL, engineReady, modelLabel } from "../util";
import { summaryText } from "../tools";
import { Composer } from "./Composer";
import { IconRetry, IconSettings, Logo } from "./Icons";
import { CopyButton, Markdown } from "./Markdown";
import { ToolList, type PermState } from "./ToolActivity";

const HEARTBEAT_MS = 30_000;

interface Props {
  config: AppConfig;
  sessionId: string | null;
  menuButton: ReactNode;
  onSessionCreated(meta: SessionMeta): void;
  onSessionsChanged(): void;
  onOpenSettings(): void;
  onRecheckEngine(): void;
}

interface Draft {
  thinking: string;
  text: string;
  tools: ToolCall[];
  perms: PermState[];
}

const DECISION_LABEL: Record<PermissionDecision, string> = {
  allow: "Autorisé.",
  allow_session: "Autorisé pour toute la session.",
  deny: "Refusé.",
};

/** Un message figé ne doit pas garder d'outil « en cours » / « en attente ». */
function settleTools(tools: ToolCall[]): ToolCall[] {
  return tools.map((t) =>
    t.status === "running" || t.status === "pending_approval"
      ? { ...t, status: "error", resultPreview: t.resultPreview ?? "Interrompu." }
      : t,
  );
}

let localCounter = 0;
const localId = (p: string) => `local-${p}-${++localCounter}`;

function greeting(): string {
  const h = new Date().getHours();
  return h >= 18 || h < 5 ? "Bonsoir" : "Bonjour";
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  if (!text && !live) return null;
  return (
    <details className="thinking">
      <summary>
        {live && !text ? "Réflexion en cours…" : live ? "Réflexion…" : "Réflexion"}
      </summary>
      <div className="thinking-body">{text || "…"}</div>
    </details>
  );
}

function EngineSetup({ config, onOpenSettings, onRecheck }: { config: AppConfig; onOpenSettings(): void; onRecheck(): void }) {
  const subscription = config.authMode !== "apiKey";
  return (
    <div className="welcome">
      <Logo size={40} />
      <h2 className="serif welcome-title">Bienvenue dans MyClaude</h2>
      {subscription ? (
        <>
          <p className="muted">
            MyClaude utilise comme moteur le compte connecté à Claude Code sur ce PC (mode Abonnement). Aucun compte
            utilisable n'est détecté pour l'instant.
          </p>
          <ol className="setup-steps">
            <li>
              Ouvre un terminal, lance <code>claude</code> puis <code>/login</code>
            </li>
            <li>Termine la connexion dans le navigateur, puis reviens ici.</li>
            <li>Clique sur « Revérifier ».</li>
          </ol>
          {config.engineError && (
            <p className="engine-error small" role="note">
              Détail : {config.engineError}
            </p>
          )}
          <div className="welcome-actions">
            <button type="button" className="btn btn-primary" onClick={onRecheck}>
              <IconRetry size={16} /> Revérifier
            </button>
            <button type="button" className="btn" onClick={onOpenSettings}>
              <IconSettings size={16} /> Réglages
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            Le moteur est réglé sur « Clé API » : enregistrez votre clé API Anthropic dans les Réglages. Elle reste sur
            cette machine. Vous pouvez aussi repasser en mode Abonnement (Claude Code).
          </p>
          {config.engineError && (
            <p className="engine-error small" role="note">
              Détail : {config.engineError}
            </p>
          )}
          <div className="welcome-actions">
            <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
              <IconSettings size={16} /> Ouvrir les Réglages
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ChatView({
  config,
  sessionId,
  menuButton,
  onSessionCreated,
  onSessionsChanged,
  onOpenSettings,
  onRecheckEngine,
}: Props) {
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [restore, setRestore] = useState<{ text: string; n: number } | null>(null);
  const [status, setStatus] = useState("");
  const [alertText, setAlertText] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const createdIdRef = useRef<string | null>(null);
  const genRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  /** Brouillon du flux en cours (mutable) + session visée, pour répondre aux demandes d'autorisation. */
  const liveRef = useRef<{ draft: Draft; sessionId: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Chargement de la session affichée.
  useEffect(() => {
    if (sessionId && sessionId === createdIdRef.current) {
      createdIdRef.current = null; // créée ici : l'état est déjà en place
      return;
    }
    genRef.current++;
    abortRef.current?.abort();
    setBanner(null);
    setDraft(null);
    setStreaming(false);
    setLoadError(null);
    if (!sessionId) {
      setMeta(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setMeta(null);
    setMessages([]);
    api
      .getSession(sessionId)
      .then((r) => {
        if (cancelled) return;
        setMeta(r.session);
        setMessages(r.messages);
        stickRef.current = true;
      })
      .catch((e) => !cancelled && setLoadError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadKey]);

  // Interrompt un flux en cours si la vue est démontée.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Heartbeat pour la session ouverte affichée.
  const hbId = meta?.status === "open" ? meta.id : null;
  useEffect(() => {
    if (!hbId) return;
    const beat = () => {
      api.heartbeat(hbId).catch(() => {
        /* silencieux : le serveur récupérera la session au besoin */
      });
    };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [hbId]);

  // Défilement automatique tant que l'utilisateur est en bas.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, draft]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = useCallback(
    async (text: string) => {
      setBanner(null);
      const gen = genRef.current;
      const alive = () => genRef.current === gen;
      let id = meta?.id ?? null;
      if (!id) {
        try {
          const created = await api.createSession();
          createdIdRef.current = created.id;
          id = created.id;
          setMeta(created);
          onSessionCreated(created);
        } catch (e) {
          setBanner(errorMessage(e));
          setRestore({ text, n: Date.now() });
          return;
        }
      }

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const pendingId = localId("user");
      setMessages((m) => [...m, { id: pendingId, role: "user", text, createdAt: new Date().toISOString() }]);
      const local: Draft = { thinking: "", text: "", tools: [], perms: [] };
      const sync = () => setDraft({ ...local });
      liveRef.current = { draft: local, sessionId: id };
      sync();
      setStreaming(true);
      setStatus("Claude rédige une réponse…");
      stickRef.current = true;

      let userConfirmed = false;
      let finished = false;
      const pushAssistantError = (error: string) =>
        setMessages((m) => [
          ...m,
          {
            id: localId("asst"),
            role: "assistant",
            text: local.text,
            thinking: local.thinking || undefined,
            tools: local.tools.length ? settleTools(local.tools) : undefined,
            error,
            createdAt: new Date().toISOString(),
          },
        ]);

      try {
        await api.sendMessage(
          id,
          text,
          (ev) => {
            if (!alive()) return;
            switch (ev.type) {
              case "user":
                userConfirmed = true;
                setMessages((m) => m.map((x) => (x.id === pendingId ? ev.message : x)));
                break;
              case "thinking":
                local.thinking += ev.text;
                sync();
                break;
              case "delta":
                local.text += ev.text;
                sync();
                break;
              case "tool_use": {
                const t = ev.tool;
                const i = local.tools.findIndex((x) => x.id === t.id);
                local.tools = i === -1 ? [...local.tools, t] : local.tools.map((x, j) => (j === i ? { ...x, ...t } : x));
                sync();
                break;
              }
              case "tool_result": {
                const r = ev.result;
                local.tools = local.tools.map((x) =>
                  x.id === r.id ? { ...x, status: r.status, resultPreview: r.resultPreview ?? x.resultPreview } : x,
                );
                // Une décision prise côté serveur (expiration, déconnexion) clôt la demande.
                local.perms = local.perms.map((p) =>
                  p.req.toolCallId === r.id && (p.state === "pending" || p.state === "sending")
                    ? { ...p, state: "expired" }
                    : p,
                );
                sync();
                break;
              }
              case "permission_request": {
                const req = ev.request;
                local.tools = local.tools.some((x) => x.id === req.toolCallId)
                  ? local.tools.map((x) => (x.id === req.toolCallId ? { ...x, status: "pending_approval" } : x))
                  : [...local.tools, { id: req.toolCallId, name: req.tool, input: req.input, status: "pending_approval" }];
                local.perms = [...local.perms.filter((p) => p.req.id !== req.id), { req, state: "pending" }];
                stickRef.current = true;
                sync();
                const what = req.summary || summaryText(req.tool, req.input);
                setAlertText(`Autorisation requise : ${what}. Choisissez Autoriser, Toujours pour cette session ou Refuser.`);
                break;
              }
              case "done":
                finished = true;
                setMessages((m) => [
                  ...m,
                  ev.message.tools?.length || !local.tools.length
                    ? ev.message
                    : { ...ev.message, tools: settleTools(local.tools) },
                ]);
                setDraft(null);
                setStatus("Réponse terminée.");
                break;
              case "error":
                finished = true;
                pushAssistantError(ev.error);
                setDraft(null);
                setStatus(`Erreur : ${ev.error}`);
                break;
            }
          },
          ctrl.signal,
        );
        if (!finished && alive()) {
          pushAssistantError("La connexion au serveur a été interrompue.");
          setStatus("Réponse interrompue.");
        }
      } catch (e) {
        if (!finished && alive()) {
          if (isAbortError(e) || ctrl.signal.aborted) {
            if (userConfirmed || local.text || local.thinking) pushAssistantError("Réponse interrompue.");
            else setMessages((m) => m.filter((x) => x.id !== pendingId));
            setStatus("Génération arrêtée.");
          } else if (!userConfirmed) {
            // Rien n'a été enregistré : on rend le texte à l'utilisateur.
            setMessages((m) => m.filter((x) => x.id !== pendingId));
            setBanner(errorMessage(e));
            setRestore({ text, n: Date.now() });
            setStatus(`Erreur : ${errorMessage(e)}`);
          } else {
            pushAssistantError(errorMessage(e));
            setStatus(`Erreur : ${errorMessage(e)}`);
          }
        }
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
        if (liveRef.current?.draft === local) liveRef.current = null;
        setAlertText("");
        onSessionsChanged();
        if (alive()) {
          setDraft(null);
          setStreaming(false);
          // Rafraîchit les métadonnées (titre automatique, statut).
          const sid = id;
          api
            .getSession(sid)
            .then((r) => setMeta((cur) => (cur?.id === sid ? r.session : cur)))
            .catch(() => {});
        }
      }
    },
    [meta?.id, onSessionCreated, onSessionsChanged],
  );

  const stop = () => abortRef.current?.abort();

  const decide = useCallback(async (reqId: string, decision: PermissionDecision) => {
    const live = liveRef.current;
    if (!live) return;
    const local = live.draft;
    const patch = (fn: (p: PermState) => PermState) => {
      local.perms = local.perms.map((p) => (p.req.id === reqId ? fn(p) : p));
      if (liveRef.current?.draft === local) setDraft({ ...local });
    };
    const perm = local.perms.find((p) => p.req.id === reqId);
    if (!perm || perm.state !== "pending") return;
    patch((p) => ({ ...p, state: "sending", error: undefined }));
    setAlertText("");
    try {
      await api.respondPermission(live.sessionId, reqId, decision);
      // Mise à jour optimiste ; `tool_result` donnera l'état final.
      local.tools = local.tools.map((t) =>
        t.id === perm.req.toolCallId && t.status === "pending_approval"
          ? { ...t, status: decision === "deny" ? "denied" : "running" }
          : t,
      );
      patch((p) => ({ ...p, state: "answered", decision }));
      setStatus(DECISION_LABEL[decision]);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        local.tools = local.tools.map((t) =>
          t.id === perm.req.toolCallId && t.status === "pending_approval" ? { ...t, status: "denied" } : t,
        );
        patch((p) => ({ ...p, state: "expired" }));
        setStatus("Cette demande d'autorisation a expiré.");
      } else {
        patch((p) => ({ ...p, state: "pending", error: errorMessage(e) }));
      }
    }
  }, []);

  const closeSession = async () => {
    if (!meta) return;
    setClosing(true);
    try {
      abortRef.current?.abort();
      const m = await api.closeSession(meta.id);
      setMeta(m);
      onSessionsChanged();
    } catch (e) {
      setBanner(errorMessage(e));
    } finally {
      setClosing(false);
    }
  };

  const isOpen = !meta || meta.status === "open";
  const ready = engineReady(config);
  const composerDisabled = !ready || !isOpen || loading || !!loadError;
  const disabledReason = !ready
    ? config.authMode === "apiKey"
      ? "Ajoutez une clé API dans les Réglages pour discuter."
      : "Connectez-vous à Claude Code (claude puis /login) pour discuter."
    : !isOpen
      ? "Cette session est terminée. Démarrez une nouvelle session pour continuer."
      : "Chargement…";

  const last = messages[messages.length - 1];
  const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.text;
  const canRetry = !streaming && isOpen && ready && last?.role === "assistant" && !!last.error && !!lastUserText;
  const waitingApproval = !!draft?.perms.some((p) => p.state === "pending" || p.state === "sending");

  const isEmpty = !sessionId && messages.length === 0 && !streaming;
  const model = meta?.model ?? config.model;

  return (
    <section className="view chat-view" aria-label="Discussion">
      <header className="view-header">
        {menuButton}
        <div className="header-titles">
          <h1 className="header-title">{meta?.title ?? "Nouvelle session"}</h1>
          <p className="header-sub">
            <span>{modelLabel(model, config.availableModels)}</span>
            {meta && (
              <>
                <span aria-hidden="true"> · </span>
                <span className={`badge badge-${meta.status}`}>{STATUS_LABEL[meta.status]}</span>
              </>
            )}
          </p>
        </div>
        {meta?.status === "open" && (
          <button type="button" className="btn btn-ghost" onClick={closeSession} disabled={closing}>
            {closing ? "Clôture…" : "Terminer la session"}
          </button>
        )}
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column">
          {loading && <p className="muted center pad">Chargement de la session…</p>}
          {loadError && (
            <div className="notice notice-error" role="alert">
              <p>{loadError}</p>
              <button type="button" className="btn" onClick={() => setReloadKey((k) => k + 1)}>
                Réessayer
              </button>
            </div>
          )}

          {isEmpty && !ready && (
            <EngineSetup config={config} onOpenSettings={onOpenSettings} onRecheck={onRecheckEngine} />
          )}

          {isEmpty && ready && (
            <div className="welcome">
              <Logo size={40} />
              <h2 className="serif welcome-title">{greeting()}, que puis-je faire pour vous ?</h2>
            </div>
          )}

          <ol className="messages" aria-label="Messages">
            {messages.map((m) => (
              <li key={m.id} className={`msg msg-${m.role}`}>
                {m.role === "user" ? (
                  <div className="bubble">{m.text}</div>
                ) : (
                  <div className="assistant">
                    {m.thinking && <Thinking text={m.thinking} />}
                    {m.tools && m.tools.length > 0 && <ToolList tools={m.tools} />}
                    {m.text && <Markdown text={m.text} />}
                    {m.error && (
                      <div className="msg-error" role="note">
                        <span>{m.error}</span>
                        {canRetry && m === last && (
                          <button type="button" className="btn btn-small" onClick={() => send(lastUserText!)}>
                            <IconRetry size={14} /> Réessayer
                          </button>
                        )}
                      </div>
                    )}
                    {m.text && !m.error && (
                      <div className="msg-actions">
                        <CopyButton text={m.text} label="Copier" />
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
            {draft && (
              <li className="msg msg-assistant">
                <div className="assistant" aria-live="polite" aria-busy={streaming}>
                  <Thinking text={draft.thinking} live />
                  <ToolList tools={draft.tools} perms={draft.perms} onDecide={decide} />
                  {draft.text ? (
                    <Markdown text={draft.text} />
                  ) : waitingApproval ? null : (
                    <span className="typing" aria-label="En attente de la réponse">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
              </li>
            )}
          </ol>

          {meta && meta.status !== "open" && !loading && (
            <div className="notice">
              <p>
                {meta.status === "interrupted"
                  ? "Cette session a été interrompue (coupure ou fermeture inattendue) puis récupérée."
                  : "Cette session est terminée."}{" "}
                {meta.review === "done"
                  ? "Le bilan est fait : consultez l'onglet Apprentissage pour les leçons proposées."
                  : meta.review === "running"
                    ? "Le bilan est en cours."
                    : meta.review === "failed"
                      ? `Le bilan a échoué${meta.reviewError ? ` : ${meta.reviewError}` : ""}. Il sera retenté.`
                      : "Le bilan sera effectué en arrière-plan."}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {banner && (
          <div className="notice notice-error composer-banner" role="alert">
            <p>{banner}</p>
            <button type="button" className="icon-btn" onClick={() => setBanner(null)} aria-label="Fermer le message d'erreur">
              ×
            </button>
          </div>
        )}
        <Composer
          disabled={composerDisabled}
          disabledReason={disabledReason}
          streaming={streaming}
          autoFocus
          onSend={send}
          onStop={stop}
          restore={restore}
          placeholder={messages.length ? "Répondre…" : "Comment puis-je vous aider ?"}
        />
        <p className="footnote">Conversations enregistrées localement. Claude peut se tromper : vérifiez les informations importantes.</p>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {alertText}
      </div>
    </section>
  );
}
