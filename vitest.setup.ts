// Extends Vitest's `expect` with @testing-library/jest-dom matchers
// (e.g. toBeInTheDocument). The `/vitest` entrypoint also augments Vitest's
// Assertion types so the matchers type-check under `tsc --noEmit`.
import "@testing-library/jest-dom/vitest";
