# API

All endpoints are served by Firebase Functions under `/api`.

## Basic

- `GET /health`
- `GET /dashboard`

## Research and memory

- `POST /learn`

```json
{ "url": "https://example.com", "tags": ["docs"], "topic": "platform" }
```

- `POST /ask`

```json
{ "question": "What did we learn?", "limit": 8 }
```

- `POST /skill`

```json
{ "skillName": "Onboarding design", "description": "...", "example": "..." }
```

## Planning and code

- `POST /plan-platform`

```json
{ "idea": "A platform for ..." }
```

- `POST /generate-code`

```json
{ "task": "Build auth module", "stack": "Next.js + Firebase", "createApproval": true }
```

## Tasks

- `POST /tasks`
- `GET /tasks`
- `POST /execute-task`

```json
{ "taskId": "..." }
```

## Approval flow

- `POST /approvals`
- `GET /approvals`
- `POST /approval-decision`

```json
{ "approvalId": "...", "decision": "approved", "comment": "OK" }
```

## Review

- `POST /review`
- `POST /security-review`
