import { memo, useState, type ReactNode, isValidElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconCheck, IconCopy } from "./Icons";

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Repli pour les contextes sans API presse-papiers.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, label = "Copier" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }
      }}
      aria-label={copied ? "Copié" : label}
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      <span>{copied ? "Copié" : label}</span>
    </button>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  let lang = "";
  const child = Array.isArray(children) ? children[0] : children;
  if (isValidElement<{ className?: string }>(child)) {
    const m = /language-([\w+#.-]+)/.exec(child.props.className ?? "");
    if (m) lang = m[1];
  }
  const code = textOf(children).replace(/\n$/, "");
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || "code"}</span>
        <CopyButton text={code} label="Copier le code" />
      </div>
      <pre tabIndex={0}>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="table-wrap" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
