import type { SessionMeta } from "../types";
import { REVIEW_LABEL, STATUS_LABEL, fullDate, relativeDate, type ThemePref } from "../util";
import {
  IconBook,
  IconClose,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconSettings,
  IconShield,
  IconSun,
  IconTrash,
  Logo,
} from "./Icons";

export type View = "chat" | "learning" | "governance" | "settings";

interface Props {
  open: boolean;
  onClose(): void;
  sessions: SessionMeta[];
  sessionsError: string | null;
  activeId: string | null;
  view: View;
  pendingLessons: number;
  theme: ThemePref;
  onCycleTheme(): void;
  onNew(): void;
  onSelect(id: string): void;
  onDelete(s: SessionMeta): void;
  onView(v: View): void;
}

const THEME_NEXT_LABEL: Record<ThemePref, string> = {
  system: "Thème : système",
  light: "Thème : clair",
  dark: "Thème : sombre",
};

export function Sidebar(p: Props) {
  return (
    <>
      <div className={`backdrop ${p.open ? "show" : ""}`} onClick={p.onClose} aria-hidden="true" />
      <aside id="sidebar" className={`sidebar ${p.open ? "open" : ""}`} aria-label="Navigation">
        <div className="sidebar-top">
          <div className="brand">
            <Logo />
            <span className="brand-name">MyClaude</span>
          </div>
          <button type="button" className="icon-btn only-mobile" onClick={p.onClose} aria-label="Fermer le menu">
            <IconClose />
          </button>
        </div>

        <button type="button" className="new-btn" onClick={p.onNew}>
          <span className="new-btn-icon"><IconPlus size={16} /></span>
          Nouvelle session
        </button>

        <nav className="session-nav" aria-label="Sessions">
          <h2 className="side-heading">Récentes</h2>
          {p.sessionsError && <p className="side-note error-text">{p.sessionsError}</p>}
          {!p.sessionsError && p.sessions.length === 0 && (
            <p className="side-note">Aucune session pour l'instant.</p>
          )}
          <ul className="session-list">
            {p.sessions.map((s) => {
              const active = p.view === "chat" && s.id === p.activeId;
              return (
                <li key={s.id} className={`session-item ${active ? "active" : ""}`}>
                  <button
                    type="button"
                    className="session-link"
                    onClick={() => p.onSelect(s.id)}
                    aria-current={active ? "page" : undefined}
                    title={s.title}
                  >
                    <span className="session-title">{s.title || "Sans titre"}</span>
                    <span className="session-meta">
                      <time dateTime={s.updatedAt} title={fullDate(s.updatedAt)}>
                        {relativeDate(s.updatedAt)}
                      </time>
                      <span className={`badge badge-${s.status}`}>{STATUS_LABEL[s.status]}</span>
                      {s.status !== "open" && (
                        <span
                          className={`review-dot review-${s.review}`}
                          title={s.reviewError ? `${REVIEW_LABEL[s.review]} : ${s.reviewError}` : REVIEW_LABEL[s.review]}
                          role="img"
                          aria-label={REVIEW_LABEL[s.review]}
                        />
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn session-delete"
                    onClick={() => p.onDelete(s)}
                    aria-label={`Supprimer la session « ${s.title} »`}
                    title="Supprimer"
                  >
                    <IconTrash size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="sidebar-bottom">
          <button
            type="button"
            className={`side-link ${p.view === "learning" ? "active" : ""}`}
            onClick={() => p.onView("learning")}
            aria-current={p.view === "learning" ? "page" : undefined}
          >
            <IconBook size={17} />
            <span>Apprentissage</span>
            {p.pendingLessons > 0 && (
              <span className="count" aria-label={`${p.pendingLessons} leçon(s) en attente`}>
                {p.pendingLessons}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`side-link ${p.view === "governance" ? "active" : ""}`}
            onClick={() => p.onView("governance")}
            aria-current={p.view === "governance" ? "page" : undefined}
          >
            <IconShield size={17} />
            <span>Gouvernance</span>
          </button>
          <button
            type="button"
            className={`side-link ${p.view === "settings" ? "active" : ""}`}
            onClick={() => p.onView("settings")}
            aria-current={p.view === "settings" ? "page" : undefined}
          >
            <IconSettings size={17} />
            <span>Réglages</span>
          </button>
          <button
            type="button"
            className="side-link"
            onClick={p.onCycleTheme}
            aria-label={`${THEME_NEXT_LABEL[p.theme]}. Cliquer pour changer.`}
          >
            {p.theme === "light" ? <IconSun size={17} /> : p.theme === "dark" ? <IconMoon size={17} /> : <IconMonitor size={17} />}
            <span>{THEME_NEXT_LABEL[p.theme]}</span>
          </button>
        </div>
      </aside>
    </>
  );
}
