import { db } from "./firebase";
import { embedding, embeddingBatch, llm } from "./ai";
import { serverTime } from "./util";
import { bumpCounter } from "./stats";
import { chunkText, contentHash } from "./pure";
import { readUrl, crawlSite, type CrawledPage } from "./ssrf";
import { log } from "./log";

const EMBED_BATCH = Number(process.env.EMBED_BATCH_SIZE) || 96;
const WRITE_BATCH = 400;

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
// Cap the model input for summarization so a large multi-page resource stays
// within a sensible/cheap context window (Epic 1.1).
const SUMMARY_INPUT_MAX = 12000;

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
    const combined = pages.map((p) => p.text).join("\n\n").slice(0, 12000);
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
export async function summarizeResource(opts: {
  userId: string;
  topicId: string;
  sourceId: string;
  sourceUrl: string;
  title: string;
  text: string;
}): Promise<{ saved: boolean }> {
  try {
    const input = (opts.text || "").trim().slice(0, SUMMARY_INPUT_MAX);
    if (input.length < OUTCOME_MIN_CHARS) return { saved: false };

    const system =
      "Ты выделяешь суть изученного ресурса для долговременной памяти инженерного агента. " +
      "Пиши кратко, структурированно и по делу, без воды и без выдумок поверх текста.";
    const user =
      `Сделай структурированный конспект ресурса ниже.\n\n` +
      `Заголовок: ${opts.title}\nURL: ${opts.sourceUrl}\n\n` +
      `ФОРМАТ:\n` +
      `- Тема: 1-2 предложения о чём ресурс.\n` +
      `- Ключевые понятия: 5-10 пунктов.\n` +
      `- Применимые паттерны/практики: список того, что можно переиспользовать.\n` +
      `- Краткий вывод: 2-3 предложения.\n\n` +
      `ТЕКСТ:\n${input}`;

    const summary = (await llm(system, user, 0.2, opts.userId)).trim();
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
