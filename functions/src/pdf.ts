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

// --- Real parser (pdf-parse), lazily required ----------------------------------
//
// `pdf-parse` (and its transitive pdfjs-dist/canvas deps) is heavy and may be
// absent in stripped/offline environments, so it is required lazily inside a
// try/catch. We support both the v2 class API (`new PDFParse({data}).getText()`)
// and the legacy v1 callable API (`pdfParse(buf)`), and ALWAYS fall back to the
// dependency-free best-effort extractor if the library is missing, returns
// nothing useful, or throws (e.g. on a malformed buffer) — a parse failure must
// never propagate out of the seam.

type PdfTextResult = { text?: string | null };

interface PdfParseV2Instance {
  getText(): Promise<PdfTextResult>;
  destroy?: () => Promise<void> | void;
}

interface PdfParseV2Ctor {
  new (options: { data: Uint8Array }): PdfParseV2Instance;
}

type PdfParseV1Fn = (data: Buffer) => Promise<PdfTextResult>;

// Resolve whatever `require("pdf-parse")` returns into one of the supported
// shapes. Handles CommonJS default-export interop for both major versions.
function resolvePdfParse(
  mod: unknown
): { v2?: PdfParseV2Ctor; v1?: PdfParseV1Fn } {
  if (!mod) return {};
  if (typeof mod === "function") return { v1: mod as PdfParseV1Fn };
  const m = mod as { PDFParse?: unknown; default?: unknown };
  if (typeof m.PDFParse === "function") return { v2: m.PDFParse as PdfParseV2Ctor };
  if (m.default) {
    if (typeof m.default === "function") return { v1: m.default as PdfParseV1Fn };
    const d = m.default as { PDFParse?: unknown };
    if (typeof d.PDFParse === "function") return { v2: d.PDFParse as PdfParseV2Ctor };
  }
  return {};
}

let pdfParseModule: unknown;
let pdfParseLoaded = false;

function loadPdfParse(): { v2?: PdfParseV2Ctor; v1?: PdfParseV1Fn } {
  if (!pdfParseLoaded) {
    pdfParseLoaded = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      pdfParseModule = require("pdf-parse");
    } catch {
      pdfParseModule = undefined;
    }
  }
  return resolvePdfParse(pdfParseModule);
}

// True when `pdf-parse` is resolvable, without paying the cost of loading its
// heavy transitive deps. Used only to decide the default active extractor.
function pdfParseAvailable(): boolean {
  try {
    require.resolve("pdf-parse");
    return true;
  } catch {
    return false;
  }
}

const pdfParseExtractor: PdfExtractor = async (buf: Buffer) => {
  const { v2, v1 } = loadPdfParse();
  try {
    if (v2) {
      const parser = new v2({ data: new Uint8Array(buf) });
      try {
        const res = await parser.getText();
        const text = (res?.text ?? "").trim();
        if (text.length > 0) return text;
      } finally {
        if (typeof parser.destroy === "function") {
          try {
            await parser.destroy();
          } catch {
            /* ignore cleanup errors */
          }
        }
      }
    } else if (v1) {
      const res = await v1(buf);
      const text = (res?.text ?? "").trim();
      if (text.length > 0) return text;
    }
  } catch {
    /* fall through to best-effort on any parse failure */
  }
  return bestEffortExtractor(buf);
};

// Use the real parser as the default when the library is installed; otherwise
// keep the dependency-free best-effort extractor. Either can be overridden via
// `setPdfExtractor`.
let activeExtractor: PdfExtractor = pdfParseAvailable() ? pdfParseExtractor : bestEffortExtractor;

// Install (or, with null, reset to the default) the active PDF extractor.
export function setPdfExtractor(extractor: PdfExtractor | null): void {
  activeExtractor = extractor ?? bestEffortExtractor;
}

// Extract readable text from a PDF buffer via the configured extractor.
export function extractPdfText(buf: Buffer): Promise<string> {
  return activeExtractor(buf);
}
