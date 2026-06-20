import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Integration suites drive the real routers against the Firestore emulator
    // and the build step runs a real `tsc` verification; under full-suite load
    // the default 5s per-test timeout is too tight (heavy steps observed ~5.1s).
    testTimeout: 30_000
  }
});
