# Encryption Key Versioning & Rotation

Per-user secrets (provider API keys and the GitHub PAT) are encrypted at rest
with **AES-256-GCM** in `functions/src/crypto.ts`. This note describes the key
versioning scheme and the rotation runbook.

## Versioning scheme

Each 32-byte AES key is derived as `sha256(<master secret>)`. Multiple master
secrets can be configured at once, each identified by an integer **version**:

| Version | Master secret env var      | Notes                          |
| ------- | -------------------------- | ------------------------------ |
| v1      | `KEYS_ENC_SECRET`          | The original / legacy secret   |
| v2      | `KEYS_ENC_SECRET_V2`       | Added during a rotation        |
| v3      | `KEYS_ENC_SECRET_V3`       | …and so on                     |

- **Primary version** (used for *new* encryptions) is set by
  `KEYS_ENC_PRIMARY_VERSION` (an integer). It **defaults to `1`**, so behaviour
  is identical to before until an operator opts in.
- Every ciphertext is stamped with the version that produced it via an optional
  `v` field: `{ ciphertext, iv, tag, v }`.
- On decryption the key is selected by the stored `v`. **A record with no `v`
  field is legacy data and is decrypted with v1** (= `sha256(KEYS_ENC_SECRET)`),
  exactly as before versioning existed.

### Backward compatibility

- `EncryptedSecret` is a **superset** of the old `{ciphertext,iv,tag}` shape —
  `v` is optional. Existing Firestore documents read and decrypt unchanged.
- `encryptSecret(plaintext)` and `decryptSecret(payload)` keep their original
  signatures (`encryptSecret` gains an *optional* second `version` arg used only
  by tests/tooling). `last4()` is unchanged. Callers in `routes/keys.ts`,
  `routes/projects.ts`, `tasks.ts`, and `ai.ts` compile and behave unchanged —
  they store/spread the returned object and read `ciphertext`/`iv`/`tag`.

## Rotation runbook

Goal: move all stored secrets from the old key to a new one **without ever
losing the ability to decrypt existing data**.

1. **Add the new secret (decrypt-only at first).**
   Set `KEYS_ENC_SECRET_V2` in the environment. Leave
   `KEYS_ENC_PRIMARY_VERSION` unset/`1`. Deploy. Nothing changes yet — v2 is
   available but unused.

2. **Promote v2 to primary.**
   Set `KEYS_ENC_PRIMARY_VERSION=2` and deploy. **Keep `KEYS_ENC_SECRET` (v1)
   configured.** From now on:
   - new writes are stamped `v: 2`;
   - old `v: 1` / legacy records still decrypt via the still-present v1 secret.

3. **Re-encrypt existing data** with the migration helper
   (`functions/scripts/rotate-keys.ts`):

   ```bash
   cd functions
   export KEYS_ENC_SECRET=...            # v1, still required to read old data
   export KEYS_ENC_SECRET_V2=...         # v2
   export KEYS_ENC_PRIMARY_VERSION=2
   export GOOGLE_APPLICATION_CREDENTIALS=...   # or FIRESTORE_EMULATOR_HOST

   npx tsx scripts/rotate-keys.ts          # dry-run: preview only
   npx tsx scripts/rotate-keys.ts --apply  # perform the re-encryption
   ```

   The script decrypts each value with whatever version it carries and rewrites
   it under the primary version, preserving sibling metadata (`last4`,
   `updatedAt`). It is **dry-run by default**, **idempotent** (skips values
   already at the primary), and **never destructive** (a value that cannot be
   decrypted is reported and skipped, never overwritten). Use `--user=<uid>` to
   scope to one user and `--batch=<n>` to tune the page size.

4. **Verify** the apply run reports `failed (skipped): 0` and that
   `re-encrypted` covers the expected count. Re-run the dry-run; it should now
   report everything `already up-to-date`.

5. **Retire the old key.** Only after step 4 is clean for all data, remove
   `KEYS_ENC_SECRET`'s old value — i.e. set `KEYS_ENC_SECRET` to the v2 value
   and renumber, or drop v1 from your secret store. **Do not retire a version
   until you are certain no ciphertext still references it.**

## Risks & guardrails

- **Never lose a key version.** Any version that *might* still be referenced by
  stored ciphertext MUST stay configured. Decryption throws a clear
  `key version N is not available` error rather than guessing, and the
  migration script skips (never deletes) values it cannot decrypt. Retiring a
  key prematurely is the only way to cause permanent data loss — gate it on a
  clean migration run (step 4).
- **Order matters.** Add the new secret *before* promoting it to primary, and
  keep the old secret until re-encryption is verified complete.
- **Tampering** (modified `ciphertext`/`iv`/`tag`) is rejected by GCM
  authentication and surfaces as a decrypt error; callers already log
  `*_decrypt_failed` instead of silently dropping keys.
- **Legacy plaintext PATs.** A `githubToken` stored as a bare string predates
  encryption; the migration script leaves it untouched (it is re-encrypted
  naturally next time the user saves a token).
- **Credentials/availability.** The migration script reads/writes live
  Firestore; run it with proper credentials and prefer the dry-run first. It
  pages through `users` so large datasets are processed incrementally.
```
