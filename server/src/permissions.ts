import { randomUUID } from "node:crypto";
import type { PermissionDecider, PermissionDecision, PermissionRequest } from "./types.js";

export const PERMISSION_TIMEOUT_MS = 10 * 60_000;

/** Outils en lecture seule, autorisés d'office dans le dossier de travail. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "TodoWrite", "LS", "NotebookRead"]);

export interface ResolvedDecision {
  decision: "allow" | "deny";
  by: PermissionDecider;
}

interface Pending {
  sessionId: string;
  tool: string;
  settle(d: ResolvedDecision): void;
}

const REQ_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
export function isValidRequestId(id: string): boolean {
  return REQ_ID_RE.test(id);
}

/**
 * Demandes de validation en attente (une par appel d'outil) et autorisations
 * « pour cette session » (par session MyClaude et par nom d'outil, en mémoire).
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly sessionAllow = new Map<string, Set<string>>();

  constructor(private readonly timeoutMs: number = PERMISSION_TIMEOUT_MS) {}

  isSessionAllowed(sessionId: string, tool: string): boolean {
    return this.sessionAllow.get(sessionId)?.has(tool) ?? false;
  }

  /** Oublie les autorisations de session et refuse les demandes en attente. */
  clearSession(sessionId: string): void {
    this.sessionAllow.delete(sessionId);
    for (const p of [...this.pending.values()]) {
      if (p.sessionId === sessionId) p.settle({ decision: "deny", by: "disconnect" });
    }
  }

  /**
   * Crée une demande et attend la réponse de l'utilisateur.
   * Refus automatique après le délai, ou dès qu'un des signaux est interrompu
   * (client déconnecté, réponse interrompue).
   * `onCreated` est appelé de façon synchrone avec la demande (pour l'émettre en SSE).
   */
  ask(
    req: Omit<PermissionRequest, "id">,
    signals: AbortSignal[],
    onCreated: (r: PermissionRequest) => void,
  ): Promise<ResolvedDecision> {
    const request: PermissionRequest = { id: randomUUID(), ...req };
    return new Promise<ResolvedDecision>((resolve) => {
      let done = false;
      const cleanups: (() => void)[] = [];
      const settle = (d: ResolvedDecision) => {
        if (done) return;
        done = true;
        this.pending.delete(request.id);
        for (const c of cleanups) c();
        resolve(d);
      };
      if (signals.some((s) => s.aborted)) {
        settle({ decision: "deny", by: "disconnect" });
        return;
      }
      const timer = setTimeout(() => settle({ decision: "deny", by: "timeout" }), this.timeoutMs);
      timer.unref?.();
      cleanups.push(() => clearTimeout(timer));
      for (const s of signals) {
        const onAbort = () => settle({ decision: "deny", by: "disconnect" });
        s.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => s.removeEventListener("abort", onAbort));
      }
      this.pending.set(request.id, { sessionId: req.sessionId, tool: req.tool, settle });
      onCreated(request);
    });
  }

  /** Réponse de l'utilisateur. Renvoie false si la demande est inconnue ou expirée. */
  respond(sessionId: string, requestId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.sessionId !== sessionId) return false;
    if (decision === "allow_session") {
      let set = this.sessionAllow.get(sessionId);
      if (!set) this.sessionAllow.set(sessionId, (set = new Set()));
      set.add(p.tool);
    }
    p.settle({ decision: decision === "deny" ? "deny" : "allow", by: "user" });
    return true;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
