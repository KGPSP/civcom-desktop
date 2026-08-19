import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/release-artifacts.mjs", import.meta.url).href;

type ReleaseArtifactsModule = Readonly<{
  createSbomInvocation(environment: Readonly<Record<string, string | undefined>>): Readonly<{ command: string; args: readonly string[] }>;
  generateChecksums(directory: string): Promise<void>;
}>;

async function loadModule(): Promise<ReleaseArtifactsModule> {
  return await import(moduleUrl) as ReleaseArtifactsModule;
}

describe("release artifact generation", () => {
  it("writes reproducible SHA-256 and MD5 manifests for every non-manifest release asset", async () => {
    const { generateChecksums } = await loadModule();
    const root = await mkdtemp(join(tmpdir(), "civcom-release-checksums-"));
    const downloads = JSON.parse(await readFile(new URL("../docs/downloads.json", import.meta.url), "utf8")) as { assets: Record<string, string> };
    const payloadNames = Object.entries(downloads.assets)
      .filter(([key]) => key !== "checksums" && key !== "md5Checksums")
      .map(([, name]) => name)
      .sort();
    for (const name of payloadNames) await writeFile(join(root, name), name);

    await expect(generateChecksums(root)).resolves.toBeUndefined();

    const expected = (algorithm: "sha256" | "md5"): string => `${payloadNames.map((name) => `${createHash(algorithm).update(name).digest("hex")}  ${name}`).join("\n")}\n`;
    await expect(readFile(join(root, "SHA256SUMS"), "utf8")).resolves.toBe(expected("sha256"));
    await expect(readFile(join(root, "MD5SUMS"), "utf8")).resolves.toBe(expected("md5"));
  });

  it("generates the build supply-chain SPDX with development build dependencies included", async () => {
    const { createSbomInvocation } = await loadModule();
    expect(createSbomInvocation({ npm_execpath: "/opt/npm-cli.js" })).toEqual({
      command: process.execPath,
      args: ["/opt/npm-cli.js", "sbom", "--sbom-format=spdx"]
    });
    expect(() => createSbomInvocation({})).toThrow();
  });
});
