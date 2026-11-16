import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import "./sources.css";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = {
  labelledBy: string;
  /** Escape and a click on the backdrop call it, unless `locked` (while something must not be interrupted). */
  onClose: () => void;
  locked?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * A modal dialog over a dimmed backdrop: Tab stays inside it, Escape closes it, and closing gives focus back to what
 * had it before. The first field (or button) gets focus when it opens. It is rendered on the document body.
 */
export function Modal({ labelledBy, onClose, locked = false, className, children }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Everything behind the dialog is out of reach (focus, clicks and assistive technology) while it is open.
    const backdrop = root.current?.parentElement ?? null;
    const muted = [...document.body.children].filter((el): el is HTMLElement => el !== backdrop && el instanceof HTMLElement && !el.inert);
    for (const el of muted) el.inert = true;
    const first = root.current?.querySelector<HTMLElement>("[data-autofocus]") ?? root.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !lockedRef.current) {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !root.current) return;
      const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) {
        e.preventDefault();
        items[items.length - 1]!.focus();
      } else if (!e.shiftKey && (at === -1 || at === items.length - 1)) {
        e.preventDefault();
        items[0]!.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      for (const el of muted) el.inert = false;
      if (before?.isConnected) before.focus();
    };
  }, []);

  // On the body, so no surrounding view's styles (a side bar's full-width buttons) reach into the dialog.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !lockedRef.current) close.current();
      }}
    >
      <div ref={root} role="dialog" aria-modal="true" aria-labelledby={labelledBy} className={`modal${className ? ` ${className}` : ""}`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
