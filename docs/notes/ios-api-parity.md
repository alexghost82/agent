# iOS ↔ Backend API parity

Verifies that the native iOS client (`ios/GhostAgent`) and the Cloud Functions
backend (`functions/src`) agree on the HTTP contract: endpoints, methods, the
`Authorization: Bearer <token>` auth header, JSON request body keys, response
shapes, and the stable error envelope.

- **iOS source:** `ios/GhostAgent/GhostAgent/APIClient.swift`,
  `…/Models.swift`, `…/AppModel.swift`, `…/AppConfig.swift`.
- **Backend source:** `functions/src/index.ts` (routing + `requireAuth`),
  `functions/src/routes/*`, `functions/src/schemas.ts` (zod request validation),
  `functions/src/errors.ts` (error envelope + codes).
- **Tests / fixtures:** `ios/contract/` (see "How to run" below).

## Conventions

| Aspect | Contract | iOS | Backend |
| --- | --- | --- | --- |
| Base URL | `…/api` (Hosting rewrites `/api/**` → `api` fn) | `AppConfig.apiBaseURL` (`GHOST_API_BASE_URL` or `https://agent-9d7c2.web.app/api`) | `index.ts` strips `/api` prefix |
| Auth header | `Authorization: Bearer <token>` | `APIClient.request` sets `authorization: Bearer …` when a token is passed | `auth.ts sessionTokenFromRequest` reads `req.headers.authorization` |
| Public endpoints | no bearer | `token: nil` on `/login`, `/auth/firebase` | mounted before `requireAuth` in `index.ts` |
| Error envelope | `{ "error": <code>, "requestId"?: <id> }` | `ErrorEnvelope` → `APIClientError.server(code, requestId, status)` | `errors.ts sendError` / public-route `AppError` branch |
| Error codes | union of 12 stable codes | opaque string | `errors.ts ErrorCode` |

HTTP header names are case-insensitive, so the iOS lowercase header names
(`authorization`, `content-type`, `accept`) are accepted by Express verbatim.

## Parity matrix — typed endpoints (dedicated Swift models)

| Endpoint | Method | Auth | Request fields (iOS → zod) | Response fields (decoded) | iOS model | Backend |
| --- | --- | --- | --- | --- | --- | --- |
| `/login` | POST | public | `username`, `password` → `LoginSchema` | `ok`, `token`, `user.username` (`user.role` ignored) | `LoginResponse`/`UserDTO` | `routes/public.ts` |
| `/auth/firebase` | POST | public | `idToken` → `FirebaseAuthSchema` | `ok`, `token`, `user.username` | `LoginResponse` | `routes/public.ts` |
| `/logout` | POST | bearer | _(no body)_ | `{ ok: true }` (ignored) | `EmptyResponse` | `routes/session.ts` |
| `/dashboard` | GET | bearer | — | `counts{…}`, `recentLogs[]` | `DashboardResponse` (typed, **unused**) / raw `JSONValue` (used) | `routes/dashboard.ts`, `stats.ts` |
| `/projects` | GET | bearer | — | `projects[]{ id, name, description?, stack?, repoUrl? }` | `ProjectsResponse`/`ProjectSummary` | `routes/projects.ts`, `listing.ts` |

## Parity matrix — raw-JSON endpoints (decoded into `JSONValue`, read by `AppModel`)

These go through `APIClient.getJSON/postJSON/patchJSON/putJSON/deleteJSON` and are
read field-by-field in `AppModel`/`ParityPanels.swift`. Request keys are validated
against `schemas.ts`.

| Endpoint | Method | Request keys (iOS) | Backend schema / route |
| --- | --- | --- | --- |
| `/topics` | GET / POST | `name`, `description?` | `TopicSchema`, `routes/topics.ts` |
| `/learn` | POST | `topicId`, `url`, `tags?` | `LearnSchema`, `routes/sources.ts` |
| `/sources` | GET | `?topicId=` | `routes/sources.ts` |
| `/sources/:id/reingest`, `/sources/:id` | POST / DELETE | — | `routes/sources.ts` |
| `/extract-skills` | POST | `topicId` | `ExtractSkillsSchema`, `routes/skills.ts` |
| `/skills` | GET | `?topicId=` | `routes/skills.ts` |
| `/skills/:id` | PATCH / DELETE | `skillName`, `description`, `example?` | `routes/skills.ts` |
| `/projects` | POST / PATCH / DELETE | `name`, `description`, `stack?`, `repoUrl?`, `skillIds?` | `ProjectSchema`/`UpdateProjectSchema` |
| `/github-token` | POST | `token` | `GithubTokenSchema` |
| `/projects/:id/connect-github` | POST | `repoUrl` | `ConnectGithubSchema` |
| `/ask` | POST | `question`, `lang` | `AskSchema`, `routes/ask.ts` |
| `/design` | POST | `projectId`, `section?`, `lang` | `DesignSchema`, `routes/design.ts` |
| `/generate-plan` | POST | `projectId`, `instructions?`, `lang` | `GeneratePlanSchema`, `routes/plans.ts` |
| `/generated-plans` | GET | `?projectId=` | `routes/plans.ts` |
| `/builds`, `/builds/:id` | GET | `?projectId=` | `routes/build.ts` |
| `/projects/:id/build` | POST | `planId?`, `instructions?`, `lang` | `BuildSchema`, `routes/build.ts` |
| `/memory`, `/memory/:id` | GET / DELETE | `?topicId=&projectId=` | `routes/memory.ts` |
| `/me/api-keys` | GET / PUT | `openai?`, `gemini?`, `provider?` | `ApiKeysSchema`, `routes/keys.ts` |
| `/me/api-keys/test` | POST | `provider` | `TestKeySchema`, `routes/keys.ts` |

## Discrepancies / findings (report only — no backend changes)

> These are recorded as follow-ups, not fixed here (ownership: tests only).
> The runnable parity suites assert the **current** behavior so any future fix
> flips a guard test and prompts updating this note.

1. **`DashboardResponse.Counts` keys don't match the backend (typed model).**
   Backend `stats.ts` returns `knowledge_chunks`, `agent_skills`,
   `project_decisions`, `generated_plans`, `agent_logs`, but `Models.swift`
   `DashboardResponse.Counts` is keyed `chunks`, `skills`, `decisions`, `plans`,
   `logs`. As `Int?`, those 5 silently decode to `nil` (verified by
   `DiscrepancyGuardTests.testTypedDashboardCountsDropRenamedBackendKeys`).
   **Impact:** latent — the shipping UI reads the raw `JSONValue` tree with the
   correct keys (`OverviewParityPanel.statMap`), so the screen is correct today.
   **Follow-up:** rename the struct keys (or add `CodingKeys`) and adopt the
   typed model, or delete the dead typed model to avoid the trap.

2. **`AgentLog.createdAt: String?` can't decode a Firestore `Timestamp`.**
   `res.json` serializes a Firestore `Timestamp` as `{ _seconds, _nanoseconds }`,
   but `recentLogs[].createdAt` is typed `String?`; `decodeIfPresent(String)`
   throws on the type mismatch. So `APIClient.dashboard()` (which decodes
   `DashboardResponse` including `[AgentLog]`) cannot decode a real payload
   (verified by `…testTypedDashboardThrowsOnFirestoreTimestampLogs`).
   **Impact:** latent — `APIClient.dashboard()` is currently unused (the app uses
   `getJSON("/dashboard")` + raw access). **Follow-up:** model timestamps with a
   flexible decoder or drop the typed dashboard model.

3. **`user.role` is dropped on login.** Backend `/login` returns
   `user: { username, role }`, but `UserDTO` only models `username`
   (`…testLoginResponseDropsUserRole`). The client cannot distinguish
   admin/member. **Follow-up:** add `role` to `UserDTO` if role-gated UI is
   needed (note `/auth/firebase` does not return `role`).

4. **Two parallel decoding strategies.** Typed DTOs exist for
   `dashboard`/`projects` in `APIClient`, but `AppModel` consumes those endpoints
   as raw `JSONValue`. `ProjectsResponse`/`ProjectSummary` happen to match the
   backend (verified), but the dashboard typed model has diverged (findings 1–2).
   **Follow-up:** standardize on one strategy to prevent silent drift.

5. **Intentional, non-defect omissions.** `EmptyResponse` ignores the
   `{ ok: true }` logout body. This is forward-compatible and fine.

## How to run

No-Xcode contract check (fixtures vs derived contract):

```bash
node ios/contract/validate.mjs
```

Host-side Swift parity tests against the real `APIClient`/`Models` (no simulator):

```bash
cd ios && swift test
```

Full XCTest suite on a simulator / Xcode Cloud (app target):

```bash
cd ios/GhostAgent
xcodegen generate
xcodebuild -scheme GhostAgent -destination 'platform=iOS Simulator,name=iPhone 16' test
```
