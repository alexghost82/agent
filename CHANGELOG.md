# Changelog

## 2.0.0

Changed:

- per-user data isolation (every document scoped by `userId`);
- enforced Bearer-token auth on all endpoints;
- topics that group sources and produce skills;
- read-only GitHub project understanding (never writes to the repo);
- project skill selection;
- Design Platform now works per project (with optional section);
- new Plan step that generates md files and agent prompts.

Removed:

- Approvals, Review and Generate code steps/endpoints.

Security:

- scrypt password hashing, seed users from env;
- SSRF guard on URL fetching;
- rate limiting on heavy endpoints;
- Firestore rules deny direct client access;
- CI secret scan and functions tests.

## 1.0.0-pro

Initial PRO release: backlog tasks, approvals, critic-before-action, reviewer,
security review, dashboard, agent logs, docs, GitHub CI workflow.
