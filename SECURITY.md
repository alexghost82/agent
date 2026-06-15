# Security notes

- Do not expose `OPENAI_API_KEY` to the browser.
- Keep model calls inside Firebase Functions.
- Use Firebase Auth before production.
- Keep Firestore rules locked to signed-in users.
- Never let the agent delete data, deploy, modify billing, or apply code without approval.
- Store generated code as draft until reviewed.
- Use GitHub pull requests for every code change.
- Add secret scanning before deploying.
