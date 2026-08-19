import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

type TestConfig = Readonly<{ test?: Readonly<Record<string, unknown>> }>;

async function loadConfig(path: string): Promise<TestConfig> {
  return await import(new URL(path, import.meta.url).href).then((module) => module.default as TestConfig).catch(() => Object.freeze({}));
}

describe("separated test execution layers", () => {
  it("keeps Electron and live tests out of the default unit suite", async () => {
    const config = await loadConfig("../vitest.config.ts");
    expect(config.test?.include).toEqual(["test/**/*.test.ts"]);
    expect(config.test?.exclude).toEqual(["test/**/*.electron.test.ts", "test/live/**/*.live.test.ts"]);
  });

  it("uses exact serial, no-retry special suites", async () => {
    const electron = await loadConfig("../vitest.electron.config.ts");
    const live = await loadConfig("../vitest.live.config.ts");
    expect(electron.test).toMatchObject({ include: ["test/**/*.electron.test.ts"], fileParallelism: false, maxWorkers: 1, retry: 0, testTimeout: 60_000 });
    expect(live.test).toMatchObject({ include: ["test/live/**/*.live.test.ts"], fileParallelism: false, maxWorkers: 1, retry: 0, testTimeout: 60_000 });
  });

  it("requires a fresh build for explicit layers and never reaches live or manual checks from default verification", () => {
    const packageJson = require("../package.json") as { scripts: Record<string, string> };
    expect(packageJson.scripts["test:electron:local"]).toBe("npm run build && vitest run --config vitest.electron.config.ts");
    expect(packageJson.scripts["test:live:anonymous"]).toBe("npm run build && vitest run --config vitest.live.config.ts");
    expect(packageJson.scripts["test:manual:production"]).toBe("npm run build && node scripts/manual-production-check.mjs");
    expect(packageJson.scripts.test).toBe("vitest run");
    expect(packageJson.scripts.verify).not.toMatch(/test:live:anonymous|test:manual:production/);
  });
});
