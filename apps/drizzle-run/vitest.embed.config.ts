import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/embed-loader/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/embed-loader/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}"],
      reporter: ["text-summary"],
      // Floors just under the coverage measured when they were set; raise them as tests land.
      thresholds: {
        statements: 93,
        branches: 88,
        functions: 99,
        lines: 93,
      },
    },
  },
});
