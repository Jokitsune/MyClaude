import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { api } from "../api";
import { ApiError, errorMessage } from "../errors";
import type { AppConfig, CcProject, CcSessionSummary, CcTranscript, SessionMeta } from "../types";
import { fullDate, relativeDate } from "../util";
import { IconBranch, IconChat, IconChevron, IconFolder, IconSearch } from "./Icons";
import { MessageBody } from "./MessageView";

/** Position dans la vue « Sessions Claude Code » (gardée par App pour revenir au même endroit). */
export interface CcNav {
  projectId: string | null;
  sessionId: string | null;
}

interface Props {
  config: AppConfig;
  menuButton: ReactNode;
  nav: CcNav;
  onNav(nav: CcNav): void;
  /** Nouvelle session MyClaude créée par « Continuer dans MyClaude ». */
  onContinued(meta: SessionMeta): void;
}

/** Chemin absolu Windows (`C:\…`), UNC (`\\serveur\partage`) ou POSIX (`/…`). */
export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p) || p.startsWith("/");
}

function DateText({ iso, prefix }: { iso: string | null | undefined; prefix?: string }) {
  if (!iso) return null;
  return (
    <span>
      {prefix}
      <time dateTime={iso} title={fullDate(iso)}>
        {relativeDate(iso)}
      </time>
    </span>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function projectLabel(p: CcProject | undefined, id: string): string {
  return p?.path ?? id;
}

export function CcView({ config, menuButton, nav, onNav, onContinued }: Props) {
  const [projects, setProjects] = useState<CcProject[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsKey, setProjectsKey] = useState(0);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    setProjectsError(null);
    api
      .listCcProjects()
      .then((p) => !cancelled && setProjects(p))
      .catch((e) => !cancelled && setProjectsError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [projectsKey]);

  // À chaque changement de niveau, le focus va sur le titre du niveau affiché.
  const level = nav.sessionId ? "session" : nav.projectId ? "project" : "root";
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [level, nav.projectId, nav.sessionId]);

  const project = nav.projectId ? projects?.find((p) => p.id === nav.projectId) : undefined;

  return (
    <section className="view" aria-label="Sessions Claude Code">
      <header className="view-header">
        {menuButton}
        <div className="header-titles">
          <h1 className="header-title">Sessions Claude Code</h1>
          <p className="header-sub">Sessions locales de Claude Code sur ce PC — consultation en lecture seule.</p>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-column cc-column">
          <nav className="breadcrumb" aria-label="Fil d'Ariane">
            <ol>
              <li>
                {level === "root" ? (
                  <span aria-current="page">Projets</span>
                ) : (
                  <button type="button" className="crumb" onClick={() => onNav({ projectId: null, sessionId: null })}>
                    Projets
                  </button>
                )}
              </li>
              {nav.projectId && (
                <li>
                  <IconChevron size={13} />
                  {level === "project" ? (
                    <span aria-current="page" className="crumb-text" title={projectLabel(project, nav.projectId)}>
                      {projectLabel(project, nav.projectId)}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="crumb crumb-text"
                      title={projectLabel(project, nav.projectId)}
                      onClick={() => onNav({ projectId: nav.projectId, sessionId: null })}
                    >
                      {projectLabel(project, nav.projectId)}
                    </button>
                  )}
                </li>
              )}
              {nav.sessionId && (
                <li>
                  <IconChevron size={13} />
                  <span aria-current="page" className="crumb-text">
                    {sessionTitle ?? "Session"}
                  </span>
                </li>
              )}
            </ol>
          </nav>

          {level === "root" && (
            <ProjectList
              headingRef={headingRef}
              projects={projects}
              error={projectsError}
              onRetry={() => setProjectsKey((k) => k + 1)}
              onOpen={(id) => onNav({ projectId: id, sessionId: null })}
            />
          )}
          {level === "project" && nav.projectId && (
            <SessionList
              key={nav.projectId}
              headingRef={headingRef}
              projectId={nav.projectId}
              project={project}
              onOpen={(id) => onNav({ projectId: nav.projectId, sessionId: id })}
            />
          )}
          {level === "session" && nav.projectId && nav.sessionId && (
            <TranscriptView
              key={nav.sessionId}
              headingRef={headingRef}
              config={config}
              projectId={nav.projectId}
              sessionId={nav.sessionId}
              onTitle={setSessionTitle}
              onContinued={onContinued}
            />
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- Projets ----------

function ProjectList({
  headingRef,
  projects,
  error,
  onRetry,
  onOpen,
}: {
  headingRef: RefObject<HTMLHeadingElement>;
  projects: CcProject[] | null;
  error: string | null;
  onRetry(): void;
  onOpen(id: string): void;
}) {
  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="serif section-title">
        Projets
      </h2>
      <p className="muted small">
        Un projet correspond à un dossier dans lequel Claude Code a été lancé. Rien n'est modifié dans ces sessions.
      </p>
      {error && (
        <div className="notice notice-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={onRetry}>
            Réessayer
          </button>
        </div>
      )}
      {!error && !projects && (
        <p className="muted" role="status">
          Chargement des projets…
        </p>
      )}
      {projects && projects.length === 0 && (
        <p className="muted">Aucune session Claude Code n'a été trouvée sur ce PC.</p>
      )}
      {projects && projects.length > 0 && (
        <ul className="cc-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button type="button" className="cc-item" onClick={() => onOpen(p.id)}>
                <span className="cc-item-icon">
                  <IconFolder size={18} />
                </span>
                <span className="cc-item-main">
                  <span className={`cc-item-title ${p.path ? "mono" : "mono muted"}`}>{p.path ?? p.id}</span>
                  {!p.path && <span className="cc-item-note">Dossier d'origine inconnu (identifiant du projet)</span>}
                  <span className="cc-item-meta">
                    <span>{plural(p.sessionCount, "session", "sessions")}</span>
                    {p.lastActivity && <span aria-hidden="true">·</span>}
                    <DateText iso={p.lastActivity} prefix="dernière activité " />
                  </span>
                </span>
                <IconChevron size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- Sessions d'un projet ----------

function SessionList({
  headingRef,
  projectId,
  project,
  onOpen,
}: {
  headingRef: RefObject<HTMLHeadingElement>;
  projectId: string;
  project: CcProject | undefined;
  onOpen(id: string): void;
}) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<CcSessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const searchId = useId();

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listCcSessions(projectId, query || undefined)
      .then((s) => !cancelled && setSessions(s))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, query, reload]);

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="serif section-title">
        Sessions du projet
      </h2>
      <p className="path mono">{projectLabel(project, projectId)}</p>

      <form className="cc-search" role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor={searchId} className="sr-only">
          Rechercher dans les titres des sessions
        </label>
        <IconSearch size={16} />
        <input
          id={searchId}
          type="search"
          placeholder="Rechercher une session…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </form>

      {error && (
        <div className="notice notice-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={() => setReload((k) => k + 1)}>
            Réessayer
          </button>
        </div>
      )}
      {!error && !sessions && (
        <p className="muted" role="status">
          Chargement des sessions…
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {sessions ? plural(sessions.length, "session trouvée", "sessions trouvées") : ""}
      </p>
      {sessions && sessions.length === 0 && (
        <p className="muted">{query ? `Aucune session ne correspond à « ${query} ».` : "Aucune session dans ce projet."}</p>
      )}
      {sessions && sessions.length > 0 && (
        <ul className="cc-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <button type="button" className="cc-item" onClick={() => onOpen(s.id)}>
                <span className="cc-item-icon">
                  <IconChat size={18} />
                </span>
                <span className="cc-item-main">
                  <span className="cc-item-title">{s.title || "Sans titre"}</span>
                  <span className="cc-item-meta">
                    <SessionFacts s={s} />
                  </span>
                </span>
                <IconChevron size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionFacts({ s }: { s: CcSessionSummary }) {
  return (
    <>
      {s.fromMyClaude && <span className="badge badge-cc">créée par MyClaude</span>}
      <DateText iso={s.updatedAt ?? s.startedAt} prefix={s.updatedAt ? "modifiée " : "débutée "} />
      {s.startedAt && s.updatedAt && (
        <span className="cc-started">
          (débutée <time dateTime={s.startedAt} title={fullDate(s.startedAt)}>{relativeDate(s.startedAt)}</time>)
        </span>
      )}
      <span>{plural(s.messageCount, "message", "messages")}</span>
      {s.gitBranch && (
        <span className="cc-branch" title="Branche git">
          <IconBranch size={13} />
          <span className="sr-only">Branche git : </span>
          <span className="mono">{s.gitBranch}</span>
        </span>
      )}
    </>
  );
}

// ---------- Transcription ----------

function TranscriptView({
  headingRef,
  config,
  projectId,
  sessionId,
  onTitle,
  onContinued,
}: {
  headingRef: RefObject<HTMLHeadingElement>;
  config: AppConfig;
  projectId: string;
  sessionId: string;
  onTitle(t: string | null): void;
  onContinued(meta: SessionMeta): void;
}) {
  const [data, setData] = useState<CcTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const continueBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    onTitle(null);
    api
      .getCcTranscript(projectId, sessionId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        onTitle(d.session.title || "Sans titre");
      })
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, reload, onTitle]);

  const s = data?.session;

  return (
    <div>
      <div className="cc-session-head">
        <div className="cc-session-titles">
          <h2 ref={headingRef} tabIndex={-1} className="serif section-title">
            {s ? s.title || "Sans titre" : "Session"}
          </h2>
          {s && (
            <p className="cc-item-meta">
              <SessionFacts s={s} />
            </p>
          )}
          {s?.cwd && (
            <p className="cc-item-meta">
              <IconFolder size={13} />
              <span className="sr-only">Dossier d'origine : </span>
              <span className="mono dir-text">{s.cwd}</span>
            </p>
          )}
        </div>
        {s && (
          <button
            ref={continueBtn}
            type="button"
            className="btn btn-primary"
            onClick={() => setDialogOpen(true)}
            aria-haspopup="dialog"
          >
            Continuer dans MyClaude
          </button>
        )}
      </div>

      {error && (
        <div className="notice notice-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={() => setReload((k) => k + 1)}>
            Réessayer
          </button>
        </div>
      )}
      {!error && !data && (
        <p className="muted" role="status">
          Chargement de la transcription…
        </p>
      )}

      {data && (
        <>
          <p className="notice notice-info cc-readonly">
            Lecture seule : cette transcription appartient à Claude Code et n'est jamais modifiée.
          </p>
          {data.truncated && (
            <div className="notice notice-warn" role="note">
              <p>
                Transcription tronquée : la session est trop longue pour être affichée en entier ({data.messages.length}{" "}
                messages affichés sur {data.session.messageCount}).
              </p>
            </div>
          )}
          {data.messages.length === 0 ? (
            <p className="muted">Aucun message lisible dans cette session.</p>
          ) : (
            <ol className="messages cc-transcript" aria-label="Messages de la session Claude Code">
              {data.messages.map((m) => (
                <li key={m.id} className={`msg msg-${m.role}`}>
                  <MessageBody m={m} />
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {dialogOpen && s && (
        <ContinueDialog
          session={s}
          config={config}
          onClose={() => {
            setDialogOpen(false);
            continueBtn.current?.focus();
          }}
          onDone={(meta) => {
            setDialogOpen(false);
            onContinued(meta);
          }}
        />
      )}
    </div>
  );
}

// ---------- Dialogue « Continuer dans MyClaude » ----------

function ContinueDialog({
  session,
  config,
  onClose,
  onDone,
}: {
  session: CcSessionSummary;
  config: AppConfig;
  onClose(): void;
  onDone(meta: SessionMeta): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dir, setDir] = useState(session.cwd ?? config.workspaceDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ dir: string; reason: string } | null>(null);
  const titleId = useId();
  const descId = useId();
  const fieldId = useId();
  const hintId = useId();
  const errId = useId();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    inputRef.current?.focus();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = dir.trim();
    if (!isAbsolutePath(value)) {
      setError("Indiquez un chemin absolu (par exemple C:\\Users\\vous\\projets\\mon-projet).");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const meta = await api.continueCcSession(session.projectId, session.id, value);
      onDone(meta);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 400) {
        setRefused({ dir: value, reason: err.message });
        if (value !== config.workspaceDir) setDir(config.workspaceDir);
      } else {
        setError(errorMessage(err));
      }
      inputRef.current?.focus();
    }
  };

  const invalid = !!error;

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <h2 id={titleId} className="serif dialog-title">
          Continuer dans MyClaude
        </h2>
        <div id={descId} className="dialog-text">
          <p>
            La conversation « {session.title || "Sans titre"} » reprend <strong>avec son contexte</strong>, mais sous les{" "}
            <strong>règles, outils et validations de MyClaude</strong> : chaque action sensible vous sera demandée, et
            tout est journalisé.
          </p>
          <p>La session Claude Code d'origine n'est pas modifiée : MyClaude travaille sur une copie.</p>
        </div>

        <div className="field">
          <label htmlFor={fieldId}>Dossier de travail de cette session</label>
          <input
            ref={inputRef}
            id={fieldId}
            type="text"
            className="mono"
            spellCheck={false}
            autoComplete="off"
            value={dir}
            disabled={busy}
            onChange={(e) => {
              setDir(e.target.value);
              setError(null);
            }}
            aria-invalid={invalid || undefined}
            aria-describedby={`${hintId}${invalid ? ` ${errId}` : ""}`}
          />
          <p id={hintId} className="muted small">
            {session.cwd && dir.trim() === session.cwd
              ? "Pré-rempli avec le dossier d'origine de la session Claude Code. Claude ne pourra agir que dans ce dossier."
              : session.cwd
                ? `Dossier d'origine : ${session.cwd}. Claude ne pourra agir que dans le dossier indiqué ici.`
                : "Dossier d'origine inconnu : le dossier de travail global est proposé. Claude ne pourra agir que dans ce dossier."}
          </p>
        </div>

        {refused && (
          <div className="notice notice-error dialog-notice" role="alert">
            <div>
              <p>
                <strong>Dossier refusé</strong> ({refused.dir}) : {refused.reason}
              </p>
              {dir === config.workspaceDir && refused.dir !== config.workspaceDir && (
                <p className="small">Le dossier de travail global de MyClaude a été proposé à la place ; vous pouvez le modifier.</p>
              )}
            </div>
          </div>
        )}
        {error && (
          <p id={errId} className="error-text small" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => ref.current?.close()} disabled={busy}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !dir.trim()}>
            {busy ? "Création…" : "Continuer dans MyClaude"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
