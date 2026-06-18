// Loaded FIRST — before any `../../src/**` import — so that firebase-admin has a
// project id when `admin.initializeApp()` runs (it executes at import time inside
// src/firebase.ts). This module intentionally imports NOTHING from src, so its
// side effects are guaranteed to run before src/firebase.ts is evaluated
// (ES modules evaluate imported subtrees in source order, depth-first).
//
// Under `firebase emulators:exec` the CLI also sets FIRESTORE_EMULATOR_HOST and
// GCLOUD_PROJECT; the defaults below only matter for ad-hoc local runs.

if (!process.env.GCLOUD_PROJECT) process.env.GCLOUD_PROJECT = "demo-ghost";
if (!process.env.GOOGLE_CLOUD_PROJECT) {
  process.env.GOOGLE_CLOUD_PROJECT = process.env.GCLOUD_PROJECT;
}

export {};
