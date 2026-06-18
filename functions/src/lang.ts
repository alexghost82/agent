// Reply-language support for agent outputs (Ask / Design / Plan).
//
// Additive + backward compatible: when no language is provided we fall back to
// "ru", which reproduces the historical hard-coded behaviour ("Отвечай на
// русском"). New clients send the active UI language so the agent answers in
// the same language the interface is displayed in:
//   en -> English, he -> Hebrew (strict), ru -> Russian.

export type ReplyLang = "en" | "he" | "ru";

export const REPLY_LANGS: readonly ReplyLang[] = ["en", "he", "ru"] as const;

export const DEFAULT_REPLY_LANG: ReplyLang = "ru";

/** Coerces arbitrary input into a supported language, defaulting to Russian. */
export function normalizeLang(input: unknown): ReplyLang {
  return input === "en" || input === "he" || input === "ru" ? input : DEFAULT_REPLY_LANG;
}

/**
 * A strict, single-sentence instruction telling the model which language to
 * answer in. Kept short so it can be appended to any existing system prompt
 * without altering the rest of the persona.
 */
export function languageDirective(lang: ReplyLang): string {
  switch (lang) {
    case "en":
      return "Always respond strictly in English.";
    case "he":
      return "\u05e2\u05e0\u05d4 \u05ea\u05de\u05d9\u05d3 \u05d5\u05d0\u05da \u05d5\u05e8\u05e7 \u05d1\u05e2\u05d1\u05e8\u05d9\u05ea.";
    case "ru":
    default:
      return "\u0412\u0441\u0435\u0433\u0434\u0430 \u043e\u0442\u0432\u0435\u0447\u0430\u0439 \u0441\u0442\u0440\u043e\u0433\u043e \u043d\u0430 \u0440\u0443\u0441\u0441\u043a\u043e\u043c \u044f\u0437\u044b\u043a\u0435.";
  }
}
