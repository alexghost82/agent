/**
 * GHOST Agent Builder — AI provider contract (FROZEN).
 *
 * This module is the single source of truth for the TypeScript shapes behind the
 * "bring your own API key" feature. It contains **types and JSDoc only** — no
 * runtime logic, no encryption, no route handlers, no implementations.
 *
 * Implementation (encryption, routes, provider clients, UI) lives elsewhere and
 * MUST conform to the shapes declared here. Do not change these contracts without
 * updating `docs/API.md` and `docs/ARCHITECTURE.md` in lockstep.
 */

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Identifier of a supported AI provider.
 *
 * Used both as the user's selected `aiProvider` and as the key for per-provider
 * stored API keys.
 */
export type ProviderName = "openai" | "gemini";

/**
 * Default provider applied to a user that has never chosen one.
 * Declared as a type so callers can reference the frozen default without
 * importing a runtime constant.
 */
export type DefaultProviderName = "openai";

/* -------------------------------------------------------------------------- */
/* Stored API keys                                                            */
/* -------------------------------------------------------------------------- */

/**
 * ISO-8601 timestamp (e.g. `"2026-06-17T10:15:00.000Z"`).
 *
 * The stored representation is serialized to a string in API responses. The
 * backend MAY persist a Firestore `Timestamp` internally, but the contract for
 * the encrypted-key envelope and HTTP layer is an ISO-8601 string.
 */
export type IsoDateTime = string;

/**
 * Last 4 characters of the raw API key, kept in cleartext so the UI can show a
 * masked hint (e.g. `"…a1b2"`). This is the ONLY part of the key that may ever
 * be stored or returned unencrypted.
 */
export type Last4 = string;

/**
 * Encrypted API key envelope as persisted in Firestore.
 *
 * Encryption is AES-256-GCM using the server master secret `KEYS_ENC_SECRET`.
 * The raw key is NEVER stored and NEVER returned to the client — only this
 * envelope is persisted, and only the derived {@link StoredKeyStatus} is exposed
 * over HTTP.
 */
export interface EncryptedApiKey {
  /** Base64/hex ciphertext of the raw API key (AES-256-GCM output). */
  ciphertext: string;
  /** Initialization vector used for this encryption. */
  iv: string;
  /** GCM authentication tag produced during encryption. */
  tag: string;
  /** Last 4 chars of the raw key, for masked display only. */
  last4: Last4;
  /** When this key was last written. */
  updatedAt: IsoDateTime;
}

/**
 * Per-provider map of encrypted API keys stored on the user document.
 * A provider entry is absent when the user has not configured a key for it.
 */
export type StoredApiKeys = {
  [P in ProviderName]?: EncryptedApiKey;
};

/* -------------------------------------------------------------------------- */
/* User data model (Firestore `users/{id}`)                                  */
/* -------------------------------------------------------------------------- */

/**
 * AI-related fields layered onto the Firestore `users/{id}` document by this
 * feature. Existing fields (credentials, sessionToken, githubToken, …) are not
 * part of this contract and are intentionally omitted.
 */
export interface UserAiSettings {
  /**
   * The provider used to resolve a key for AI calls.
   * Defaults to {@link DefaultProviderName} (`"openai"`) when unset.
   */
  aiProvider?: ProviderName;
  /** Encrypted, per-provider API keys owned by the user. */
  apiKeys?: StoredApiKeys;
}

/* -------------------------------------------------------------------------- */
/* HTTP DTOs — /me/api-keys                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Safe, client-facing status of a single provider's key. Never contains
 * ciphertext or the raw key.
 */
export interface StoredKeyStatus {
  /** Whether an encrypted key is currently stored for this provider. */
  configured: boolean;
  /** Masked hint (last 4 chars); present only when {@link configured}. */
  last4?: Last4;
  /** When the key was last updated; present only when {@link configured}. */
  updatedAt?: IsoDateTime;
}

/**
 * Response body for `GET /me/api-keys` and the result of `PUT /me/api-keys`.
 */
export interface ApiKeysStatusResponse {
  /** The user's currently selected provider. */
  provider: ProviderName;
  /** Per-provider configuration status. */
  keys: {
    openai: StoredKeyStatus;
    gemini: StoredKeyStatus;
  };
}

/**
 * Request body for `PUT /me/api-keys`.
 *
 * - A `string` sets/replaces the raw key (validated, then encrypted server-side).
 * - `null` deletes the stored key for that provider.
 * - `undefined` (field omitted) leaves the existing key untouched.
 *
 * Validation (server-side): OpenAI keys must match `^sk-`, Gemini keys `^AIza`.
 */
export interface UpdateApiKeysRequest {
  /** New OpenAI key, `null` to delete, or omit to keep. */
  openai?: string | null;
  /** New Gemini key, `null` to delete, or omit to keep. */
  gemini?: string | null;
  /** Optionally switch the active provider. */
  provider?: ProviderName;
}

/** Request body for `POST /me/api-keys/test`. */
export interface TestApiKeyRequest {
  /** Provider whose stored/resolved key should be live-tested. */
  provider: ProviderName;
}

/** Response body for `POST /me/api-keys/test`. */
export interface TestApiKeyResponse {
  /** Whether the resolved key authenticated successfully. */
  ok: boolean;
  /** Machine-readable error code when {@link ok} is false. */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Key resolution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Where a resolved API key originated. Useful for logging/telemetry.
 * - `"user"`   — decrypted from the user's stored key for the active provider.
 * - `"server"` — fell back to the server env key (e.g. `OPENAI_API_KEY`,
 *                `GEMINI_API_KEY`).
 */
export type KeySource = "user" | "server";

/**
 * Outcome of resolving a usable API key for an AI call.
 * The resolver tries the user's key first, then the server env key, and
 * otherwise fails with the frozen `"no_api_key"` error.
 */
export interface ResolvedKey {
  provider: ProviderName;
  apiKey: string;
  source: KeySource;
}

/**
 * Frozen error code thrown/returned when no user key and no server fallback key
 * are available for the active provider.
 */
export type NoApiKeyError = "no_api_key";

/* -------------------------------------------------------------------------- */
/* Provider abstraction (FROZEN)                                              */
/* -------------------------------------------------------------------------- */

/**
 * A single, provider-agnostic chat message.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Provider-agnostic AI client.
 *
 * Each concrete provider (OpenAI, Gemini) implements this interface using a key
 * resolved via the user → server fallback chain. Implementations live outside
 * this file; only the shape is frozen here.
 */
export interface AiProvider {
  /** Provider this instance represents. */
  readonly name: ProviderName;

  /**
   * Produce an embedding vector for `input`.
   * @param input Text to embed.
   * @returns Dense embedding as an array of numbers.
   */
  embedding(input: string): Promise<number[]>;

  /**
   * Run a chat/completion turn.
   * @param messages Ordered conversation (system first, by convention).
   * @param temperature Optional sampling temperature.
   * @returns The assistant's text reply (empty string if none).
   */
  chat(messages: ChatMessage[], temperature?: number): Promise<string>;
}

/* -------------------------------------------------------------------------- */
/* AI service layer (FROZEN signatures)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Frozen signatures of the high-level AI helpers. The `userId` parameter selects
 * the user whose provider + key resolve the call. These type aliases document
 * the contract; the runtime functions are implemented in the AI layer.
 */
export type EmbeddingFn = (input: string, userId: string) => Promise<number[]>;

/** @see EmbeddingFn */
export type LlmFn = (
  system: string,
  user: string,
  temperature?: number,
  userId?: string
) => Promise<string>;

/** @see EmbeddingFn */
export type GenerateAnswerFn = (
  question: string,
  context: unknown[],
  userId: string
) => Promise<string>;
