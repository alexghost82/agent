const tseslint = require("typescript-eslint");

// Flat config (ESLint 9). Lints the TypeScript sources with the typescript-eslint
// parser. Kept intentionally lean so it focuses on real correctness issues
// rather than stylistic churn across the existing codebase.
module.exports = tseslint.config(
  {
    ignores: ["lib/**", "node_modules/**"]
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  }
);
