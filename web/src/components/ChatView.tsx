import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { errorMessage, isAbortError } from "../errors";
import type { AppConfig, ChatMessage, SessionMeta } from "../types";
import { STATUS_LABEL, modelLabel } from "../util";
import { Composer } from "./Composer";
import { IconRetry, IconSettings, Logo } from "./Icons";
import { CopyButton, Markdown } from "./Markdown";

const HEARTBEAT_MS = 30_000;

interface Props {
  config: AppConfig;
  sessionId: string | null;
  menuButton: ReactNode;
  onSessionCreated(meta: SessionMeta): void;
  onSessionsChanged(): void;
  onOpenSettings(): void;
}

interface Draft {
  thinking: string;
  text: string;
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

export function ChatView({ config, sessionId, menuButton, onSessionCreated, onSessionsChanged, onOpenSettings }: Props) {
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

  const abortRef = useRef<AbortController | null>(null);
  const createdIdRef = useRef<string | null>(null);
  const genRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
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
      const local: Draft = { thinking: "", text: "" };
      setDraft({ ...local });
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
                setDraft({ ...local });
                break;
              case "delta":
                local.text += ev.text;
                setDraft({ ...local });
                break;
              case "done":
                finished = true;
                setMessages((m) => [...m, ev.message]);
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
  const composerDisabled = !config.hasApiKey || !isOpen || loading || !!loadError;
  const disabledReason = !config.hasApiKey
    ? "Ajoutez une clé API dans les Réglages pour discuter."
    : !isOpen
      ? "Cette session est terminée. Démarrez une nouvelle session pour continuer."
      : "Chargement…";

  const last = messages[messages.length - 1];
  const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.text;
  const canRetry = !streaming && isOpen && config.hasApiKey && last?.role === "assistant" && !!last.error && !!lastUserText;

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

          {isEmpty && !config.hasApiKey && (
            <div className="welcome">
              <Logo size={40} />
              <h2 className="serif welcome-title">Bienvenue dans MyClaude</h2>
              <p className="muted">
                Pour commencer, enregistrez votre clé API Anthropic. Elle reste sur cette machine et sert
                uniquement aux appels au modèle.
              </p>
              <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
                <IconSettings size={16} /> Ouvrir les Réglages
              </button>
            </div>
          )}

          {isEmpty && config.hasApiKey && (
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
                  {draft.text ? <Markdown text={draft.text} /> : <span className="typing" aria-label="En attente de la réponse"><i /><i /><i /></span>}
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
    </section>
  );
}
