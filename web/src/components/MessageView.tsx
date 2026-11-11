import type { ReactNode } from "react";
import type { ChatMessage } from "../types";
import { CopyButton, Markdown } from "./Markdown";
import { ToolList } from "./ToolActivity";

export function Thinking({ text, live }: { text: string; live?: boolean }) {
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

/** Contenu d'un message figé (utilisateur ou assistant), partagé par la discussion et la lecture Claude Code. */
export function MessageBody({ m, errorAction }: { m: ChatMessage; errorAction?: ReactNode }) {
  if (m.role === "user") return <div className="bubble">{m.text}</div>;
  return (
    <div className="assistant">
      {m.thinking && <Thinking text={m.thinking} />}
      {m.tools && m.tools.length > 0 && <ToolList tools={m.tools} />}
      {m.text && <Markdown text={m.text} />}
      {m.error && (
        <div className="msg-error" role="note">
          <span>{m.error}</span>
          {errorAction}
        </div>
      )}
      {m.text && !m.error && (
        <div className="msg-actions">
          <CopyButton text={m.text} label="Copier" />
        </div>
      )}
    </div>
  );
}
