import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/run-builder.mjs", import.meta.url).href;

type RunnerModule = Readonly<{
  createBuilderInvocation(target: string): Readonly<{ executable: string; args: readonly string[]; environment: Readonly<Record<string, string>> }>;
}>;

async function loadModule(): Promise<RunnerModule> {
  return await import(moduleUrl) as RunnerModule;
}

describe("safe electron-builder runner", () => {
  it("uses one fixed native target invocation and always disables publishing", async () => {
    const { createBuilderInvocation } = await loadModule();
    expect(createBuilderInvocation("windows").args).toEqual(["--config", "electron-builder.config.cjs", "--win", "nsis", "--x64", "--publish", "never"]);
    expect(createBuilderInvocation("macos").args).toEqual(["--config", "electron-builder.config.cjs", "--mac", "dmg", "zip", "--universal", "--publish", "never"]);
    expect(createBuilderInvocation("linux").args).toEqual(["--config", "electron-builder.config.cjs", "--linux", "AppImage", "deb", "--x64", "--publish", "never"]);
    expect(() => createBuilderInvocation("all")).toThrow();
  });
});
