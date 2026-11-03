import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "og/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "src/embed-loader/**"],
    environment: "node",
  },
});
