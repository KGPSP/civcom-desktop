import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/live/**/*.live.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
});
