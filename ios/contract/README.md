# iOS ↔ backend contract harness

Verifies the GhostAgent iOS client and the Cloud Functions backend agree on the
HTTP contract (endpoints, methods, `Authorization: Bearer` auth, JSON body keys,
response shapes, and the `{ error, requestId }` envelope).

Source of truth: `functions/src/routes/*`, `functions/src/schemas.ts`,
`functions/src/errors.ts`, and `docs/API.md`. The full parity matrix and the
known discrepancies are in [`docs/notes/ios-api-parity.md`](../../docs/notes/ios-api-parity.md).

## Layout

- `contract.json` — derived, machine-readable description of every endpoint the
  iOS client calls (request fields, response schema, error envelope, error codes).
- `fixtures/*.json` — recorded payloads that mirror the backend's real responses
  and error envelope (including Firestore `Timestamp` objects and `null`s).
- `validate.mjs` — Node validator (no deps) that checks the fixtures against
  `contract.json`.
- `SwiftContractTests/` — XCTest target (see `ios/Package.swift`) that drives the
  **real** `APIClient`/`Models` against the fixtures.

## Run the no-Xcode contract check (CI without Xcode)

```bash
node ios/contract/validate.mjs
```

Exits non-zero on any contract violation.

## Run the Swift parity tests on the host (no Xcode/simulator needed)

`ios/Package.swift` compiles the real `APIClient.swift` + `Models.swift` and runs
the parity suite with the host toolchain:

```bash
cd ios && swift test
```

This exercises request building (path, method, Bearer header, body keys) and
response decoding/error mapping against `fixtures/`.

## Run the full XCTest suite in Xcode / Xcode Cloud

The same parity assertions also live in the app's unit-test target so they run on
a simulator against the shipping app target:

```bash
cd ios/GhostAgent
xcodegen generate
xcodebuild -scheme GhostAgent -destination 'platform=iOS Simulator,name=iPhone 16' test
```

`APIParityTests.swift` (in `GhostAgentTests/`) is picked up automatically by the
folder-based `project.yml` source rule.
