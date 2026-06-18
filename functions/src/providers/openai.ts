import OpenAI from "openai";
import { LruCache } from "../lru";

// Clients are cached per resolved API key so we do not rebuild the HTTP agent
// on every request, while still keeping different users fully isolated. The LRU
// cap bounds memory on long-lived instances that see many distinct keys.
const clients = new LruCache<string, OpenAI>(Number(process.env.PROVIDER_CLIENT_CACHE_MAX) || 50);

function client(apiKey: string): OpenAI {
  let c = clients.get(apiKey);
  if (!c) {
    c = new OpenAI({ apiKey });
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

export async function openaiLlm(
  apiKey: string,
  system: string,
  user: string,
  temperature = 0.2
): Promise<string> {
  const res = await client(apiKey).chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
    temperature,
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
