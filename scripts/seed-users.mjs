#!/usr/bin/env node
// Seed login users into Firestore via the Admin SDK (ops convenience).
//
// Reuses the same scrypt salt+hash scheme as functions/src/auth.ts so seeded
// users can log in through POST /login. Credentials come from the environment,
// never source: SEED_USERS="Alex:passA,Omer:passB".
//
// Usage (with application default creds or GOOGLE_APPLICATION_CREDENTIALS):
//   PROJECT_ID=my-project SEED_USERS="Alex:secret" node scripts/seed-users.mjs
import crypto from "node:crypto";
import admin from "firebase-admin";

const projectId = process.env.PROJECT_ID || process.env.GCLOUD_PROJECT;
if (!projectId) {
  console.error("Set PROJECT_ID");
  process.exit(1);
}

admin.initializeApp({ projectId });
const db = admin.firestore();

function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function parseSeedUsers(raw) {
  return (raw || "")
    .split(",")
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx === -1) return null;
      const username = pair.slice(0, idx).trim();
      const password = pair.slice(idx + 1).trim();
      return username && password ? { username, password } : null;
    })
    .filter(Boolean);
}

const users = parseSeedUsers(process.env.SEED_USERS);
if (!users.length) {
  console.error('Set SEED_USERS="Name:password,..."');
  process.exit(1);
}

for (const u of users) {
  const ref = db.collection("users").doc(u.username.toLowerCase());
  if ((await ref.get()).exists) {
    console.log(`skip existing ${u.username}`);
    continue;
  }
  const salt = makeSalt();
  await ref.set({
    username: u.username,
    salt,
    passwordHash: hashPassword(u.password, salt),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`seeded ${u.username}`);
}
console.log("done");
process.exit(0);
