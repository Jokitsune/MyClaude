import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { errorMessage } from "../errors";
import type { Governance, GovernanceUpdate } from "../types";
import { DEFAULT_TOOLS, TOOL_DESCRIPTION, sensitivity } from "../tools";
import { ToolIcon } from "./ToolActivity";

interface Props {
  menuButton: ReactNode;
}

const pretty = (v: unknown) => JSON.stringify(v ?? {}, null, 2);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Validation côté client : syntaxe JSON + forme générale. Renvoie un message d'erreur ou null. */
function validateJson(text: string, kind: "mcp" | "agents"): string | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    const detail = e instanceof SyntaxError ? e.message : "";
    return `JSON invalide${detail ? ` : ${detail}` : "."}`;
  }
  if (!isObject(v)) return "Le contenu doit être un objet JSON ({ … }).";
  if (kind === "mcp") {
    if (!("mcpServers" in v)) return "Il manque la clé « mcpServers » (même format que Claude Code).";
    if (!isObject(v.mcpServers)) return "« mcpServers » doit être un objet { nom: configuration }.";
    for (const [name, conf] of Object.entries(v.mcpServers)) {
      if (!isObject(conf)) return `Le serveur « ${name} » doit être un objet.`;
    }
  } else {
    for (const [name, conf] of Object.entries(v)) {
      if (!isObject(conf)) return `L'agent « ${name} » doit être un objet { description, prompt, … }.`;
    }
  }
  return null;
}

function JsonField({
  id,
  label,
  help,
  value,
  error,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  help: ReactNode;
  value: string;
  error: string | null;
  onChange(v: string): void;
  disabled: boolean;
}) {
  const errId = `${id}-error`;
  const helpId = `${id}-help`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <p id={helpId} className="muted small">
        {help}
      </p>
      <textarea
        id={id}
        className={`mono json-editor ${error ? "is-invalid" : ""}`}
        rows={10}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${helpId} ${errId}` : helpId}
      />
      {error ? (
        <p id={errId} className="error-text small" role="alert">
          {error}
        </p>
      ) : (
        <p className="ok-text small">JSON valide.</p>
      )}
    </div>
  );
}

export function GovernanceView({ menuButton }: Props) {
  const [saved, setSaved] = useState<Governance | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [system, setSystem] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [extras, setExtras] = useState<string[]>([]);
  const [newTool, setNewTool] = useState("");
  const [newToolError, setNewToolError] = useState<string | null>(null);
  const [mcpText, setMcpText] = useState("");
  const [agentsText, setAgentsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const newToolId = useId();

  const apply = useCallback((g: Governance) => {
    setSaved(g);
    setSystem(g.system ?? "");
    const list = Array.isArray(g.tools?.allowed) ? g.tools.allowed : [];
    setAllowed(list);
    setExtras((cur) => [...new Set([...cur, ...list.filter((t) => !(DEFAULT_TOOLS as readonly string[]).includes(t))])]);
    setMcpText(pretty(g.mcp ?? { mcpServers: {} }));
    setAgentsText(pretty(g.agents ?? {}));
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .getGovernance()
      .then(apply)
      .catch((e) => setLoadError(errorMessage(e)));
  }, [apply]);

  useEffect(load, [load]);

  const mcpError = validateJson(mcpText, "mcp");
  const agentsError = validateJson(agentsText, "agents");

  const dirty = {
    system: !!saved && system !== saved.system,
    tools: !!saved && allowed.join("\n") !== (saved.tools?.allowed ?? []).join("\n"),
    mcp: !!saved && mcpText !== pretty(saved.mcp ?? { mcpServers: {} }),
    agents: !!saved && agentsText !== pretty(saved.agents ?? {}),
  };
  const anyDirty = dirty.system || dirty.tools || dirty.mcp || dirty.agents;
  const blocked = (dirty.mcp && !!mcpError) || (dirty.agents && !!agentsError);

  const toggle = (tool: string, on: boolean) =>
    setAllowed((cur) => (on ? (cur.includes(tool) ? cur : [...cur, tool]) : cur.filter((t) => t !== tool)));

  const addTool = (e: FormEvent) => {
    e.preventDefault();
    const t = newTool.trim();
    if (!t) return;
    if (!/^[A-Za-z0-9_*.:()\-\s]+$/.test(t)) {
      setNewToolError("Nom d'outil invalide (lettres, chiffres, _, -, *, et éventuellement un motif entre parenthèses).");
      return;
    }
    if (!(DEFAULT_TOOLS as readonly string[]).includes(t)) setExtras((cur) => (cur.includes(t) ? cur : [...cur, t]));
    toggle(t, true);
    setNewTool("");
    setNewToolError(null);
  };

  const save = async () => {
    if (!saved || blocked) return;
    const u: GovernanceUpdate = {};
    if (dirty.system) u.system = system;
    if (dirty.tools) u.tools = { allowed };
    if (dirty.mcp) u.mcp = JSON.parse(mcpText) as Governance["mcp"];
    if (dirty.agents) u.agents = JSON.parse(agentsText) as Governance["agents"];
    setBusy(true);
    setMsg(null);
    try {
      apply(await api.putGovernance(u));
      setMsg({ ok: true, text: "Gouvernance enregistrée. Elle s'applique aux prochains messages." });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    if (saved) {
      apply(saved);
      setMsg(null);
    }
  };

  const loading = !saved && !loadError;
  const toolRows = [...DEFAULT_TOOLS, ...extras.filter((t) => !(DEFAULT_TOOLS as readonly string[]).includes(t))];

  return (
    <section className="view" aria-label="Gouvernance">
      <header className="view-header">
        {menuButton}
        <div className="header-titles">
          <h1 className="header-title">Gouvernance</h1>
          <p className="header-sub">Ce qui définit le comportement de Claude dans MyClaude — stocké sur ce PC.</p>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-column">
          {loadError && (
            <div className="notice notice-error" role="alert">
              <p>{loadError}</p>
              <button type="button" className="btn" onClick={load}>
                Réessayer
              </button>
            </div>
          )}
          {loading && <p className="muted">Chargement…</p>}

          {saved && (
            <>
              <section className="panel" aria-labelledby="sys-title">
                <h2 id="sys-title" className="serif section-title">
                  Consignes de base {dirty.system && <span className="dirty-dot" title="Modifié" aria-label="modifié" />}
                </h2>
                <div className="field">
                  <label htmlFor="gov-system">
                    <code>system.md</code>
                  </label>
                  <p className="muted small" id="gov-system-help">
                    Prompt système de MyClaude, complété par la mémoire. Aucun CLAUDE.md ni réglage externe n'est chargé.
                  </p>
                  <textarea
                    id="gov-system"
                    className="mono memory-editor"
                    rows={12}
                    value={system}
                    disabled={busy}
                    spellCheck={false}
                    aria-describedby="gov-system-help"
                    onChange={(e) => setSystem(e.target.value)}
                  />
                </div>
              </section>

              <section className="panel" aria-labelledby="tools-title">
                <h2 id="tools-title" className="serif section-title">
                  Outils autorisés {dirty.tools && <span className="dirty-dot" title="Modifié" aria-label="modifié" />}
                </h2>
                <p className="muted small">
                  <code>tools.json</code> — un outil décoché n'est jamais proposé à Claude. Les outils marqués « validation »
                  demandent votre accord à chaque utilisation (sauf « Toujours pour cette session »).
                </p>
                <fieldset className="tool-checks" disabled={busy}>
                  <legend className="sr-only">Outils autorisés</legend>
                  {toolRows.map((t) => {
                    const id = `tool-${t.replace(/[^A-Za-z0-9_-]/g, "_")}`;
                    const sens = sensitivity(t);
                    return (
                      <label key={t} htmlFor={id} className="tool-check">
                        <input id={id} type="checkbox" checked={allowed.includes(t)} onChange={(e) => toggle(t, e.target.checked)} />
                        <span className="tool-icon">
                          <ToolIcon name={t} />
                        </span>
                        <span className="tool-check-text">
                          <code>{t}</code>
                          <span className="muted small">{TOOL_DESCRIPTION[t] ?? "Outil personnalisé"}</span>
                        </span>
                        {sens !== "safe" && (
                          <span className={`tool-chip chip-${sens === "danger" ? "danger" : "sensitive"}`}>validation</span>
                        )}
                      </label>
                    );
                  })}
                </fieldset>
                <form className="key-form add-tool" onSubmit={addTool}>
                  <div className="field grow">
                    <label htmlFor={newToolId}>Ajouter un outil</label>
                    <input
                      id={newToolId}
                      type="text"
                      className="mono"
                      value={newTool}
                      placeholder="ex. Task, mcp__github__*"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => {
                        setNewTool(e.target.value);
                        setNewToolError(null);
                      }}
                      aria-invalid={!!newToolError}
                      aria-describedby={newToolError ? `${newToolId}-err` : undefined}
                    />
                  </div>
                  <div className="key-actions">
                    <button type="submit" className="btn" disabled={busy || !newTool.trim()}>
                      Ajouter
                    </button>
                  </div>
                </form>
                {newToolError && (
                  <p id={`${newToolId}-err`} className="error-text small" role="alert">
                    {newToolError}
                  </p>
                )}
              </section>

              <section className="panel" aria-labelledby="mcp-title">
                <h2 id="mcp-title" className="serif section-title">
                  Serveurs MCP {dirty.mcp && <span className="dirty-dot" title="Modifié" aria-label="modifié" />}
                </h2>
                <JsonField
                  id="gov-mcp"
                  label="mcp.json"
                  help={
                    <>
                      Même format que Claude Code : <code>{'{ "mcpServers": { "nom": { "command": "…", "args": [] } } }'}</code>.
                      Seuls ces serveurs sont chargés.
                    </>
                  }
                  value={mcpText}
                  error={mcpError}
                  onChange={setMcpText}
                  disabled={busy}
                />
              </section>

              <section className="panel" aria-labelledby="agents-title">
                <h2 id="agents-title" className="serif section-title">
                  Sous-agents {dirty.agents && <span className="dirty-dot" title="Modifié" aria-label="modifié" />}
                </h2>
                <JsonField
                  id="gov-agents"
                  label="agents.json"
                  help={
                    <>
                      <code>{'{ "nom": { "description": "…", "prompt": "…", "tools": [], "model": "sonnet" } }'}</code>.
                      Si au moins un agent est défini, Claude peut lui déléguer des tâches (avec votre validation).
                    </>
                  }
                  value={agentsText}
                  error={agentsError}
                  onChange={setAgentsText}
                  disabled={busy}
                />
              </section>

              <div className="save-bar">
                <div role="status" aria-live="polite" className="save-msg">
                  {msg && (!msg.ok || !anyDirty) ? (
                    <span className={msg.ok ? "ok-text" : "error-text"}>{msg.text}</span>
                  ) : blocked ? (
                    <span className="error-text">Corrigez le JSON avant d'enregistrer.</span>
                  ) : anyDirty ? (
                    <span className="muted">Modifications non enregistrées</span>
                  ) : null}
                </div>
                {anyDirty && (
                  <button type="button" className="btn btn-ghost" onClick={reset} disabled={busy}>
                    Annuler
                  </button>
                )}
                <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !anyDirty || blocked}>
                  {busy ? "Enregistrement…" : "Enregistrer"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
