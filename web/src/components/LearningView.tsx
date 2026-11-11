import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { Lesson } from "../types";
import { fullDate, relativeDate } from "../util";

const KIND_LABEL: Record<Lesson["kind"], string> = {
  preference: "Préférence",
  mistake: "Erreur à éviter",
  success: "Bonne pratique",
  fact: "Fait",
};

interface Props {
  menuButton: ReactNode;
  onLessonsChanged(): void;
}

function LessonCard({ lesson, onDone }: { lesson: Lesson; onDone(updated: Lesson): void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(lesson.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = `lesson-edit-${lesson.id}`;

  const act = async (fn: () => Promise<Lesson>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <article className="card lesson-card" aria-labelledby={`lesson-${lesson.id}`}>
      <div className="lesson-head">
        <span className={`kind kind-${lesson.kind}`}>{KIND_LABEL[lesson.kind]}</span>
        <time className="muted small" dateTime={lesson.createdAt} title={fullDate(lesson.createdAt)}>
          {relativeDate(lesson.createdAt)}
        </time>
      </div>
      {editing ? (
        <div className="field">
          <label htmlFor={fieldId} className="sr-only">
            Texte de la leçon
          </label>
          <textarea id={fieldId} rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </div>
      ) : (
        <p className="lesson-text" id={`lesson-${lesson.id}`}>
          {lesson.text}
        </p>
      )}
      {lesson.rationale && <p className="muted small">Pourquoi : {lesson.rationale}</p>}
      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}
      <div className="card-actions">
        {editing ? (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !text.trim()}
              onClick={() => act(() => api.approveLesson(lesson.id, text.trim()))}
            >
              Enregistrer et approuver
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setText(lesson.text);
              }}
            >
              Annuler
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(() => api.approveLesson(lesson.id))}>
              Approuver
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
              Modifier
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act(() => api.rejectLesson(lesson.id))}>
              Rejeter
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function MemoryEditor({ refreshKey }: { refreshKey: number }) {
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = content !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    let cancelled = false;
    api
      .getMemory()
      .then((r) => {
        if (cancelled) return;
        setSaved(r.content);
        // N'écrase pas une saisie en cours.
        setContent((cur) => (dirtyRef.current ? cur : r.content));
      })
      .catch((e) => !cancelled && setMsg({ ok: false, text: errorMessage(e) }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.putMemory(content);
      setSaved(r.content);
      setContent(r.content);
      setMsg({ ok: true, text: "Mémoire enregistrée." });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="memory-title">
      <h2 id="memory-title" className="serif section-title">
        Mémoire
      </h2>
      <p className="muted">
        Contenu de <code>memory.md</code>, ajouté aux consignes de Claude à chaque échange. Les leçons approuvées y sont
        ajoutées automatiquement.
      </p>
      <div className="field">
        <label htmlFor="memory-editor" className="sr-only">
          Contenu de la mémoire
        </label>
        <textarea
          id="memory-editor"
          className="mono memory-editor"
          rows={14}
          value={content}
          disabled={loading}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="card-actions">
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || loading || !dirty}>
          {busy ? "Enregistrement…" : "Enregistrer"}
        </button>
        {dirty && (
          <button type="button" className="btn btn-ghost" onClick={() => setContent(saved)} disabled={busy}>
            Annuler les modifications
          </button>
        )}
        <span role="status" className={`small ${msg?.ok === false ? "error-text" : "muted"}`}>
          {msg?.text ?? (dirty ? "Modifications non enregistrées" : "")}
        </span>
      </div>
    </section>
  );
}

export function LearningView({ menuButton, onLessonsChanged }: Props) {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memoryKey, setMemoryKey] = useState(0);

  const load = useCallback(() => {
    setError(null);
    api
      .listLessons()
      .then(setLessons)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);

  const onDone = (updated: Lesson) => {
    setLessons((ls) => (ls ? ls.map((l) => (l.id === updated.id ? updated : l)) : ls));
    if (updated.status === "approved") setMemoryKey((k) => k + 1);
    onLessonsChanged();
  };

  const pending = (lessons ?? []).filter((l) => l.status === "pending");
  const history = (lessons ?? [])
    .filter((l) => l.status !== "pending")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <section className="view" aria-label="Apprentissage">
      <header className="view-header">
        {menuButton}
        <div className="header-titles">
          <h1 className="header-title">Apprentissage</h1>
          <p className="header-sub">Leçons proposées à la fin des sessions — rien n'entre en mémoire sans votre accord.</p>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-column">
          <section className="panel" aria-labelledby="pending-title">
            <h2 id="pending-title" className="serif section-title">
              En attente {pending.length > 0 && <span className="count">{pending.length}</span>}
            </h2>
            {error && (
              <div className="notice notice-error" role="alert">
                <p>{error}</p>
                <button type="button" className="btn" onClick={load}>
                  Réessayer
                </button>
              </div>
            )}
            {!lessons && !error && <p className="muted">Chargement…</p>}
            {lessons && pending.length === 0 && (
              <p className="muted">Aucune leçon en attente. Elles apparaîtront ici après la clôture d'une session.</p>
            )}
            <div className="lesson-grid">
              {pending.map((l) => (
                <LessonCard key={l.id} lesson={l} onDone={onDone} />
              ))}
            </div>
          </section>

          <MemoryEditor refreshKey={memoryKey} />

          <section className="panel" aria-labelledby="history-title">
            <h2 id="history-title" className="serif section-title">
              Historique
            </h2>
            {lessons && history.length === 0 && <p className="muted">Aucune leçon traitée pour l'instant.</p>}
            <ul className="history">
              {history.map((l) => (
                <li key={l.id} className="history-item">
                  <span className={`badge badge-${l.status}`}>{l.status === "approved" ? "approuvée" : "rejetée"}</span>
                  <span className="history-text">{l.text}</span>
                  <span className="muted small">{KIND_LABEL[l.kind]}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}
