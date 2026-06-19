/**
 * Unit tests — PDF extraction seam (Epic 1.4). Covers the dependency-free
 * best-effort extractor on a synthetic content stream and the injectable seam
 * used to plug in a real parser.
 */
import { describe, it, expect } from "vitest";
import { extractPdfText, setPdfExtractor } from "../src/pdf";

describe("extractPdfText (Epic 1.4)", () => {
  it("recovers readable text from PDF text-show operators", async () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n4 0 obj\n<< /Length 60 >>\nstream\nBT /F1 12 Tf 72 700 Td (Hello World from PDF) Tj ET\nendstream\nendobj\n\x00\x01\x02binary",
      "latin1"
    );
    const text = await extractPdfText(pdf);
    expect(text).toContain("Hello World from PDF");
    expect(text).not.toContain("\x00");
  });

  it("falls back to an ASCII strip when there are no text operators", async () => {
    const pdf = Buffer.from("plain ascii fallback text \x00\x99\xfe noise", "latin1");
    const text = await extractPdfText(pdf);
    expect(text).toContain("plain ascii fallback text");
    expect(text).not.toMatch(/[^\x20-\x7E]/);
  });

  it("supports injecting a real parser via the seam", async () => {
    setPdfExtractor(async () => "parsed by injected engine");
    try {
      expect(await extractPdfText(Buffer.from("ignored"))).toBe("parsed by injected engine");
    } finally {
      setPdfExtractor(null);
    }
  });
});
