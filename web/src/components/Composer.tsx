import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { IconSend, IconStop } from "./Icons";

interface Props {
  disabled: boolean;
  disabledReason?: string;
  streaming: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  onSend(text: string): void;
  onStop(): void;
  /** Permet au parent de réinjecter un texte (ex. après un échec d'envoi). */
  restore?: { text: string; n: number } | null;
}

export function Composer({ disabled, disabledReason, streaming, placeholder, autoFocus, onSend, onStop, restore }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    if (restore) setText(restore.text);
  }, [restore]);

  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus();
  }, [autoFocus, disabled]);

  const canSend = !disabled && !streaming && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className={`composer ${disabled ? "is-disabled" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor="composer-input" className="sr-only">
        Votre message
      </label>
      <textarea
        id="composer-input"
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={disabled ? disabledReason : placeholder ?? "Écrivez votre message…"}
        disabled={disabled}
        aria-describedby={disabled ? undefined : "composer-hint"}
      />
      <div className="composer-row">
        <span id="composer-hint" className="composer-hint">
          {disabled ? "" : "Entrée pour envoyer · Maj+Entrée pour un saut de ligne"}
        </span>
        {streaming ? (
          <button type="button" className="send-btn stop" onClick={onStop} aria-label="Arrêter la génération">
            <IconStop size={16} />
          </button>
        ) : (
          <button type="submit" className="send-btn" disabled={!canSend} aria-label="Envoyer le message">
            <IconSend size={18} />
          </button>
        )}
      </div>
    </form>
  );
}
