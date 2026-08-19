import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/verify-workflows.mjs", import.meta.url).href;

type WorkflowModule = Readonly<{
  validateWorkflowSource(name: string, source: string): void;
  validateRepositoryAutomation(rootDirectory: string): Promise<void>;
}>;

async function loadModule(): Promise<WorkflowModule> {
  return await import(moduleUrl) as WorkflowModule;
}

describe("GitHub automation policy", () => {
  it("uses only declared dependencies and its checked-in strict YAML parser", () => {
    const require = createRequire(import.meta.url);
    const packageJson = require("../package.json") as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect({ ...packageJson.dependencies, ...packageJson.devDependencies }).not.toHaveProperty("js-yaml");
    const verifier = readFileSync(new URL("../scripts/verify-workflows.mjs", import.meta.url), "utf8");
    expect(verifier).not.toMatch(/require\(["']js-yaml["']\)|from ["']js-yaml["']/);
    expect(verifier).toContain("parseStrictYaml");
  });
  it("accepts the checked-in least-privilege CI, pilot, release, and Dependabot configuration", async () => {
    const { validateRepositoryAutomation } = await loadModule();
    await expect(validateRepositoryAutomation(new URL("..", import.meta.url).pathname)).resolves.toBeUndefined();
  });

  it("pins runner images, scopes checkout jobs to contents read, handles the p8 as a temporary file, and verifies attestations", async () => {
    const { validateRepositoryAutomation } = await loadModule();
    const root = new URL("..", import.meta.url);
    const [ci, pilot, release] = await Promise.all([
      readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
      readFile(new URL(".github/workflows/pilot.yml", root), "utf8"),
      readFile(new URL(".github/workflows/release.yml", root), "utf8")
    ]);
    await expect(validateRepositoryAutomation(root.pathname)).resolves.toBeUndefined();
    expect(`${ci}\n${pilot}\n${release}`).not.toMatch(/windows-latest|ubuntu-latest/);
    expect(pilot).toContain("windows-2025");
    expect(pilot).toContain("ubuntu-24.04");
    expect(release).toContain("CIVCOM_APPLE_API_KEY_CONTENT: ${{ secrets.CIVCOM_APPLE_API_KEY }}");
    expect(release).toContain("$RUNNER_TEMP/civcom-notarization-key.p8");
    expect(release).toContain("chmod 0600");
    expect(release).toContain('test -s "$key_path"');
    expect(release).toContain("if: always()");
    expect(release).toContain("gh attestation verify");
    expect(release).toContain("node scripts/stage-platform-artifacts.mjs windows");
    expect(release).toContain("node scripts/stage-platform-artifacts.mjs macos");
    expect(release).toContain("node scripts/stage-platform-artifacts.mjs linux");
    expect(pilot).toContain("node scripts/stage-platform-artifacts.mjs ${{ matrix.target }}");
    expect(`${pilot}\n${release}`).not.toMatch(/^\s+path:\s+release\/\s*$/m);
  });

  it("rejects mutable actions, write-capable pilots, PR secrets, release publication in pilots, and non-draft-first production", async () => {
    const { validateWorkflowSource } = await loadModule();
    const pilot = await readFile(new URL("../.github/workflows/pilot.yml", import.meta.url), "utf8");
    const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    for (const hostile of [
      pilot.replace("name: Unsigned pilot packages", "name Unsigned pilot packages"),
      pilot.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v7"),
      pilot.replace("permissions: {}", "permissions:\n  contents: write"),
      pilot.replace("workflow_dispatch:", "pull_request_target:"),
      pilot.replace("CIVCOM_BUILD_MODE: pilot", "CIVCOM_BUILD_MODE: ${{ secrets.BUILD_MODE }}"),
      `${pilot}\n# gh release create\n`,
      pilot.replace("retention-days: 14", "retention-days: 90")
    ]) expect(() => validateWorkflowSource("pilot.yml", hostile)).toThrow();
    for (const hostile of [
      release.replace("draft", "publish-immediately"),
      release.replace("cancel-in-progress: false", "cancel-in-progress: true"),
      release.replace("environment: production-release", "environment: test"),
      release.replace("permissions: {}", "permissions:\n  contents: write"),
      release.replace('test -s "$key_path"', ":")
    ]) expect(() => validateWorkflowSource("release.yml", hostile)).toThrow();
  });
});
