# API

All endpoints are served by Firebase Functions under `/api`. Every endpoint
except `GET /health` and `POST /login` requires `Authorization: Bearer <token>`
(the token returned by `/login`). All data is isolated per user.

## Basic

- `GET /health`
- `POST /login` -> `{ token, user }`
- `GET /dashboard` (counts + recent logs for the current user)

## Topics & sources

- `POST /topics` `{ name, description? }`
- `GET /topics`
- `POST /learn` `{ topicId, url, tags? }` (SSRF-guarded fetch + embedding)
- `GET /sources?topicId=`

## Skills

- `POST /extract-skills` `{ topicId }` (generates skills from a topic's knowledge)
- `POST /skill` `{ topicId, skillName, description, example? }` (manual)
- `GET /skills?topicId=`

## Projects & GitHub (read-only)

- `POST /projects` `{ name, description, stack?, repoUrl? }`
- `GET /projects`
- `PATCH /projects/:id` `{ skillIds?, name?, description?, stack?, repoUrl? }`
- `POST /github-token` `{ token }` (stored server-side only)
- `POST /projects/:id/connect-github` `{ repoUrl }`
  - Read-only: GET requests to the GitHub API only. The agent never writes to the repo.

## Ask

- `POST /ask` `{ question, limit? }`

## Design

- `POST /design` `{ projectId, section? }`
- `GET /design?projectId=`

## Plan

- `POST /generate-plan` `{ projectId, instructions? }` -> `{ files: [{path, content}], prompts: [{title, content}] }`
- `GET /generated-plans?projectId=`
