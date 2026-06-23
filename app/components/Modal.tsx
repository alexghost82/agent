"use client";

import { ReactNode, useEffect } from "react";

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p className="modal-sub">{subtitle}</p> : null}
          </div>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="close">
            {"\u00d7"}
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
