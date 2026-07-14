import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/globalSetup.ts"],
    testTimeout: 30000,
    hookTimeout: 6 * 60 * 1000, // allow the one-time reference build
  },
});
