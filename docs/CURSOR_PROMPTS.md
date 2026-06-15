# Cursor prompts

Use these in Cursor Agent mode.

## Add feature safely

```text
You are working on AI Builder Agent PRO.
Before changing files, read docs/ARCHITECTURE.md and docs/API.md.
Make the smallest safe change.
Do not remove existing endpoints.
Add tests or manual verification steps.
Explain risks and rollback.
```

## Review generated code

```text
Review this project as a senior TypeScript/Firebase engineer.
Find runtime bugs, missing validation, security issues, Firestore rule problems, and deployment problems.
Return a prioritized fix list.
```

## Build next module

```text
Implement the next module using existing style.
Requirements:
- no production destructive actions;
- approval required for risky actions;
- add logs;
- update docs;
- keep UI simple.
```
