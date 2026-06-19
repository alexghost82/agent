// PDF text extraction seam (Epic 1.4). Real PDF parsing needs a heavy library
// (pdf-parse / pdfjs-dist) that we may not be able to install in every (offline)
// environment, so extraction lives behind this seam. A real parser can be
// injected via `setPdfExtractor`; the default is a dependency-free best-effort
// extractor that pulls text out of PDF content-stream text operators and falls
// back to an ASCII strip — never worse than the prior inline behaviour.

export type PdfExtractor = (buf: Buffer) => Promise<string>;

// Pull the parenthesized string literals shown by PDF text operators
// (`(text) Tj` / `[(a)(b)] TJ`). Handles the common PDF escape sequences. This
// is heuristic, not a full parser, but recovers readable text for most PDFs.
function extractParenStrings(raw: string): string {
  const out: string[] = [];
  const re = /\(((?:\\.|[^()\\])*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const s = m[1]
      .replace(/\\([nrt])/g, (_all, c) => (c === "n" || c === "r" || c === "t" ? " " : c))
      .replace(/\\([()\\])/g, "$1")
      .replace(/\\[0-7]{1,3}/g, " ");
    if (s.trim()) out.push(s);
  }
  return out.join(" ");
}

const bestEffortExtractor: PdfExtractor = async (buf: Buffer) => {
  const raw = buf.toString("latin1");
  const fromTextOps = extractParenStrings(raw).trim();
  const candidate = fromTextOps.length > 0 ? fromTextOps : raw;
  // Normalize to readable ASCII + whitespace, dropping binary/font noise.
  return candidate.replace(/[^\x20-\x7E\s]/g, " ").replace(/\s+/g, " ").trim();
};

let activeExtractor: PdfExtractor = bestEffortExtractor;

// Install (or, with null, reset to the default) the active PDF extractor.
export function setPdfExtractor(extractor: PdfExtractor | null): void {
  activeExtractor = extractor ?? bestEffortExtractor;
}

// Extract readable text from a PDF buffer via the configured extractor.
export function extractPdfText(buf: Buffer): Promise<string> {
  return activeExtractor(buf);
}
