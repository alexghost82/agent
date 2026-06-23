/**
 * Unit tests — REAL PDF extraction (Epic 1.4). Exercises the pdf-parse-backed
 * extractor through the public `extractPdfText` seam: a valid in-memory PDF must
 * yield real text, and a malformed buffer must degrade to the best-effort
 * extractor WITHOUT throwing. The pdf-parse-dependent assertion self-skips when
 * the optional library is not installed so the suite stays green offline.
 */
import { describe, it, expect } from "vitest";
import { extractPdfText, setPdfExtractor } from "../src/pdf";

// Detect the optional dependency once. Top-level await is supported by Vitest.
let pdfParseInstalled = false;
try {
  await import("pdf-parse");
  pdfParseInstalled = true;
} catch {
  pdfParseInstalled = false;
}

// Minimal but structurally valid single-page PDF whose content stream shows the
// literal "Hello PDF World". Generated offline; embedded as base64 so the test
// needs no fixture file on disk.
const MINIMAL_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2Jq" +
  "CjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2Jq" +
  "CjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIg" +
  "NzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4g" +
  "Pj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NyA+PgpzdHJlYW0KQlQgL0YxIDI0IFRm" +
  "IDEwMCA3MDAgVGQgKEhlbGxvIFBERiBXb3JsZCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAg" +
  "b2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+" +
  "PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4g" +
  "CjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAw" +
  "IG4gCjAwMDAwMDAzMzggMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+" +
  "CnN0YXJ0eHJlZgo0MDgKJSVFT0YK";

describe("real PDF extraction (Epic 1.4)", () => {
  it.skipIf(!pdfParseInstalled)(
    "extracts real text from a valid PDF via pdf-parse",
    async () => {
      const buf = Buffer.from(MINIMAL_PDF_BASE64, "base64");
      const text = await extractPdfText(buf);
      expect(text).toContain("Hello PDF World");
    }
  );

  it("falls back gracefully (no throw) on a malformed PDF buffer", async () => {
    const bad = Buffer.from("%PDF-1.7 totally broken \x00\x01 not a real pdf", "latin1");
    // Must not reject — a parse failure has to degrade, not propagate.
    const text = await extractPdfText(bad);
    expect(typeof text).toBe("string");
    // The dependency-free best-effort path still recovers readable ASCII.
    expect(text).toContain("totally broken");
    expect(text).not.toContain("\x00");
  });

  it("still honours a parser injected via the seam", async () => {
    setPdfExtractor(async () => "parsed by injected engine");
    try {
      expect(await extractPdfText(Buffer.from("ignored"))).toBe("parsed by injected engine");
    } finally {
      setPdfExtractor(null);
    }
  });
});
