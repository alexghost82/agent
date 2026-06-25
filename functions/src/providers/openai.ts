import OpenAI from "openai";
import { LruCache } from "../lru";

// Clients are cached per resolved API key so we do not rebuild the HTTP agent
// on every request, while still keeping different users fully isolated. The LRU
// cap bounds memory on long-lived instances that see many distinct keys.
const clients = new LruCache<string, OpenAI>(Number(process.env.PROVIDER_CLIENT_CACHE_MAX) || 50);

// Per-request bounds so a single slow/stalled OpenAI call can't hang a worker
// for tens of minutes (the SDK defaults are a 600s timeout with 2 retries, i.e.
// up to ~30 min of wall-clock on a stuck request). Both are env-overridable.
function clientTimeoutMs(): number {
  const n = Number(process.env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 240_000;
}
function clientMaxRetries(): number {
  const n = Number(process.env.OPENAI_MAX_RETRIES);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

function client(apiKey: string): OpenAI {
  let c = clients.get(apiKey);
  if (!c) {
    c = new OpenAI({ apiKey, timeout: clientTimeoutMs(), maxRetries: clientMaxRetries() });
    clients.set(apiKey, c);
  }
  return c;
}

export async function openaiEmbedding(apiKey: string, input: string): Promise<number[]> {
  const res = await client(apiKey).embeddings.create({ model: "text-embedding-3-small", input });
  return res.data[0].embedding;
}

// Single request for many inputs (OpenAI accepts an array). Results are returned
// in the same order as `inputs`.
export async function openaiEmbeddingBatch(apiKey: string, inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  const res = await client(apiKey).embeddings.create({ model: "text-embedding-3-small", input: inputs });
  return res.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

// Newer OpenAI models (gpt-5 family, the o-series reasoning models) reject any
// non-default `temperature` with a 400 ("Only the default (1) value is
// supported"). For those we omit the parameter entirely and let the API use its
// default; older chat models (gpt-4*, gpt-3.5*) keep honoring the value.
function supportsCustomTemperature(model: string): boolean {
  return !/^(gpt-5|o1|o3|o4)/i.test(model.trim());
}

export async function openaiLlm(
  apiKey: string,
  system: string,
  user: string,
  temperature = 0.2
): Promise<string> {
  const model = process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini";
  const res = await client(apiKey).chat.completions.create({
    model,
    ...(supportsCustomTemperature(model) ? { temperature } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  return res.choices[0].message.content || "";
}

// Cheap probe: list models. Throws if the key is invalid.
export async function openaiTest(apiKey: string): Promise<void> {
  await client(apiKey).models.list();
}
