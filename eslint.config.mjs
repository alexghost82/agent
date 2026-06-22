// Root ESLint flat config (ESLint 9 / Next.js 16).
//
// Next 16 removed the `next lint` command, so linting is driven directly by the
// ESLint CLI against this flat config. eslint-config-next@16 ships native flat
// config arrays, so we compose them directly instead of going through the
// legacy FlatCompat shim.
//
// Scope: the Next.js frontend under `app/**` plus root-level tooling. The
// `functions/` package owns its own `functions/eslint.config.js`, so it is
// ignored here to avoid double-linting with conflicting rules.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // The functions package is a separate workspace with its own flat config.
      "functions/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Keep stylistic / non-correctness findings as warnings so the mandatory
    // gate fails on real problems rather than churn across the existing tree.
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // react-hooks@7 promotes these React Compiler heuristics to errors. They
      // flag legitimate existing patterns (e.g. localStorage hydration, range
      // clamping) that are not safely autofixable, so keep them visible as
      // warnings rather than rewriting working component logic.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
