/**
 * Commitlint configuration for the GHOST Agent Builder.
 *
 * Enforces the Conventional Commits specification (https://www.conventionalcommits.org)
 * both locally (via the optional husky `commit-msg` hook) and in CI (the
 * `commit-lint` job in .github/workflows/ci.yml).
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allowed commit types for this project.
    'type-enum': [
      2,
      'always',
      [
        'feat', // a new feature
        'fix', // a bug fix
        'docs', // documentation only changes
        'chore', // tooling / maintenance with no src or test changes
        'refactor', // code change that neither fixes a bug nor adds a feature
        'test', // adding or correcting tests
        'perf', // performance improvement
        'build', // build system or external dependency changes
        'ci', // CI configuration / scripts
        'style', // formatting, white-space, semicolons (no code meaning change)
        'revert', // reverts a previous commit
      ],
    ],
    // A type is mandatory and must be lower-case.
    'type-empty': [2, 'never'],
    'type-case': [2, 'always', 'lower-case'],
    // Subject is mandatory; keep it sentence-friendly but not Title/UPPER cased.
    'subject-empty': [2, 'never'],
    'subject-case': [
      2,
      'never',
      ['sentence-case', 'start-case', 'pascal-case', 'upper-case'],
    ],
    'subject-full-stop': [2, 'never', '.'],
    // Keep headers and body lines reasonable.
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 100],
  },
};
