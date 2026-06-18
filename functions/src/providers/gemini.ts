import { GoogleGenerativeAI } from "@google/generative-ai";
import { LruCache } from "../lru";

// One SDK entry point per resolved API key, cached (LRU-bounded) to avoid
// rebuilding it on every request while keeping users isolated.
const clients = new LruCache<string, GoogleGenerativeAI>(Number(process.env.PROVIDER_CLIENT_CACHE_MAX) || 50);

function client(apiKey: string): GoogleGenerativeAI {
  let c = clients.get(apiKey);
  if (!c) {
    c = new GoogleGenerativeAI(apiKey);
    clients.set(apiKey, c);
  }
  return c;
}

function embedModel(): string {
  return process.env.GEMINI_EMBED_MODEL || "text-embedding-004";
}

function chatModel(): string {
  return process.env.GEMINI_CHAT_MODEL || "gemini-1.5-flash";
}

export async function geminiEmbedding(apiKey: string, input: string): Promise<number[]> {
  const model = client(apiKey).getGenerativeModel({ model: embedModel() });
  const res = await model.embedContent(input);
  return res.embedding.values;
}

// Batch embeddings in a single request. Results follow input order.
export async function geminiEmbeddingBatch(apiKey: string, inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  const model = client(apiKey).getGenerativeModel({ model: embedModel() });
  const res = await model.batchEmbedContents({
    requests: inputs.map((text) => ({ content: { role: "user", parts: [{ text }] } }))
  });
  return res.embeddings.map((e) => e.values);
}

export async function geminiLlm(
  apiKey: string,
  system: string,
  user: string,
  temperature = 0.2
): Promise<string> {
  const model = client(apiKey).getGenerativeModel({
    model: chatModel(),
    systemInstruction: system
  });
  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature }
  });
  return res.response.text();
}

// Cheap probe: embed a tiny string. Throws if the key is invalid.
export async function geminiTest(apiKey: string): Promise<void> {
  const model = client(apiKey).getGenerativeModel({ model: embedModel() });
  await model.embedContent("ping");
}
