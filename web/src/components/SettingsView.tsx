import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { AppConfig, ConfigUpdate, Effort } from "../types";
import { EFFORT_LABEL, type ThemePref } from "../util";

interface Props {
  config: AppConfig;
  menuButton: ReactNode;
  onConfig(c: AppConfig): void;
  theme: ThemePref;
  onTheme(t: ThemePref): void;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function SettingsView({ config, menuButton, onConfig, theme, onTheme }: Props) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  const saveKey = async (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    if (await update({ apiKey: k }, "Clé API enregistrée.")) setKey("");
  };

  const deleteKey = () => {
    if (!window.confirm("Supprimer la clé API enregistrée ? Vous ne pourrez plus discuter tant qu'une nouvelle clé n'est pas ajoutée.")) return;
    void update({ apiKey: null }, "Clé API supprimée.");
  };

  const models = config.availableModels.some((m) => m.id === config.model)
    ? config.availableModels
    : [...config.availableModels, { id: config.model, label: config.model }];

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

          <section className="panel" aria-labelledby="key-title">
            <h2 id="key-title" className="serif section-title">
              Clé API Anthropic
            </h2>
            <p className="muted">
              Clé personnelle propre à MyClaude, indépendante de tout compte connecté ailleurs. Elle est stockée dans le
              dossier de données local et n'est jamais renvoyée à l'interface.
            </p>
            <p className="key-state">
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
                <p className="muted small">Plus d'effort : réponses plus réfléchies, mais plus lentes et coûteuses.</p>
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
              Vos conversations, la mémoire et les réglages restent sur cette machine. Seuls les appels au modèle sortent,
              directement vers <code>api.anthropic.com</code>, sans aucune télémétrie.
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
