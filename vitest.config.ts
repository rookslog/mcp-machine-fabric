import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { exclude: process.env.MMF_RACE_STRESS === "1" ? [] : ["test/**/*.stress.test.ts"], include: ["test/**/*.test.ts"], testTimeout: 30000, hookTimeout: 30000, pool: "forks" },
});
