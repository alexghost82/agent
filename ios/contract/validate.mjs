#!/usr/bin/env node
// No-Xcode contract check for the GhostAgent iOS client.
//
// Validates that the recorded JSON fixtures (which mirror the backend's real
// responses + error envelope) satisfy the derived contract in contract.json —
// the same shapes the Swift APIClient/Models decode. Runs anywhere Node is
// available (no Xcode, no simulator, no network):
//
//     node ios/contract/validate.mjs
//
// Exits non-zero on the first contract violation so CI fails loudly.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(here, "contract.json"), "utf8"));

const failures = [];
const passes = [];
const referenced = new Set();

function fail(where, msg) {
  failures.push(`✗ ${where}: ${msg}`);
}
function pass(where) {
  passes.push(`✓ ${where}`);
}

function load(rel) {
  referenced.add(rel.replace(/^\.\//, ""));
  return JSON.parse(readFileSync(join(here, rel), "utf8"));
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // string | number | boolean | object
}

// Recursively validate `value` against a schema node {type, fields?, items?}.
function validateNode(value, schema, path, where) {
  const actual = typeOf(value);
  if (schema.type && schema.type !== "any" && actual !== schema.type) {
    fail(where, `${path} expected ${schema.type}, got ${actual}`);
    return;
  }
  if (schema.type === "object" && Array.isArray(schema.fields)) {
    for (const field of schema.fields) {
      const present = value != null && Object.prototype.hasOwnProperty.call(value, field.name);
      const v = present ? value[field.name] : undefined;
      if (!present || v === null) {
        if (field.required) fail(where, `${path}.${field.name} is required but ${present ? "null" : "missing"}`);
        continue; // optional/nullable -> nothing more to check
      }
      validateNode(v, field, `${path}.${field.name}`, where);
    }
  }
  if (schema.type === "array" && schema.items) {
    value.forEach((el, i) => validateNode(el, schema.items, `${path}[${i}]`, where));
  }
}

// 1) Endpoint response fixtures conform to their declared response schema.
for (const ep of contract.endpoints) {
  if (!ep.responseFixture || !ep.response) continue;
  const where = `${ep.method} ${ep.path} (${ep.iosModel})`;
  let fixture;
  try {
    fixture = load(ep.responseFixture);
  } catch (e) {
    fail(where, `cannot read fixture ${ep.responseFixture}: ${e.message}`);
    continue;
  }
  const before = failures.length;
  validateNode(fixture, ep.response, "$", where);
  if (failures.length === before) pass(where);
}

// 2) Error envelope fixtures conform to the shared envelope + known codes.
const env = contract.errorEnvelope;
for (const rel of env.fixtures) {
  const where = `error envelope ${rel}`;
  let fixture;
  try {
    fixture = load(rel);
  } catch (e) {
    fail(where, `cannot read fixture: ${e.message}`);
    continue;
  }
  const before = failures.length;
  validateNode(fixture, env.schema, "$", where);
  if (typeof fixture.error === "string" && !env.errorCodes.includes(fixture.error)) {
    fail(where, `unknown error code "${fixture.error}" (not in errors.ts ErrorCode union)`);
  }
  if (failures.length === before) pass(where);
}

// 3) No orphan fixtures: every JSON under fixtures/ must be referenced by the
//    contract, so a stale/unused fixture can't silently rot.
const fixtureDir = join(here, "fixtures");
for (const name of readdirSync(fixtureDir)) {
  if (!name.endsWith(".json")) continue;
  const rel = relative(here, join(fixtureDir, name)).split("\\").join("/");
  if (!referenced.has(rel)) fail("fixtures", `${rel} is not referenced by contract.json`);
}
if (!failures.some((f) => f.startsWith("✗ fixtures"))) pass("no orphan fixtures");

// Report.
for (const p of passes) console.log(p);
if (failures.length) {
  console.error("\n" + failures.join("\n"));
  console.error(`\nContract check FAILED: ${failures.length} violation(s).`);
  process.exit(1);
}
console.log(`\nContract check PASSED: ${passes.length} check(s), 0 violations.`);
