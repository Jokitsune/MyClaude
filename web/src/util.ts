import type { AppConfig, SessionMeta } from "./types";

const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const dateFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const fullFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short" });

/** Date relative en français : « à l'instant », « il y a 5 minutes », « hier »… */
export function relativeDate(isoDate: string, now = Date.now()): string {
  const t = new Date(isoDate).getTime();
  if (Number.isNaN(t)) return "";
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "à l'instant";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), "day");
  return dateFmt.format(new Date(t));
}

export function fullDate(isoDate: string): string {
  const d = new Date(isoDate);
  return Number.isNaN(d.getTime()) ? "" : fullFmt.format(d);
}

export const STATUS_LABEL: Record<SessionMeta["status"], string> = {
  open: "en cours",
  closed: "terminée",
  interrupted: "interrompue",
};

export const REVIEW_LABEL: Record<SessionMeta["review"], string> = {
  pending: "Bilan en attente",
  running: "Bilan en cours",
  done: "Bilan effectué",
  failed: "Bilan en échec",
};

export const EFFORT_LABEL: Record<string, string> = {
  low: "Faible",
  medium: "Moyen",
  high: "Élevé",
  xhigh: "Très élevé",
  max: "Maximum",
};

/** Le moteur est-il prêt ? (repli sur `hasApiKey` si le serveur est encore en v1). */
export function engineReady(config: AppConfig): boolean {
  return typeof config.engineReady === "boolean" ? config.engineReady : config.hasApiKey;
}

export function modelLabel(id: string, models: { id: string; label: string }[] | undefined): string {
  return models?.find((m) => m.id === id)?.label ?? id;
}

// --- Thème ---

export type ThemePref = "system" | "light" | "dark";
const THEME_KEY = "myclaude.theme";

export function loadTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* stockage indisponible */
  }
  return "system";
}

export function saveTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* stockage indisponible */
  }
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}
