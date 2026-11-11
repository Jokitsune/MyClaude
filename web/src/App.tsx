import { useCallback, useEffect, useState } from "react";
import { api, isMock } from "./api";
import { errorMessage } from "./errors";
import type { AppConfig, SessionMeta } from "./types";
import { applyTheme, loadTheme, saveTheme, type ThemePref } from "./util";
import { Sidebar, type View } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { LearningView } from "./components/LearningView";
import { SettingsView } from "./components/SettingsView";
import { GovernanceView } from "./components/GovernanceView";
import { CcView, type CcNav } from "./components/CcView";
import { IconMenu, Logo } from "./components/Icons";

const REFRESH_MS = 20_000;

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [pendingLessons, setPendingLessons] = useState(0);
  const [view, setView] = useState<View>("chat");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(loadTheme);
  const [ccNav, setCcNav] = useState<CcNav>({ projectId: null, sessionId: null });

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  const loadConfig = useCallback(() => {
    setConfigError(null);
    api
      .getConfig()
      .then(setConfig)
      .catch((e) => setConfigError(errorMessage(e)));
  }, []);

  const refreshSessions = useCallback(() => {
    api
      .listSessions()
      .then((s) => {
        setSessions(s);
        setSessionsError(null);
      })
      .catch((e) => setSessionsError(errorMessage(e)));
  }, []);

  const refreshLessons = useCallback(() => {
    api
      .listLessons("pending")
      .then((l) => setPendingLessons(l.length))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadConfig();
    refreshSessions();
    refreshLessons();
    const t = setInterval(() => {
      refreshSessions();
      refreshLessons();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [loadConfig, refreshSessions, refreshLessons]);

  // Fermer le menu mobile avec Échap.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSidebarOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  const goView = (v: View) => {
    setView(v);
    setSidebarOpen(false);
  };

  const onSessionCreated = useCallback((m: SessionMeta) => {
    setSessions((s) => [m, ...s.filter((x) => x.id !== m.id)]);
    setActiveId(m.id);
  }, []);

  const onCcContinued = useCallback(
    (m: SessionMeta) => {
      setSessions((s) => [m, ...s.filter((x) => x.id !== m.id)]);
      setActiveId(m.id);
      setView("chat");
      refreshSessions();
    },
    [refreshSessions],
  );

  const onSessionsChanged = useCallback(() => {
    refreshSessions();
    refreshLessons();
  }, [refreshSessions, refreshLessons]);

  const deleteSession = async (s: SessionMeta) => {
    if (!window.confirm(`Supprimer définitivement la session « ${s.title} » ?`)) return;
    try {
      await api.deleteSession(s.id);
      if (activeId === s.id) setActiveId(null);
      refreshSessions();
      refreshLessons();
    } catch (e) {
      window.alert(errorMessage(e));
    }
  };

  const cycleTheme = () => setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"));

  const menuButton = (
    <button
      type="button"
      className="icon-btn only-mobile"
      onClick={() => setSidebarOpen(true)}
      aria-label="Ouvrir le menu"
      aria-controls="sidebar"
      aria-expanded={sidebarOpen}
    >
      <IconMenu />
    </button>
  );

  if (!config) {
    return (
      <main className="splash">
        <Logo size={44} />
        {configError ? (
          <div className="splash-box" role="alert">
            <h1 className="serif">Serveur local injoignable</h1>
            <p className="muted">{configError} Vérifiez que MyClaude est bien démarré.</p>
            <button type="button" className="btn btn-primary" onClick={loadConfig}>
              Réessayer
            </button>
          </div>
        ) : (
          <p className="muted" role="status">
            Chargement…
          </p>
        )}
      </main>
    );
  }

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Aller au contenu
      </a>
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        sessions={sessions}
        sessionsError={sessionsError}
        activeId={activeId}
        view={view}
        pendingLessons={pendingLessons}
        theme={theme}
        onCycleTheme={cycleTheme}
        onNew={() => {
          setActiveId(null);
          goView("chat");
        }}
        onSelect={(id) => {
          setActiveId(id);
          goView("chat");
        }}
        onDelete={deleteSession}
        onView={goView}
      />
      <main id="main" className="main" tabIndex={-1}>
        {isMock && <div className="mock-flag">Mode maquette — données fictives</div>}
        {/* Reste monté hors de la vue Discussion pour ne pas couper une réponse en cours. */}
        <div className="view-slot" hidden={view !== "chat"}>
          <ChatView
            config={config}
            sessionId={activeId}
            menuButton={menuButton}
            onSessionCreated={onSessionCreated}
            onSessionsChanged={onSessionsChanged}
            onOpenSettings={() => goView("settings")}
            onRecheckEngine={loadConfig}
          />
        </div>
        {view === "claude-code" && (
          <CcView config={config} menuButton={menuButton} nav={ccNav} onNav={setCcNav} onContinued={onCcContinued} />
        )}
        {view === "learning" && <LearningView menuButton={menuButton} onLessonsChanged={refreshLessons} />}
        {view === "governance" && <GovernanceView menuButton={menuButton} />}
        {view === "settings" && (
          <SettingsView
            config={config}
            menuButton={menuButton}
            onConfig={setConfig}
            theme={theme}
            onTheme={setTheme}
          />
        )}
      </main>
    </div>
  );
}
