import { db } from "./firebase";
import { decryptSecret, EncryptedSecret } from "./crypto";
import { log } from "./log";
import { openaiEmbedding, openaiEmbeddingBatch, openaiLlm, openaiTest } from "./providers/openai";
import { geminiEmbedding, geminiEmbeddingBatch, geminiLlm, geminiTest } from "./providers/gemini";
import { anthropicLlm, anthropicTest } from "./providers/anthropic";
import { azureEmbedding, azureEmbeddingBatch, azureLlm, azureTest } from "./providers/azure";
import { type ReplyLang, normalizeLang, languageDirective } from "./lang";

export type AiProvider = "openai" | "gemini" | "anthropic" | "azure-openai";

// Providers that can produce embeddings natively. Anthropic cannot, so embedding
// calls fall back to an embedding-capable provider (CONTRACT v3.7).
const EMBEDDING_CAPABLE: ReadonlySet<AiProvider> = new Set<AiProvider>(["openai", "gemini", "azure-openai"]);

// Canonical embedding dimension (ADR-0008). Firestore Vector Search needs ONE
// fixed dimension across the whole index, but providers emit different sizes
// (OpenAI/Azure text-embedding-3-small = 1536, Gemini text-embedding-004 = 768).
// Every embedding is normalized to this dimension before it is stored or used as
// a query vector, so all vectors are index-compatible regardless of provider.
// This value MUST equal the `dimension` declared for `knowledge_chunks.embedding`
// in firestore.indexes.json.
export const TARGET_EMBED_DIM = Number(process.env.TARGET_EMBED_DIM) || 1536;

// Maps a provider embedding of ANY dimension to a canonical `targetDim` vector
// (ADR-0008), then L2-renormalizes so cosine similarity stays meaningful and
// comparable across providers:
//   - len > targetDim → deterministic average-pool (block mean) so every input
//     coordinate contributes (chosen over truncation, which drops the tail);
//   - len < targetDim → zero-pad;
//   - len === targetDim → unchanged copy.
// Pure and deterministic (no I/O). L2-renorm is scale-invariant, so it preserves
// cosine and is a no-op for already-unit-norm providers (e.g. OpenAI). A genuine
// zero vector (norm 0) is returned as-is to avoid NaN.
export function normalizeEmbedding(vec: number[], targetDim: number = TARGET_EMBED_DIM): number[] {
  const dim = Math.max(1, Math.floor(targetDim));
  let out: number[];
  if (vec.length === dim) {
    out = vec.slice();
  } else if (vec.length > dim) {
    out = new Array<number>(dim).fill(0);
    for (let i = 0; i < dim; i++) {
      const lo = Math.floor((i * vec.length) / dim);
      const hi = Math.max(Math.floor(((i + 1) * vec.length) / dim), lo + 1);
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += vec[j] || 0;
      out[i] = sum / (hi - lo);
    }
  } else {
    out = new Array<number>(dim).fill(0);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i];
  }

  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return out;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

interface Resolved {
  provider: AiProvider;
  apiKey: string;
  source: "user" | "server";
}

// Minimal shape of a context item passed to generateAnswer (subset of a
// ScoredChunk). Declared here to avoid a circular import with memory.ts.
export interface AnswerContextItem {
  title?: string;
  sourceUrl?: string;
  sourcePath?: string;
  chunkType?: string;
  content: string;
}

function envKeyFor(provider: AiProvider): string | undefined {
  switch (provider) {
    case "openai": return process.env.OPENAI_API_KEY;
    case "gemini": return process.env.GEMINI_API_KEY;
    case "anthropic": return process.env.ANTHROPIC_API_KEY;
    case "azure-openai": return process.env.AZURE_OPENAI_API_KEY;
  }
}

function normalizeProvider(value: unknown): AiProvider {
  return value === "gemini" || value === "anthropic" || value === "azure-openai" ? value : "openai";
}

// Resolves which provider to use and the API key to use with it.
// Order: the user's own key for the active provider -> the server env key ->
// otherwise a `no_api_key` error (surfaced as HTTP 400 by the routes).
// `overrideProvider` lets the /test endpoint probe a specific provider
// regardless of the user's current selection.
async function resolve(userId?: string, overrideProvider?: AiProvider): Promise<Resolved> {
  let provider: AiProvider = overrideProvider ?? "openai";
  let userKey: string | undefined;

  if (userId) {
    const data = (await db.collection("users").doc(userId).get()).data() || {};
    if (!overrideProvider) {
      provider = normalizeProvider(data.aiProvider);
    }
    const enc = data.apiKeys?.[provider] as EncryptedSecret | undefined;
    if (enc?.ciphertext) {
      try {
        userKey = decryptSecret(enc);
      } catch {
        // Do NOT silently swallow: log so tampering / key-rotation issues are
        // visible. We still fall back to the env key to preserve availability.
        log("warn", "user_key_decrypt_failed", { userId, provider });
        userKey = undefined;
      }
    }
  }

  const apiKey = userKey || envKeyFor(provider);
  if (!apiKey) {
    throw new Error("no_api_key");
  }
  return { provider, apiKey, source: userKey ? "user" : "server" };
}

// Resolves a key for an embedding-capable provider. If the active provider
// cannot embed (Anthropic), falls back to an env-configured embedder so memory
// keeps working (CONTRACT v3.7).
async function resolveEmbedding(userId?: string): Promise<Resolved> {
  const r = await resolve(userId);
  if (EMBEDDING_CAPABLE.has(r.provider)) return r;
  const fallback: AiProvider[] = ["openai", "gemini", "azure-openai"];
  for (const p of fallback) {
    const key = envKeyFor(p);
    if (key) return { provider: p, apiKey: key, source: "server" };
  }
  throw new Error("no_api_key");
}

function dispatchEmbedding(provider: AiProvider, apiKey: string, input: string): Promise<number[]> {
  if (provider === "gemini") return geminiEmbedding(apiKey, input);
  if (provider === "azure-openai") return azureEmbedding(apiKey, input);
  return openaiEmbedding(apiKey, input);
}
function dispatchEmbeddingBatch(provider: AiProvider, apiKey: string, inputs: string[]): Promise<number[][]> {
  if (provider === "gemini") return geminiEmbeddingBatch(apiKey, inputs);
  if (provider === "azure-openai") return azureEmbeddingBatch(apiKey, inputs);
  return openaiEmbeddingBatch(apiKey, inputs);
}

export async function embedding(input: string, userId: string): Promise<number[]> {
  const { provider, apiKey } = await resolveEmbedding(userId);
  const raw = await dispatchEmbedding(provider, apiKey, input);
  // Canonicalize to TARGET_EMBED_DIM so every stored/queried vector matches the
  // single fixed dimension of the Firestore vector index, regardless of provider
  // (ADR-0008). This is the single funnel for both ingestion and query paths.
  return normalizeEmbedding(raw, TARGET_EMBED_DIM);
}

// Batch embeddings: a single provider call for many inputs. Resolves the key
// once and returns vectors in the same order as the inputs.
export async function embeddingBatch(inputs: string[], userId: string): Promise<number[][]> {
  if (!inputs.length) return [];
  const { provider, apiKey } = await resolveEmbedding(userId);
  const raw = await dispatchEmbeddingBatch(provider, apiKey, inputs);
  return raw.map((v) => normalizeEmbedding(v, TARGET_EMBED_DIM));
}

export async function llm(
  system: string,
  user: string,
  temperature = 0.2,
  userId?: string
): Promise<string> {
  const { provider, apiKey } = await resolve(userId);
  if (provider === "gemini") return geminiLlm(apiKey, system, user, temperature);
  if (provider === "anthropic") return anthropicLlm(apiKey, system, user, temperature);
  if (provider === "azure-openai") return azureLlm(apiKey, system, user, temperature);
  return openaiLlm(apiKey, system, user, temperature);
}

// `lang` controls the answer language and defaults to Russian when omitted, so
// existing callers keep their previous behaviour. New callers pass the active
// UI language so the agent replies in the same language as the interface.
export async function generateAnswer(
  question: string,
  context: AnswerContextItem[],
  userId: string,
  lang?: ReplyLang
): Promise<string> {
  const reply = normalizeLang(lang);
  const contextText = context
    .map(
      (item, i) =>
        `SOURCE ${i + 1}: ${item.title}\nURL: ${item.sourceUrl || item.sourcePath || ""}\nTYPE: ${item.chunkType || "fact"}\nTEXT: ${item.content}`
    )
    .join("\n\n---\n\n");
  return llm(
    `Ты AI-агент-архитектор и senior software engineer. ${languageDirective(reply)} Используй контекст. Если данных не хватает — честно скажи. Всегда добавляй риски и следующий шаг.`,
    `CONTEXT:\n${contextText}\n\nREQUEST:\n${question}`,
    0.2,
    userId
  );
}

// Used by POST /me/api-keys/test. Resolves the key for the requested provider
// (user key, else env fallback) and runs a cheap probe against the provider.
export async function probeProvider(
  userId: string,
  provider: AiProvider
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { apiKey } = await resolve(userId, provider);
    if (provider === "gemini") await geminiTest(apiKey);
    else if (provider === "anthropic") await anthropicTest(apiKey);
    else if (provider === "azure-openai") await azureTest(apiKey);
    else await openaiTest(apiKey);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "probe_failed" };
  }
}
