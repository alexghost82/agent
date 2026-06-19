// Azure OpenAI provider — chat + embeddings via raw fetch (no SDK dependency).
// Azure is configured by resource endpoint + deployment names (env), with the
// API key resolved per-user/server like other providers.
//
//   AZURE_OPENAI_ENDPOINT   e.g. https://my-resource.openai.azure.com
//   AZURE_OPENAI_API_VERSION e.g. 2024-06-01
//   AZURE_OPENAI_CHAT_DEPLOYMENT / AZURE_OPENAI_EMBED_DEPLOYMENT

function endpoint(): string {
  const e = process.env.AZURE_OPENAI_ENDPOINT;
  if (!e) throw new Error("azure_not_configured");
  return e.replace(/\/+$/, "");
}
function apiVersion(): string {
  return process.env.AZURE_OPENAI_API_VERSION || "2024-06-01";
}
function chatDeployment(): string {
  return process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || "gpt-4o-mini";
}
function embedDeployment(): string {
  return process.env.AZURE_OPENAI_EMBED_DEPLOYMENT || "text-embedding-3-small";
}

async function azurePost(path: string, apiKey: string, body: unknown): Promise<any> {
  const res = await fetch(`${endpoint()}${path}?api-version=${apiVersion()}`, {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`azure_error_${res.status}`);
  return res.json();
}

export async function azureEmbedding(apiKey: string, input: string): Promise<number[]> {
  const data = await azurePost(`/openai/deployments/${embedDeployment()}/embeddings`, apiKey, { input });
  return data.data[0].embedding;
}

export async function azureEmbeddingBatch(apiKey: string, inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  const data = await azurePost(`/openai/deployments/${embedDeployment()}/embeddings`, apiKey, { input: inputs });
  return data.data
    .slice()
    .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    .map((d: { embedding: number[] }) => d.embedding);
}

export async function azureLlm(apiKey: string, system: string, user: string, temperature = 0.2): Promise<string> {
  const data = await azurePost(`/openai/deployments/${chatDeployment()}/chat/completions`, apiKey, {
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  return data.choices?.[0]?.message?.content || "";
}

export async function azureTest(apiKey: string): Promise<void> {
  await azureEmbedding(apiKey, "ping");
}
