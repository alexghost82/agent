import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Frontend-only test config: scoped to the Next.js web client in app/**.
// jsdom gives us a DOM for React Testing Library; the setup file wires up
// @testing-library/jest-dom matchers.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
    css: false
  }
});
