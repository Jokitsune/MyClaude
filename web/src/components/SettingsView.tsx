import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { AppConfig, AuthMode, ConfigUpdate, Effort } from "../types";
import { EFFORT_LABEL, engineReady, type ThemePref } from "../util";
import { IconRetry } from "./Icons";

interface Props {
  config: AppConfig;
  menuButton: ReactNode;
  onConfig(c: AppConfig): void;
  theme: ThemePref;
  onTheme(t: ThemePref): void;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Chemin absolu Windows (`C:\…`, `\\serveur\…`) ou POSIX (`/…`). */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p) || p.startsWith("/");
}

function EngineStatus({ config, checking, onRecheck }: { config: AppConfig; checking: boolean; onRecheck(): void }) {
  const ready = engineReady(config);
  const subscription = config.authMode !== "apiKey";
  const acc = config.account;
  return (
    <div className={`engine-status ${ready ? "is-ready" : "is-off"}`} aria-live="polite">
      <div className="engine-status-head">
        <span className={`badge ${ready ? "badge-approved" : "badge-interrupted"}`}>
          {ready ? "moteur prêt" : "moteur indisponible"}
        </span>
        <button type="button" className="btn btn-small btn-ghost" onClick={onRecheck} disabled={checking}>
          <IconRetry size={14} /> {checking ? "Vérification…" : "Revérifier"}
        </button>
      </div>
      {subscription && acc && (acc.email || acc.organization || acc.subscription) && (
        <dl className="account">
          {acc.email && (
            <div>
              <dt>Compte</dt>
              <dd>{acc.email}</dd>
            </div>
          )}
          {acc.organization && (
            <div>
              <dt>Organisation</dt>
              <dd>{acc.organization}</dd>
            </div>
          )}
          {acc.subscription && (
            <div>
              <dt>Abonnement</dt>
              <dd>{acc.subscription}</dd>
            </div>
          )}
        </dl>
      )}
      {subscription && ready && !acc && <p className="muted small">Compte Claude Code connecté (détails non exposés).</p>}
      {!ready && (
        <>
          {config.engineError && <p className="engine-error small">{config.engineError}</p>}
          {subscription ? (
            <p className="small">
              Ouvre un terminal, lance <code>claude</code> puis <code>/login</code>
            </p>
          ) : (
            !config.hasApiKey && <p className="small">Enregistrez une clé API ci-dessous.</p>
          )}
        </>
      )}
    </div>
  );
}

export function SettingsView({ config, menuButton, onConfig, theme, onTheme }: Props) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [workspace, setWorkspace] = useState(config.workspaceDir ?? "");
  const [wsError, setWsError] = useState<string | null>(null);

  useEffect(() => setWorkspace(config.workspaceDir ?? ""), [config.workspaceDir]);

  const update = async (u: ConfigUpdate, okText: string) => {
    setBusy(true);
    setMsg(null);
    try {
      onConfig(await api.putConfig(u));
      setMsg({ ok: true, text: okText });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setChecking(true);
    try {
      onConfig(await api.getConfig());
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setChecking(false);
    }
  };

  const saveKey = async (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    if (await update({ apiKey: k }, "Clé API enregistrée.")) setKey("");
  };

  const deleteKey = () => {
    if (!window.confirm("Supprimer la clé API enregistrée ? En mode Clé API, vous ne pourrez plus discuter tant qu'une nouvelle clé n'est pas ajoutée.")) return;
    void update({ apiKey: null }, "Clé API supprimée.");
  };

  const setMode = (m: AuthMode) => {
    if (m === config.authMode) return;
    void update({ authMode: m }, m === "subscription" ? "Moteur : abonnement (Claude Code)." : "Moteur : clé API.");
  };

  const saveWorkspace = async (e: FormEvent) => {
    e.preventDefault();
    const w = workspace.trim();
    if (!isAbsolutePath(w)) {
      setWsError("Indiquez un chemin absolu, par exemple C:\\Users\\vous\\MyClaude-workspace.");
      return;
    }
    setWsError(null);
    await update({ workspaceDir: w }, "Dossier de travail mis à jour.");
  };

  const models = config.availableModels.some((m) => m.id === config.model)
    ? config.availableModels
    : [...config.availableModels, { id: config.model, label: config.model }];

  const mode: AuthMode = config.authMode === "apiKey" ? "apiKey" : "subscription";
  const wsDirty = workspace.trim() !== (config.workspaceDir ?? "");

  return (
    <section className="view" aria-label="Réglages">
      <header className="view-header">
        {menuButton}
        <div className="header-titles">
          <h1 className="header-title">Réglages</h1>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-column">
          <div className="sr-only" role="status" aria-live="polite">
            {msg?.text ?? ""}
          </div>
          {msg && (
            <div className={`notice ${msg.ok ? "notice-ok" : "notice-error"}`} aria-hidden="true">
              <p>{msg.text}</p>
            </div>
          )}

          <section className="panel" aria-labelledby="engine-title">
            <h2 id="engine-title" className="serif section-title">
              Moteur
            </h2>
            <p className="notice notice-info">
              Usage personnel : MyClaude utilise l'abonnement du compte connecté comme moteur, mais tes sessions, ta
              mémoire, tes outils et tes règles restent dans MyClaude, sur ce PC.
            </p>
            <fieldset className="radio-group" disabled={busy}>
              <legend className="sr-only">Moteur utilisé</legend>
              <label className={`radio-card ${mode === "subscription" ? "checked" : ""}`}>
                <input
                  type="radio"
                  name="auth-mode"
                  value="subscription"
                  checked={mode === "subscription"}
                  onChange={() => setMode("subscription")}
                />
                <span>
                  <span className="radio-title">
                    Abonnement (Claude Code) <span className="muted small">— par défaut</span>
                  </span>
                  <span className="muted small radio-desc">
                    Utilise le compte connecté à Claude Code sur ce PC. Aucune clé à saisir.
                  </span>
                </span>
              </label>
              <label className={`radio-card ${mode === "apiKey" ? "checked" : ""}`}>
                <input type="radio" name="auth-mode" value="apiKey" checked={mode === "apiKey"} onChange={() => setMode("apiKey")} />
                <span>
                  <span className="radio-title">Clé API</span>
                  <span className="muted small radio-desc">Utilise une clé API Anthropic propre à MyClaude (facturée à l'usage).</span>
                </span>
              </label>
            </fieldset>

            <EngineStatus config={config} checking={checking} onRecheck={recheck} />

            {mode === "apiKey" && (
              <div className="subpanel">
                <h3 className="sub-title">Clé API Anthropic</h3>
                <p className="muted small">
                  Stockée dans le dossier de données local, transmise uniquement au moteur et jamais renvoyée à l'interface.{" "}
                  {config.hasApiKey ? (
                    <span className="badge badge-approved">clé enregistrée</span>
                  ) : (
                    <span className="badge badge-interrupted">aucune clé</span>
                  )}
                </p>
                <form className="key-form" onSubmit={saveKey}>
                  <div className="field grow">
                    <label htmlFor="api-key">{config.hasApiKey ? "Remplacer la clé" : "Nouvelle clé"}</label>
                    <input
                      id="api-key"
                      type="password"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      placeholder="sk-ant-…"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="key-actions">
                    <button type="submit" className="btn btn-primary" disabled={busy || !key.trim()}>
                      Enregistrer
                    </button>
                    {config.hasApiKey && (
                      <button type="button" className="btn btn-danger" onClick={deleteKey} disabled={busy}>
                        Supprimer la clé
                      </button>
                    )}
                  </div>
                </form>
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="workspace-title">
            <h2 id="workspace-title" className="serif section-title">
              Dossier de travail
            </h2>
            <p className="muted">
              Claude ne peut lire et modifier des fichiers <strong>que dans ce dossier</strong> : tout accès en dehors est
              refusé automatiquement. Les commandes s'y exécutent aussi.
            </p>
            <form className="key-form" onSubmit={saveWorkspace} noValidate>
              <div className="field grow">
                <label htmlFor="workspace">Chemin absolu</label>
                <input
                  id="workspace"
                  type="text"
                  className="mono"
                  value={workspace}
                  onChange={(e) => {
                    setWorkspace(e.target.value);
                    setWsError(null);
                  }}
                  placeholder="C:\Users\vous\MyClaude-workspace"
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!!wsError}
                  aria-describedby={wsError ? "workspace-error" : undefined}
                />
              </div>
              <div className="key-actions">
                <button type="submit" className="btn btn-primary" disabled={busy || !wsDirty || !workspace.trim()}>
                  Enregistrer
                </button>
              </div>
            </form>
            {wsError && (
              <p id="workspace-error" className="error-text small" role="alert">
                {wsError}
              </p>
            )}
          </section>

          <section className="panel" aria-labelledby="model-title">
            <h2 id="model-title" className="serif section-title">
              Modèle
            </h2>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="model">Modèle par défaut</label>
                <select
                  id="model"
                  value={config.model}
                  disabled={busy}
                  onChange={(e) => update({ model: e.target.value }, "Modèle mis à jour.")}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p className="muted small">S'applique aux nouvelles sessions.</p>
              </div>
              <div className="field">
                <label htmlFor="effort">Effort de réflexion</label>
                <select
                  id="effort"
                  value={config.effort}
                  disabled={busy}
                  onChange={(e) => update({ effort: e.target.value as Effort }, "Effort mis à jour.")}
                >
                  {EFFORTS.map((x) => (
                    <option key={x} value={x}>
                      {EFFORT_LABEL[x]}
                    </option>
                  ))}
                </select>
                <p className="muted small">Plus d'effort : réponses plus réfléchies, mais plus lentes.</p>
              </div>
            </div>
          </section>

          <section className="panel" aria-labelledby="theme-title">
            <h2 id="theme-title" className="serif section-title">
              Apparence
            </h2>
            <div className="field">
              <label htmlFor="theme">Thème</label>
              <select id="theme" value={theme} onChange={(e) => onTheme(e.target.value as ThemePref)}>
                <option value="system">Système</option>
                <option value="light">Clair</option>
                <option value="dark">Sombre</option>
              </select>
            </div>
          </section>

          <section className="panel" aria-labelledby="privacy-title">
            <h2 id="privacy-title" className="serif section-title">
              Confidentialité
            </h2>
            <p>
              Vos conversations, la mémoire, les règles de gouvernance et les réglages restent sur cette machine. Seuls les
              échanges avec le modèle sortent, via Claude Code ou l'API Anthropic, sans aucune télémétrie de MyClaude.
            </p>
            <div className="field">
              <span className="label">Dossier de données</span>
              <code className="path">{config.dataDir}</code>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
