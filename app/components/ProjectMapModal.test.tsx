import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ProjectMapModal } from "./ProjectMapModal";
import { DICT } from "../i18n";
import type { GhostData } from "../useGhostData";
import type { Json } from "../api";

afterEach(cleanup);

function makeG(overrides: Partial<GhostData> = {}): GhostData {
  return {
    t: DICT.en,
    loadScanStatus: async (): Promise<Json | null> => null,
    loadIntelMap: async (): Promise<Json | null> => null,
    loadNodeDetail: async (): Promise<Json | null> => null,
    ...overrides
  } as unknown as GhostData;
}

describe("ProjectMapModal states", () => {
  it("shows the loading state before the scan status resolves", () => {
    // Never-resolving status keeps the modal in its loading state.
    const g = makeG({ loadScanStatus: () => new Promise<Json | null>(() => {}) });
    render(<ProjectMapModal g={g} projectId="p1" projectName="Acme" onClose={() => {}} />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it("shows the empty / no-scan state when there is no scan", async () => {
    const g = makeG({ loadScanStatus: async () => null });
    render(<ProjectMapModal g={g} projectId="p1" projectName="Acme" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(DICT.en.intelNoScan)).toBeInTheDocument());
  });

  it("shows the error state when the scan failed", async () => {
    const g = makeG({ loadScanStatus: async () => ({ status: "failed", error: "boom" }) as Json });
    render(<ProjectMapModal g={g} projectId="p1" projectName="Acme" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
    expect(screen.getByText(new RegExp(DICT.en.errorWord))).toBeInTheDocument();
  });
});
