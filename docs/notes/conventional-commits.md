# Conventional Commits

This repository enforces the [Conventional Commits](https://www.conventionalcommits.org)
specification for every commit message, locally (optional git hook) and in CI
(mandatory gate).

## Accepted format

```
<type>(<optional scope>): <subject>

<optional body>

<optional footer(s)>
```

- **type** — required, lower-case, one of the allowed types below.
- **scope** — optional, in parentheses, e.g. `feat(api): ...`.
- **subject** — required, imperative mood, no trailing period, not Title/UPPER cased.
- **header** (`type(scope): subject`) — max **100** characters.
- **body** — optional; wrap lines at **100** characters. Separate from the header with a blank line.
- **breaking changes** — add `!` after the type/scope (`feat!: ...`) and/or a
  `BREAKING CHANGE:` footer.

### Allowed types

| Type       | Use for                                                        |
| ---------- | ------------------------------------------------------------- |
| `feat`     | A new feature                                                 |
| `fix`      | A bug fix                                                     |
| `docs`     | Documentation only changes                                    |
| `chore`    | Tooling / maintenance with no src or test changes            |
| `refactor` | Code change that neither fixes a bug nor adds a feature       |
| `test`     | Adding or correcting tests                                    |
| `perf`     | A performance improvement                                     |
| `build`    | Build system or external dependency changes                   |
| `ci`       | CI configuration / scripts                                    |
| `style`    | Formatting / white-space (no code-meaning change)            |
| `revert`   | Reverts a previous commit                                     |

## Examples

Valid:

```
feat: add conventional-commit validation to CI
fix(ingest): handle empty GitHub payloads
docs: document the commit-message gate
ci(commitlint): lint the full PR commit range
refactor(api)!: drop the deprecated v1 response shape
```

Invalid:

```
bad message                  # no type
Feat: Add Thing.             # type not lower-case, subject Title-cased + trailing period
update stuff                 # not a recognized type
```

## How the CI gate works

The `commit-lint` job in `.github/workflows/ci.yml` runs on every push and pull
request:

- **Pull requests** — lints the full range
  `origin/${{ github.base_ref }}..HEAD`, so every commit in the PR is checked.
- **Pushes** — lints the pushed range (`github.event.before..github.event.after`),
  or, for a brand-new branch with no `before` ref, validates at least the tip
  commit via `commitlint --last`.

It installs root dependencies and invokes `npx --no-install commitlint` against
`commitlint.config.cjs`. Any non-conventional message fails the build. This job
is additive — it does not affect the existing lint, coverage, or secret-scan
gates.

## Enable the local hook (optional, recommended)

A husky `commit-msg` hook is provided at `.husky/commit-msg`. To activate it:

```bash
npm install   # runs the `prepare` script, which sets up husky
```

The `prepare` script (`husky || true`) is intentionally tolerant: in
environments without git or git hooks (e.g. CI, shallow checkouts) it never
breaks `npm install`.

After setup, a bad message is rejected at commit time:

```bash
git commit -m "bad message"   # blocked by commit-msg hook
git commit -m "feat: add x"   # accepted
```

### Manual hook (alternative to husky)

If you prefer not to use husky, add a `commit-msg` hook directly:

```bash
cat > .git/hooks/commit-msg <<'EOF'
#!/bin/sh
npx --no-install commitlint --edit "$1"
EOF
chmod +x .git/hooks/commit-msg
```

## Validate a message manually

```bash
echo "feat: add x"   | npx --no-install commitlint   # passes
echo "bad message"   | npx --no-install commitlint   # fails
```
