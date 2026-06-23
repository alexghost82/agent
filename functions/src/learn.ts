import { db } from "./firebase";
import { embedding, embeddingBatch, llm } from "./ai";
import { serverTime } from "./util";
import { bumpCounter } from "./stats";
import { chunkText, contentHash, classifyResourceUrl, isTextFile, parseRepoUrl } from "./pure";
import { readUrl, crawlSite, type CrawledPage } from "./ssrf";
import { MAX_FILE_BYTES, getRepoInfo, fetchTree, fetchRawFile } from "./githubFetch";
import { mapWithConcurrency } from "./concurrency";
import { log } from "./log";

const EMBED_BATCH = Number(process.env.EMBED_BATCH_SIZE) || 96;
const WRITE_BATCH = 400;
// GitHub-into-topic ingestion bounds (mirrors github.ts repo ingestion).
const GITHUB_INGEST_MAX_FILES = Number(process.env.GITHUB_INGEST_MAX_FILES) || 400;
const GITHUB_FETCH_CONCURRENCY = Number(process.env.GITHUB_FETCH_CONCURRENCY) || 8;

// Embeddings returned by `embedding()` / `embeddingBatch()` are ALREADY
// canonicalized to TARGET_EMBED_DIM by the ai.ts normalization funnel (ADR-0008).
// Ingestion stores them verbatim — do NOT re-normalize or resize here, so the
// stored `embedding` always matches the single fixed dimension of the Firestore
// vector index regardless of which provider produced it.

// Self-learning loop + dedup (CONTRACT v3.4 / v2.1).
//
// `recordOutcome` writes the result of a design/plan/build/ask back into memory
// as a new knowledge chunk so future generations can retrieve it. Dedup helpers
// keep re-learning the same material from duplicating chunks.

export type OutcomeKind = "design_outcome" | "plan_outcome" | "build_outcome" | "ask_outcome";

const OUTCOME_MIN_CHARS = 40;
const OUTCOME_MAX_CHARS = 12000;
const EMBED_INPUT_MAX = 8000;
// Single-shot summary input cap (Epic 1.1). Resources LONGER than this are
// summarized via a map-reduce pass instead of being truncated to this window.
// Configurable via env so operators can tune cost/coverage.
const SUMMARY_INPUT_MAX = Number(process.env.SUMMARY_INPUT_MAX) || 12000;
// Map-reduce summary bounds: at most SUMMARY_MAX_CHUNKS map passes, each over a
// SUMMARY_CHUNK_CHARS-sized slice of the full text, then one reduce/synthesis.
const SUMMARY_MAX_CHUNKS = Number(process.env.SUMMARY_MAX_CHUNKS) || 8;
const SUMMARY_CHUNK_CHARS = Number(process.env.SUMMARY_CHUNK_CHARS) || 8000;

// Collects the set of existing chunk contentHashes for a given source URL so a
// re-`/learn` of the same URL skips already-stored chunks. Equality-only query
// (userId + sourceUrl) → served by automatic single-field indexes.
export async function existingHashesForSource(userId: string, sourceUrl: string, cap = 5000): Promise<Set<string>> {
  const snap = await db
    .collection("knowledge_chunks")
    .where("userId", "==", userId)
    .where("sourceUrl", "==", sourceUrl)
    .limit(cap)
    .get();
  const set = new Set<string>();
  for (const d of snap.docs) {
    const h = d.data().contentHash;
    if (typeof h === "string") set.add(h);
  }
  return set;
}

export interface IngestResult {
  sourceId: string;
  title: string;
  url: string;
  pages: number;
  chunks: number;
  skipped: number;
  summarized: boolean;
}

// Shared resource ingestion (Epic 3.1): fetch a URL (single page or bounded
// same-origin crawl), persist a `sources` doc, chunk + embed + store knowledge
// chunks (dedup across the crawl and against prior learns), then distil a
// structured summary chunk. Used by BOTH `POST /learn` and the autonomous agent
// route so the learning behaviour stays identical. The caller is responsible
// for topic ownership checks, rate limiting, logEvent and recordUsage. Network
// access stays behind the SSRF guard (readUrl/crawlSite are unchanged).
export async function ingestUrl(opts: {
  userId: string;
  topicId: string;
  url: string;
  tags?: string[];
  deep?: boolean;
}): Promise<IngestResult> {
  const { userId, topicId, url } = opts;
  const tags = opts.tags || [];

  // GitHub-URL routing (improvement 1): a repo URL pasted into Sources/`/learn`
  // is CODE, not a rendered web page. Scraping its HTML landing page indexes
  // navigation chrome instead of source. Detect repo URLs and index the repo
  // tree into topic-scoped chunks (chosen: full repo-into-topic indexing).
  const classified = classifyResourceUrl(url);
  if (classified.kind === "github_repo") {
    return ingestGithubRepoIntoTopic({ userId, topicId, url, tags });
  }

  const pages: CrawledPage[] = opts.deep ? await crawlSite(url) : [{ url, ...(await readUrl(url)) }];
  if (!pages.length) pages.push({ url, ...(await readUrl(url)) });
  const rootTitle = pages[0]?.title || url;

  const sourceRef = await db.collection("sources").add({
    userId,
    topicId,
    url,
    title: rootTitle,
    tags,
    deep: !!opts.deep,
    pageCount: pages.length,
    chunkCount: 0,
    createdAt: serverTime()
  });
  await bumpCounter(userId, "sources");

  // Dedup across the whole crawl + against prior /learn of the same URLs.
  const seenNow = new Set<string>();
  let saved = 0;
  let skipped = 0;
  for (const page of pages) {
    const allChunks = chunkText(page.text);
    const known = await existingHashesForSource(userId, page.url);
    const chunks: { text: string; hash: string }[] = [];
    for (const text of allChunks) {
      const hash = contentHash(text);
      if (known.has(hash) || seenNow.has(hash)) { skipped += 1; continue; }
      seenNow.add(hash);
      chunks.push({ text, hash });
    }
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const part = chunks.slice(i, i + EMBED_BATCH);
      const embeddings = await embeddingBatch(part.map((p) => p.text), userId);
      for (let j = 0; j < part.length; j += WRITE_BATCH) {
        const slice = part.slice(j, j + WRITE_BATCH);
        const batch = db.batch();
        slice.forEach((c, idx) => {
          const ref = db.collection("knowledge_chunks").doc();
          batch.set(ref, {
            userId,
            scope: "topic",
            topicId,
            sourceId: sourceRef.id,
            sourceUrl: page.url,
            title: page.title,
            content: c.text,
            embedding: embeddings[j + idx],
            chunkType: "fact",
            confidence: 0.75,
            contentHash: c.hash,
            tags,
            createdAt: serverTime()
          });
        });
        await batch.commit();
        saved += slice.length;
      }
    }
  }
  await sourceRef.update({ chunkCount: saved });
  await bumpCounter(userId, "knowledge_chunks", saved);

  // Real understanding (Epic 1.1): distil the whole resource into a single
  // structured summary chunk. Best-effort — never let it fail the ingest.
  let summarized = false;
  try {
    // Pass the FULL combined text — summarizeResource decides single-shot vs
    // map-reduce based on length (improvement 3), instead of pre-truncating.
    const combined = pages.map((p) => p.text).join("\n\n");
    const summary = await summarizeResource({
      userId,
      topicId,
      sourceId: sourceRef.id,
      sourceUrl: url,
      title: rootTitle,
      text: combined
    });
    summarized = summary.saved;
  } catch {
    /* summarization is best-effort; ingest already succeeded */
  }

  return { sourceId: sourceRef.id, title: rootTitle, url, pages: pages.length, chunks: saved, skipped, summarized };
}

// GitHub repo → topic ingestion (improvement 1, PREFERRED full-repo path).
//
// Mirrors the topic-scoped storage of `ingestUrl` (scope "topic" + topicId,
// dedup by contentHash, sources doc + counter bumps, best-effort summary) but
// sources its text from the repo's git tree via the read-only githubFetch
// helpers instead of readUrl/crawlSite. Returns the SAME `IngestResult` shape so
// `/learn` and the autonomous route stay backward-compatible. Unlike
// `ingestRepo` (github.ts) which stores scope "project"/projectId, this keeps
// every chunk topic-scoped so it lands in the user's topic knowledge base.
export async function ingestGithubRepoIntoTopic(opts: {
  userId: string;
  topicId: string;
  url: string;
  tags?: string[];
  token?: string;
}): Promise<IngestResult> {
  const { userId, topicId, url } = opts;
  const tags = opts.tags || [];
  const { owner, repo } = parseRepoUrl(url);
  const repoLabel = `${owner}/${repo}`;

  const repoInfo = await getRepoInfo(owner, repo, opts.token);
  const branch: string = repoInfo.default_branch || "main";
  const tree = await fetchTree(owner, repo, branch, opts.token);
  const blobs: { path: string }[] = tree
    .filter((n) => n.type === "blob" && isTextFile(n.path) && (n.size ?? 0) <= MAX_FILE_BYTES)
    .map((n) => ({ path: n.path }))
    .slice(0, GITHUB_INGEST_MAX_FILES);

  const sourceRef = await db.collection("sources").add({
    userId,
    topicId,
    url,
    title: repoLabel,
    tags,
    deep: false,
    kind: "github_repo",
    repoBranch: branch,
    pageCount: 1,
    chunkCount: 0,
    createdAt: serverTime()
  });
  await bumpCounter(userId, "sources");

  // Fetch file contents in parallel (bounded) — same pattern as ingestRepo.
  const files = await mapWithConcurrency(blobs, GITHUB_FETCH_CONCURRENCY, async (blob) => {
    const content = await fetchRawFile(owner, repo, branch, blob.path, opts.token);
    return { path: blob.path, content };
  });

  // Dedup against prior /learn of the same repo URL and within this ingest.
  const known = await existingHashesForSource(userId, url);
  const seenNow = new Set<string>();
  const pending: { path: string; text: string; hash: string }[] = [];
  let skipped = 0;
  for (const f of files) {
    if (!f.content || !f.content.trim()) continue;
    for (const text of chunkText(`FILE: ${f.path}\n${f.content}`)) {
      const hash = contentHash(text);
      if (known.has(hash) || seenNow.has(hash)) { skipped += 1; continue; }
      seenNow.add(hash);
      pending.push({ path: f.path, text, hash });
    }
  }

  let saved = 0;
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const part = pending.slice(i, i + EMBED_BATCH);
    const embeddings = await embeddingBatch(part.map((p) => p.text), userId);
    for (let j = 0; j < part.length; j += WRITE_BATCH) {
      const slice = part.slice(j, j + WRITE_BATCH);
      const batch = db.batch();
      slice.forEach((c, idx) => {
        const ref = db.collection("knowledge_chunks").doc();
        batch.set(ref, {
          userId,
          scope: "topic",
          topicId,
          sourceId: sourceRef.id,
          sourceUrl: url,
          sourcePath: c.path,
          title: c.path,
          content: c.text,
          embedding: embeddings[j + idx],
          chunkType: "code",
          confidence: 0.8,
          contentHash: c.hash,
          tags,
          createdAt: serverTime()
        });
      });
      await batch.commit();
      saved += slice.length;
    }
  }
  await sourceRef.update({ chunkCount: saved });
  await bumpCounter(userId, "knowledge_chunks", saved);

  // Best-effort structured summary over the repo's source (map-reduce when long).
  let summarized = false;
  try {
    const combined = files
      .filter((f) => f.content && f.content.trim())
      .map((f) => `FILE: ${f.path}\n${f.content}`)
      .join("\n\n");
    const summary = await summarizeResource({
      userId,
      topicId,
      sourceId: sourceRef.id,
      sourceUrl: url,
      title: repoLabel,
      text: combined
    });
    summarized = summary.saved;
  } catch {
    /* summarization is best-effort; ingest already succeeded */
  }

  return { sourceId: sourceRef.id, title: repoLabel, url, pages: 1, chunks: saved, skipped, summarized };
}

// Best-effort: appends an outcome to memory. Never throws into the request path
// — a feedback-write failure must not fail the originating design/build/ask.
export async function recordOutcome(opts: {
  userId: string;
  projectId?: string | null;
  topicId?: string | null;
  kind: OutcomeKind;
  title: string;
  content: string;
}): Promise<{ saved: boolean }> {
  try {
    const content = (opts.content || "").trim();
    if (content.length < OUTCOME_MIN_CHARS) return { saved: false };
    const hash = contentHash(content);

    // Dedup: skip if this exact outcome content was already stored for the user.
    const dup = await db
      .collection("knowledge_chunks")
      .where("userId", "==", opts.userId)
      .where("contentHash", "==", hash)
      .limit(1)
      .get();
    if (!dup.empty) return { saved: false };

    const emb = await embedding(content.slice(0, EMBED_INPUT_MAX), opts.userId);
    await db.collection("knowledge_chunks").add({
      userId: opts.userId,
      scope: opts.projectId ? "project" : "build",
      projectId: opts.projectId || null,
      topicId: opts.topicId || null,
      title: opts.title.slice(0, 200),
      content: content.slice(0, OUTCOME_MAX_CHARS),
      embedding: emb,
      chunkType: opts.kind,
      confidence: 0.6,
      contentHash: hash,
      createdAt: serverTime()
    });
    await bumpCounter(opts.userId, "knowledge_chunks");
    return { saved: true };
  } catch (err) {
    log("warn", "record_outcome_failed", {
      userId: opts.userId,
      kind: opts.kind,
      message: err instanceof Error ? err.message : String(err)
    });
    return { saved: false };
  }
}

// Real understanding (Epic 1.1): instead of only indexing raw chunks, distil a
// learned resource into a structured summary and store it as its own
// `chunkType: "summary"` knowledge chunk. Best-effort like `recordOutcome` — it
// NEVER throws into the /learn request path; a summarization failure must not
// fail an otherwise successful ingest.
// System prompt shared by single-shot and the map-reduce SYNTHESIS step.
const SUMMARY_SYSTEM =
  "Ты выделяешь суть изученного ресурса для долговременной памяти инженерного агента. " +
  "Пиши кратко, структурированно и по делу, без воды и без выдумок поверх текста.";

// Produce the final structured Russian summary from `text` (a raw resource for
// the single-shot path, or the concatenated per-chunk notes for the reduce step).
async function structuredSummary(
  userId: string,
  title: string,
  sourceUrl: string,
  text: string
): Promise<string> {
  const user =
    `Сделай структурированный конспект ресурса ниже.\n\n` +
    `Заголовок: ${title}\nURL: ${sourceUrl}\n\n` +
    `ФОРМАТ:\n` +
    `- Тема: 1-2 предложения о чём ресурс.\n` +
    `- Ключевые понятия: 5-10 пунктов.\n` +
    `- Применимые паттерны/практики: список того, что можно переиспользовать.\n` +
    `- Краткий вывод: 2-3 предложения.\n\n` +
    `ТЕКСТ:\n${text}`;
  return (await llm(SUMMARY_SYSTEM, user, 0.2, userId)).trim();
}

// Map-reduce summary for long resources (improvement 3): split the full text
// into a bounded number of chunks, summarize each (MAP), then synthesize one
// structured summary from the per-chunk notes (REDUCE). A single failed map
// pass is skipped rather than aborting the whole summary. Returns "" when no
// chunk could be summarized so the caller can fall back to single-shot.
async function mapReduceSummary(
  userId: string,
  title: string,
  sourceUrl: string,
  text: string
): Promise<string> {
  const bounded = text.slice(0, SUMMARY_MAX_CHUNKS * SUMMARY_CHUNK_CHARS);
  const chunks = chunkText(bounded, SUMMARY_CHUNK_CHARS).slice(0, SUMMARY_MAX_CHUNKS);
  if (!chunks.length) return "";

  const mapSystem =
    "Ты кратко конспектируешь ОДИН фрагмент большого ресурса. " +
    "Выдели только факты и идеи этого фрагмента в виде сжатых пунктов, без воды и без выдумок.";
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const mapUser =
      `Фрагмент ${i + 1} из ${chunks.length} ресурса «${title}».\n\n` +
      `Выдели ключевые факты и идеи этого фрагмента в виде кратких пунктов.\n\n` +
      `ТЕКСТ:\n${chunks[i]}`;
    try {
      const partial = (await llm(mapSystem, mapUser, 0.2, userId)).trim();
      if (partial) partials.push(`Фрагмент ${i + 1}:\n${partial}`);
    } catch {
      /* skip a failed map pass; keep summarizing the rest */
    }
  }
  if (!partials.length) return "";
  return structuredSummary(userId, title, sourceUrl, partials.join("\n\n"));
}

export async function summarizeResource(opts: {
  userId: string;
  topicId: string;
  sourceId: string;
  sourceUrl: string;
  title: string;
  text: string;
}): Promise<{ saved: boolean }> {
  try {
    const raw = (opts.text || "").trim();
    if (raw.length < OUTCOME_MIN_CHARS) return { saved: false };

    // Long resources: map-reduce over the full text instead of truncating to
    // the first SUMMARY_INPUT_MAX chars. Fall back to single-shot on the
    // truncated head if map-reduce yields nothing.
    let summary: string;
    if (raw.length > SUMMARY_INPUT_MAX) {
      summary = await mapReduceSummary(opts.userId, opts.title, opts.sourceUrl, raw);
      if (summary.length < OUTCOME_MIN_CHARS) {
        summary = await structuredSummary(opts.userId, opts.title, opts.sourceUrl, raw.slice(0, SUMMARY_INPUT_MAX));
      }
    } else {
      summary = await structuredSummary(opts.userId, opts.title, opts.sourceUrl, raw);
    }
    if (summary.length < OUTCOME_MIN_CHARS) return { saved: false };

    const hash = contentHash(summary);
    // Dedup like recordOutcome: skip if this exact summary already exists.
    const dup = await db
      .collection("knowledge_chunks")
      .where("userId", "==", opts.userId)
      .where("contentHash", "==", hash)
      .limit(1)
      .get();
    if (!dup.empty) return { saved: false };

    const emb = await embedding(summary.slice(0, EMBED_INPUT_MAX), opts.userId);
    await db.collection("knowledge_chunks").add({
      userId: opts.userId,
      scope: "topic",
      topicId: opts.topicId,
      sourceId: opts.sourceId,
      sourceUrl: opts.sourceUrl,
      title: opts.title.slice(0, 200),
      content: summary.slice(0, OUTCOME_MAX_CHARS),
      embedding: emb,
      chunkType: "summary",
      confidence: 0.9,
      contentHash: hash,
      createdAt: serverTime()
    });
    await bumpCounter(opts.userId, "knowledge_chunks");
    return { saved: true };
  } catch (err) {
    log("warn", "summarize_resource_failed", {
      userId: opts.userId,
      sourceId: opts.sourceId,
      message: err instanceof Error ? err.message : String(err)
    });
    return { saved: false };
  }
}
