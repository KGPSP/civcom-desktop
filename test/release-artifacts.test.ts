import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/release-artifacts.mjs", import.meta.url).href;

type ReleaseArtifactsModule = Readonly<{
  createSbomInvocation(environment: Readonly<Record<string, string | undefined>>): Readonly<{ command: string; args: readonly string[] }>;
}>;

async function loadModule(): Promise<ReleaseArtifactsModule> {
  return await import(moduleUrl) as ReleaseArtifactsModule;
}

describe("release artifact generation", () => {
  it("generates the build supply-chain SPDX with development build dependencies included", async () => {
    const { createSbomInvocation } = await loadModule();
    expect(createSbomInvocation({ npm_execpath: "/opt/npm-cli.js" })).toEqual({
      command: process.execPath,
      args: ["/opt/npm-cli.js", "sbom", "--sbom-format=spdx"]
    });
    expect(() => createSbomInvocation({})).toThrow();
  });
});
