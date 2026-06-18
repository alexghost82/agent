"use client";

import { Icon } from "../icons";
import type { GhostData } from "../useGhostData";

export function Onboarding({ g, onDismiss }: { g: GhostData; onDismiss: () => void }) {
  const { t } = g;
  const steps = [t.onboardStep1, t.onboardStep2, t.onboardStep3, t.onboardStep4];
  return (
    <div className="onboard">
      <div className="onboard-head">
        <div className="onboard-spark">
          <Icon name="skills" />
        </div>
        <div>
          <h3>{t.onboardTitle}</h3>
          <p>{t.onboardSubtitle}</p>
        </div>
      </div>
      <ol className="onboard-steps">
        {steps.map((s, i) => (
          <li key={i}>
            <span className="onboard-num">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <div className="onboard-actions">
        <button className="primary" onClick={() => g.setActive("sources")}>
          <Icon name="plus" /> {t.onboardStart}
        </button>
        <button className="ghost" onClick={onDismiss}>
          {t.onboardDismiss}
        </button>
      </div>
    </div>
  );
}
