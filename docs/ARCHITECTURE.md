# AI Builder Agent PRO Architecture

## Core loop

```text
Research -> Knowledge Memory -> Skill Memory -> Decision Memory -> Plan -> Generate -> Review -> Approval -> Execute -> Test -> Log -> Improve
```

## Firestore collections

- `sources` — studied websites and metadata.
- `knowledge_chunks` — factual memory chunks with embeddings.
- `agent_skills` — procedural memory: learned methods and patterns.
- `project_decisions` — architectural decisions and reasons.
- `build_tasks` — backlog: todo/in_progress/review/approved/done.
- `approvals` — human approval queue.
- `generated_code` — code drafts and implementation plans.
- `reviews` — code/product/architecture reviews.
- `security_reviews` — security checks.
- `agent_logs` — audit trail.

## Agent roles

- Researcher: learns sites and docs.
- Analyst: extracts requirements and patterns.
- Architect: designs modules, APIs, DB and screens.
- Coder: generates code plans and patches.
- Reviewer: finds bugs, gaps, weak assumptions.
- Security: checks secrets, permissions, prompt injection and unsafe actions.
- Manager: tracks tasks, statuses and approvals.

## Safety model

The agent should never directly change production. Dangerous actions require a record in `approvals` and explicit approval.

High-risk actions:

- applying generated code;
- changing Firestore rules;
- deleting data;
- deployments;
- adding payment/auth logic;
- changing secrets.
