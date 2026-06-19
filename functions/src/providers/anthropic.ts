// Anthropic (Claude) provider — chat only. Implemented with raw fetch to the
// Messages API to avoid adding an SDK dependency. Anthropic does not offer a
// first-party embeddings API, so embeddings fall back to an embedding-capable
// provider in ai.ts.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

function chatModel(): string {
  return process.env.ANTHROPIC_CHAT_MODEL || "claude-3-5-sonnet-latest";
}

export async function anthropicLlm(
  apiKey: string,
  system: string,
  user: string,
  temperature = 0.2
): Promise<string> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION
    },
    body: JSON.stringify({
      model: chatModel(),
      max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS) || 4096,
      temperature,
      system,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!res.ok) {
    throw new Error(`anthropic_error_${res.status}`);
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("")
    .trim();
}

// Cheap probe: a 1-token message. Throws if the key is invalid.
export async function anthropicTest(apiKey: string): Promise<void> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION
    },
    body: JSON.stringify({
      model: chatModel(),
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }]
    })
  });
  if (!res.ok) throw new Error(`anthropic_error_${res.status}`);
}
