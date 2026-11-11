// Icônes SVG minimales (traits), décoratives : toujours aria-hidden.
type P = { size?: number };
const base = (size = 18) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
});

export const IconPlus = ({ size }: P) => (
  <svg {...base(size)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconMenu = ({ size }: P) => (
  <svg {...base(size)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const IconClose = ({ size }: P) => (
  <svg {...base(size)}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconSend = ({ size }: P) => (
  <svg {...base(size)}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
export const IconStop = ({ size }: P) => (
  <svg {...base(size)}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
);
export const IconCopy = ({ size }: P) => (
  <svg {...base(size)}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
);
export const IconCheck = ({ size }: P) => (
  <svg {...base(size)}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
export const IconBook = ({ size }: P) => (
  <svg {...base(size)}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /></svg>
);
export const IconSettings = ({ size }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);
export const IconSun = ({ size }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
);
export const IconMoon = ({ size }: P) => (
  <svg {...base(size)}><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></svg>
);
export const IconMonitor = ({ size }: P) => (
  <svg {...base(size)}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
);
export const IconTrash = ({ size }: P) => (
  <svg {...base(size)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);
export const IconChevron = ({ size }: P) => (
  <svg {...base(size)}><path d="M9 6l6 6-6 6" /></svg>
);
export const IconRetry = ({ size }: P) => (
  <svg {...base(size)}><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" /></svg>
);
export const IconChat = ({ size }: P) => (
  <svg {...base(size)}><path d="M4 5h16v11H9l-5 4z" /></svg>
);

/** Marque originale de MyClaude : un astérisque doux dans un rond. */
export const Logo = ({ size = 22 }: P) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <circle cx="16" cy="16" r="15" fill="var(--accent)" />
    <path d="M16 8v16M9.1 12l13.8 8M9.1 20l13.8-8" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);
