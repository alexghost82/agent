/**
 * wipe-user-data.ts — standalone Admin-SDK CLI to wipe ALL data for ONE user.
 *
 * Removes every per-user document across the wipe collection set
 * (knowledge_chunks, sources, topics, agent_skills, projects, project_decisions,
 * generated_plans, flow_maps, agent_logs), purges each project's
 * project-intelligence scan artifacts, and resets the user's stat counters to 0.
 * It reuses the exact same core (`wipeUserData`) the POST /me/wipe route uses,
 * so the CLI and the API can never drift.
 *
 * SAFETY
 *  - DRY-RUN BY DEFAULT: without --commit it only COUNTS what would be deleted
 *    (per collection + project_intel) and prints a summary. Nothing is written.
 *  - --commit is the single explicit gate that performs the irreversible delete.
 *
 * USAGE (from functions/)
 *   # preview only (no writes):
 *   npx tsx scripts/wipe-user-data.ts --user <username|userId>
 *
 *   # actually delete:
 *   npx tsx scripts/wipe-user-data.ts --user <username|userId> --commit
 *
 * BOOTSTRAP (mirrors rotate-keys.ts / seed-vector-fixtures.ts): this imports the
 * shared Admin app from ../src/firebase rather than calling initializeApp itself,
 * so it targets the Firestore EMULATOR when FIRESTORE_EMULATOR_HOST is set, or a
 * real project via GOOGLE_APPLICATION_CREDENTIALS + GCLOUD_PROJECT otherwise.
 *
 *   export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080   # local emulator, OR
 *   export GOOGLE_APPLICATION_CREDENTIALS=./sa.json  # real project
 *   export GCLOUD_PROJECT=my-project
 */

import { db } from "../src/firebase";
import { WIPE_COLLECTIONS, countUserData, wipeUserData } from "../src/routes/maintenance";

interface Flags {
  user?: string;
  commit: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { commit: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--commit") flags.commit = true;
    else if (arg === "--user") flags.user = argv[++i];
    else if (arg.startsWith("--user=")) flags.user = arg.slice("--user=".length);
  }
  return flags;
}

// Resolve a user to its `users/{docId}`. Accepts either the doc id directly or a
// `username` field value (the doc id is the lowercased username for seed users,
// but real ids may differ, so we try both).
async function resolveUserId(userArg: string): Promise<string | null> {
  const byId = await db.collection("users").doc(userArg).get();
  if (byId.exists) return byId.id;

  const byUsername = await db.collection("users").where("username", "==", userArg).limit(1).get();
  if (!byUsername.empty) return byUsername.docs[0].id;

  // Case-insensitive fallback: seed user doc ids are lowercased usernames.
  const lowered = userArg.toLowerCase();
  if (lowered !== userArg) {
    const byLoweredId = await db.collection("users").doc(lowered).get();
    if (byLoweredId.exists) return byLoweredId.id;
  }
  return null;
}

function printSummary(counts: Record<string, number>): void {
  const keys = [...WIPE_COLLECTIONS, "project_intel"];
  let total = 0;
  for (const k of keys) {
    const n = counts[k] ?? 0;
    total += n;
    console.log(`  ${k.padEnd(20)} ${n}`);
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${total}`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.user) {
    console.error("usage: tsx scripts/wipe-user-data.ts --user <username|userId> [--commit]");
    process.exitCode = 2;
    return;
  }

  const userId = await resolveUserId(flags.user);
  if (!userId) {
    console.error(`wipe-user-data: no user found matching "${flags.user}"`);
    process.exitCode = 1;
    return;
  }

  console.log(`wipe-user-data: user "${flags.user}" -> userId=${userId}`);
  console.log(`wipe-user-data: mode = ${flags.commit ? "COMMIT (will delete)" : "DRY-RUN (no writes)"}`);

  if (!flags.commit) {
    const counts = await countUserData(userId);
    console.log("would delete:");
    printSummary(counts);
    console.log("dry-run: nothing was deleted. Re-run with --commit to apply.");
    return;
  }

  const { deleted } = await wipeUserData(userId);
  console.log("deleted:");
  printSummary(deleted);
  console.log("wipe-user-data: done — counters reset to 0.");
}

main().catch((err) => {
  console.error("wipe-user-data: fatal error", err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
