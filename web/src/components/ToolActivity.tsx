import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PermissionDecision, PermissionRequest, ToolCall } from "../types";
import {
  STATUS_LABEL,
  formatInput,
  permissionPreview,
  sensitivity,
  toolKind,
  toolSummary,
  truncate,
  type ToolKind,
} from "../tools";
import {
  IconAgent,
  IconFile,
  IconGlobe,
  IconList,
  IconPencil,
  IconPlug,
  IconSearch,
  IconShield,
  IconTerminal,
  IconTool,
  IconWarning,
} from "./Icons";

const KIND_ICON: Record<ToolKind, (p: { size?: number }) => ReactNode> = {
  read: IconFile,
  write: IconPencil,
  bash: IconTerminal,
  search: IconSearch,
  web: IconGlobe,
  todo: IconList,
  agent: IconAgent,
  mcp: IconPlug,
  other: IconTool,
};

const KIND_TAG: Record<ToolKind, string> = {
  read: "Lecture",
  write: "Écriture de fichier",
  bash: "Commande système",
  search: "Recherche",
  web: "Accès web",
  todo: "Tâches",
  agent: "Sous-agent",
  mcp: "Serveur MCP",
  other: "Outil",
};

export function ToolIcon({ name, size = 15 }: { name: string; size?: number }) {
  const Icon = KIND_ICON[toolKind(name)];
  return <Icon size={size} />;
}

function Summary({ name, input }: { name: string; input: unknown }) {
  const s = toolSummary(name, input);
  return (
    <span className="tool-summary">
      {s.verb}
      {s.target && (
        <>
          {" "}
          <code>{s.target}</code>
        </>
      )}
    </span>
  );
}

/** Carte compacte et repliable pour un appel d'outil. */
export function ToolCard({ tool, autoFocus }: { tool: ToolCall; autoFocus?: boolean }) {
  const summaryRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (autoFocus) summaryRef.current?.focus();
    // Uniquement au montage (après une décision d'autorisation).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const input = formatInput(tool.input);
  return (
    <details className={`tool-card tool-${sensitivity(tool.name)} tool-is-${tool.status}`}>
      <summary ref={summaryRef}>
        <span className="tool-icon">
          <ToolIcon name={tool.name} />
        </span>
        <Summary name={tool.name} input={tool.input} />
        <span className={`tool-chip chip-${tool.status}`}>
          {tool.status === "running" && <i className="chip-spin" aria-hidden="true" />}
          {STATUS_LABEL[tool.status]}
        </span>
      </summary>
      <div className="tool-body">
        <div className="tool-label">
          Outil <code>{tool.name}</code> — paramètres
        </div>
        <pre className="tool-pre">{input && input !== "{}" ? truncate(input, 4000) : "(aucun)"}</pre>
        {tool.resultPreview !== undefined && tool.resultPreview !== "" && (
          <>
            <div className="tool-label">{tool.status === "error" ? "Erreur" : "Résultat (aperçu)"}</div>
            <pre className={`tool-pre ${tool.status === "error" ? "tool-pre-error" : ""}`}>{tool.resultPreview}</pre>
          </>
        )}
      </div>
    </details>
  );
}

/** Carte d'autorisation affichée dans le fil quand Claude veut utiliser un outil sensible. */
export function PermissionCard({
  request,
  busy,
  error,
  onDecide,
}: {
  request: PermissionRequest;
  busy: boolean;
  error?: string;
  onDecide(d: PermissionDecision): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const sens = sensitivity(request.tool);
  const kind = toolKind(request.tool);
  const preview = permissionPreview(request.tool, request.input);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.focus({ preventScroll: true });
  }, []);

  const s = toolSummary(request.tool, request.input);
  const serverSummary = request.summary?.trim();

  return (
    <div
      ref={ref}
      className={`perm-card perm-${sens}`}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabIndex={-1}
    >
      <div className="perm-head">
        <span className="perm-icon">{sens === "safe" ? <IconShield size={18} /> : <IconWarning size={18} />}</span>
        <h3 id={titleId} className="perm-title">
          Claude demande l'autorisation
        </h3>
        <span className="perm-tag">
          <ToolIcon name={request.tool} size={13} /> {KIND_TAG[kind]}
          {sens !== "safe" && <span className="sr-only"> (action sensible)</span>}
        </span>
      </div>

      <div id={descId}>
        <p className="perm-summary">
          {s.verb} {s.target && <code>{s.target}</code>}
          <span className="muted small"> — outil <code>{request.tool}</code></span>
        </p>
        {serverSummary && serverSummary !== `${s.verb} ${s.target ?? ""}`.trim() && (
          <p className="muted small perm-server-summary">{serverSummary}</p>
        )}
        {preview.facts.length > 0 && (
          <dl className="perm-facts">
            {preview.facts.map((f) => (
              <div key={f.label} className="perm-fact">
                <dt>{f.label}</dt>
                <dd className={f.mono ? "mono" : undefined}>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {sens === "danger" && (
          <p className="perm-warning">
            Cette commande s'exécutera sur votre PC, dans le dossier de travail. Vérifiez-la avant d'autoriser.
          </p>
        )}
      </div>

      {preview.block && preview.block.text && (
        <div className="perm-block">
          <div className="tool-label">{preview.block.label}</div>
          <pre className={`tool-pre ${showAll ? "" : "perm-pre-clip"}`}>
            {preview.block.diff
              ? preview.block.text.split("\n").map((line, i) => (
                  <span
                    key={i}
                    className={line.startsWith("+ ") ? "diff-add" : line.startsWith("- ") ? "diff-del" : undefined}
                  >
                    {line}
                    {"\n"}
                  </span>
                ))
              : preview.block.text}
          </pre>
          {preview.block.text.split("\n").length > 12 && (
            <button type="button" className="link-btn small" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
              {showAll ? "Réduire l'aperçu" : "Afficher tout l'aperçu"}
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="error-text small" role="alert">
          {error}
        </p>
      )}

      <div className="perm-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onDecide("allow")}>
          Autoriser
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => onDecide("allow_session")}
          aria-label={`Toujours autoriser ${request.tool} pour cette session`}
        >
          Toujours pour cette session
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onDecide("deny")}>
          Refuser
        </button>
        {busy && (
          <span className="muted small" role="status">
            Envoi…
          </span>
        )}
      </div>
    </div>
  );
}

export interface PermState {
  req: PermissionRequest;
  state: "pending" | "sending" | "answered" | "expired";
  decision?: PermissionDecision;
  error?: string;
}

/** Liste des outils d'un message ; les demandes en attente remplacent la carte de l'outil concerné. */
export function ToolList({
  tools,
  perms,
  onDecide,
}: {
  tools: ToolCall[];
  perms?: PermState[];
  onDecide?(reqId: string, d: PermissionDecision): void;
}) {
  if (tools.length === 0) return null;
  return (
    <ul className="tool-list" aria-label="Activité des outils">
      {tools.map((t) => {
        const p = perms?.find((x) => x.req.toolCallId === t.id);
        const asking = p && (p.state === "pending" || p.state === "sending") && onDecide;
        return (
          <li key={t.id}>
            {asking ? (
              <PermissionCard
                request={p.req}
                busy={p.state === "sending"}
                error={p.error}
                onDecide={(d) => onDecide(p.req.id, d)}
              />
            ) : (
              <ToolCard tool={t} autoFocus={p?.state === "answered" || p?.state === "expired"} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
