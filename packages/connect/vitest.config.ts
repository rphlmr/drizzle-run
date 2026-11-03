import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["**/*.test.{ts,tsx}"],
      reporter: ["text-summary"],
      // Floors just under the coverage measured when they were set; raise them as tests land.
      thresholds: {
        statements: 76,
        branches: 71,
        functions: 77,
        lines: 77,
      },
    },
  },
});
