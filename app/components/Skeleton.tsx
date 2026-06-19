"use client";

/** Animated shimmer placeholder shown while an action result is loading. */
export function ResultSkeleton({ label }: { label?: string }) {
  return (
    <div className="result-box skel" aria-busy="true" aria-live="polite">
      {label ? (
        <div className="skel-label">
          <span className="spinner" /> {label}
        </div>
      ) : null}
      <div className="skel-bar medium" />
      <div className="skel-bar" />
      <div className="skel-bar" />
      <div className="skel-bar short" />
    </div>
  );
}
