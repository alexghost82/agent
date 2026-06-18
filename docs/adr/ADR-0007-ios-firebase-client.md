# ADR-0007 — Native iOS client with Firebase app registration

- **Status:** Accepted
- **Owner:** Architect
- **Affects:** `ios/GhostAgent/**`, `docs/API.md`, `docs/CONTRACT.md`, `docs/RUNBOOK.md`, Firebase Console app registration

## Context

The repository currently contains a Next.js client, Firebase Hosting, Cloud
Functions, and Firestore rules that deny all direct client access. The new iOS
application must appear as an app in Firebase Console and reuse the existing
backend without weakening tenant isolation.

## Decision

Create a native SwiftUI iOS client in `ios/GhostAgent` with bundle id
`com.ghostagnt.ghost` and minimum deployment target iOS 17.0.

The app initializes Firebase through `FirebaseApp.configure()` using a local
`GoogleService-Info.plist` retrieved by Firebase CLI:

```bash
npx -y firebase-tools@latest apps:sdkconfig IOS <APP_ID> --project <PROJECT_ID>
```

Dependencies are managed with Swift Package Manager via XcodeGen. The initial
Firebase products are `FirebaseCore` and `FirebaseAuth`; `FirebaseFirestore` is
intentionally excluded from the app target.

The first backend-compatible auth flow uses the existing `POST /login` bearer
session. Firebase Auth is initialized so Console registration and future
Firebase ID token auth can be added without reworking app startup, but Backend
must ship ID token verification before the mobile app uses Firebase ID tokens
for protected API calls.

## Consequences

- **Positive:** iOS can be built and tested independently while reusing the
  existing Cloud Functions API.
- **Positive:** Firestore rules remain deny-all for direct clients.
- **Positive:** Firebase Console will show the native app once registered with
  the agreed bundle id.
- **Negative:** A temporary session-token auth bridge remains until Backend adds
  Firebase ID token verification.
- **Negative:** Local developers must fetch their own `GoogleService-Info.plist`
  before runtime Firebase initialization can fully succeed.

## Impact on files

- `ios/GhostAgent/project.yml` — XcodeGen project definition and Firebase SPM
  dependencies.
- `ios/GhostAgent/GhostAgent/**` — SwiftUI app, Firebase bootstrap, API client,
  Keychain session storage.
- `docs/RUNBOOK.md` — CLI registration and config retrieval workflow.
- `docs/CONTRACT.md` — iOS client contract and API expectations.
