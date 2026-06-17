import OpenAI from "openai";

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on the server");
  }
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export async function embedding(input: string): Promise<number[]> {
  const res = await openai().embeddings.create({ model: "text-embedding-3-small", input });
  return res.data[0].embedding;
}

export async function llm(system: string, user: string, temperature = 0.2): Promise<string> {
  const res = await openai().chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  return res.choices[0].message.content || "";
}

export async function generateAnswer(question: string, context: any[]): Promise<string> {
  const contextText = context
    .map(
      (item, i) =>
        `SOURCE ${i + 1}: ${item.title}\nURL: ${item.sourceUrl || item.sourcePath || ""}\nTYPE: ${item.chunkType || "fact"}\nTEXT: ${item.content}`
    )
    .join("\n\n---\n\n");
  return llm(
    "Ты AI-агент-архитектор и senior software engineer. Отвечай на русском. Используй контекст. Если данных не хватает — честно скажи. Всегда добавляй риски и следующий шаг.",
    `CONTEXT:\n${contextText}\n\nREQUEST:\n${question}`
  );
}
