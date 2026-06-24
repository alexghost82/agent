import { FieldValue, Timestamp } from "firebase-admin/firestore";
import * as crypto from "crypto";
import { db } from "./firebase";
import { bumpCounter } from "./stats";

export function serverTime() {
  return FieldValue.serverTimestamp();
}

// Cyrillic -> Latin so Russian project names still yield readable slugs
// (project ids are used unescaped in URL paths, so they must stay ASCII-safe).
const CYRILLIC_TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
};

// Turns a human project name into a readable, URL-safe slug, e.g.
// "ACTA Ghost" -> "acta-ghost", "Мой проект" -> "moy-proekt". Falls back to
// "project" when a name has no transliterable characters (e.g. pure Hebrew).
export function slugifyProjectId(name: string): string {
  const translit = Array.from(name.toLowerCase())
    .map((ch) => (ch in CYRILLIC_TRANSLIT ? CYRILLIC_TRANSLIT[ch] : ch))
    .join("");
  const slug = translit
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "project";
}

function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 6 || /already exists/i.test(msg);
}

// Creates a project document with a readable, name-derived id (see
// slugifyProjectId). Document ids must be globally unique, so on a collision we
// append a numeric suffix (acta, acta-2, acta-3, …) and finally a short random
// suffix as a guaranteed fallback. `create()` is atomic, so this is race-safe.
export async function createProjectWithReadableId(
  data: Record<string, unknown>,
  name: string
): Promise<string> {
  const base = slugifyProjectId(name);
  const candidates = [base, ...Array.from({ length: 49 }, (_, i) => `${base}-${i + 2}`)];
  for (const id of candidates) {
    const ref = db.collection("projects").doc(id);
    try {
      await ref.create(data);
      return id;
    } catch (err) {
      if (isAlreadyExists(err)) continue;
      throw err;
    }
  }
  // Extremely unlikely: 50 taken. Use a random suffix that cannot realistically collide.
  const id = `${base}-${crypto.randomBytes(3).toString("hex")}`;
  await db.collection("projects").doc(id).create(data);
  return id;
}

function logTtlMs(): number {
  const days = Number(process.env.AGENT_LOGS_TTL_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 90) * 24 * 60 * 60 * 1000;
}

export async function logEvent(
  userId: string | null,
  type: string,
  message: string,
  data: Record<string, unknown> = {}
) {
  await db.collection("agent_logs").add({
    userId: userId || null,
    type,
    message,
    data,
    createdAt: serverTime(),
    // TTL field: a Firestore TTL policy on `expireAt` reaps old logs (infra is
    // configured by the Architect/ops; the field is written here).
    expireAt: Timestamp.fromMillis(Date.now() + logTtlMs())
  });
  if (userId) await bumpCounter(userId, "agent_logs");
}
