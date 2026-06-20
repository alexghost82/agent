"use client";

import { useEffect } from "react";

export interface MapModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  closeLabel?: string;
  children: React.ReactNode;
}

export function MapModal({ open, title, onClose, closeLabel = "Close", children }: MapModalProps) {
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
    <div className="map-modal-backdrop" onClick={onClose}>
      <div
        className="map-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="map-modal-head">
          <h3>{title}</h3>
          <button className="ghost sm" onClick={onClose} aria-label={closeLabel} type="button">
            {"\u00d7"}
          </button>
        </div>
        <div className="map-modal-body">{children}</div>
      </div>
    </div>
  );
}

export default MapModal;
