import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/release-automation.mjs", import.meta.url).href;
const preflightModuleUrl = new URL("../scripts/release-preflight.mjs", import.meta.url).href;

type GitRunner = (command: string, args: readonly string[], options: Readonly<Record<string, unknown>>) => Readonly<{ error?: unknown; status: number | null }>;

type ReleaseAutomation = Readonly<{
  validateReleasePreflight(input: Readonly<Record<string, unknown>>): void;
  stagePlatformArtifacts(sourceDirectory: string, outputDirectory: string, platform: string, contractValue: unknown): Promise<void>;
  assembleRelease(inputDirectory: string, outputDirectory: string, contractValue: unknown): Promise<void>;
  createPublicationPlan(mode: string, input: Readonly<Record<string, unknown>>): Readonly<{ commands: readonly Readonly<{ command: string; args: readonly string[] }>[] }>;
}>;

async function loadModule(): Promise<ReleaseAutomation> {
  return await import(moduleUrl) as ReleaseAutomation;
}

async function loadPreflightModule(): Promise<Readonly<{ inspectMainAncestry(run?: GitRunner): boolean }>> {
  return await import(preflightModuleUrl) as Readonly<{ inspectMainAncestry(run?: GitRunner): boolean }>;
}

const assets = Object.freeze({
  windowsInstaller: "CivCom-Windows-x64.exe",
  windowsBlockmap: "CivCom-Windows-x64.exe.blockmap",
  windowsMetadata: "latest.yml",
  macDmg: "CivCom-macOS-universal.dmg",
  macZip: "CivCom-macOS-universal.zip",
  macBlockmap: "CivCom-macOS-universal.zip.blockmap",
  macMetadata: "latest-mac.yml",
  linuxAppImage: "CivCom-Linux-x86_64.AppImage",
  linuxDeb: "CivCom-Linux-x86_64.deb",
  linuxMetadata: "latest-linux.yml",
  buildSbom: "CivCom-build.spdx.json",
  checksums: "SHA256SUMS",
  md5Checksums: "MD5SUMS"
});

const contract = Object.freeze({ schemaVersion: 1, releaseBaseUrl: "https://github.com/KGPSP/civcom-desktop/releases/latest/download", latestReleaseUrl: "https://github.com/KGPSP/civcom-desktop/releases/latest", assets });
const sha = "a".repeat(40);

describe("protected release automation", () => {
  it("accepts only a protected push tag matching package/lock versions, exact SHA, clean tree, and production mode", async () => {
    const { validateReleasePreflight } = await loadModule();
    const valid = { eventName: "push", refType: "tag", refName: "v0.1.0", refProtected: "true", githubSha: sha, headSha: sha, mainAncestor: true, packageVersion: "0.1.0", lockVersion: "0.1.0", releaseNotesVersion: "0.1.0", worktreeClean: true, buildMode: "production", repository: "KGPSP/civcom-desktop" };
    expect(() => validateReleasePreflight(valid)).not.toThrow();
    for (const changed of [
      { refProtected: "false" }, { refName: "v0.2.0" }, { githubSha: "b".repeat(40) }, { lockVersion: "0.2.0" }, { releaseNotesVersion: "0.2.0" },
      { mainAncestor: false }, { worktreeClean: false }, { buildMode: "pilot" }, { eventName: "workflow_dispatch" }, { repository: "attacker/fork" }
    ]) expect(() => validateReleasePreflight({ ...valid, ...changed })).toThrow();
  });

  it("checks tag ancestry against origin/main with a fixed non-shell git invocation", async () => {
    const { inspectMainAncestry } = await loadPreflightModule();
    const calls: unknown[][] = [];
    const ancestor = inspectMainAncestry((command, args, options) => {
      calls.push([command, args, options]);
      return { status: 0 };
    });
    expect(ancestor).toBe(true);
    expect(calls).toEqual([["git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], expect.objectContaining({ shell: false })]]);
    expect(inspectMainAncestry(() => ({ status: 1 }))).toBe(false);
    expect(() => inspectMainAncestry(() => ({ status: 2 }))).toThrow();
    expect(() => inspectMainAncestry(() => ({ status: null }))).toThrow();
    expect(() => inspectMainAncestry(() => ({ error: new Error("spawn failed"), status: null }))).toThrow();
  });

  it("stages only the exact regular canonical files for one platform", async () => {
    const { stagePlatformArtifacts } = await loadModule();
    const root = await mkdtemp(join(tmpdir(), "civcom-stage-"));
    const source = join(root, "release");
    const output = join(root, "staged", "windows");
    await mkdir(join(source, "win-unpacked"), { recursive: true });
    await writeFile(join(source, "win-unpacked", "CivCom.exe"), "unpacked");
    await writeFile(join(source, "builder-debug.yml"), "debug");
    for (const name of [assets.windowsInstaller, assets.windowsBlockmap, assets.windowsMetadata]) await writeFile(join(source, name), name);
    await expect(stagePlatformArtifacts(source, output, "windows", contract)).resolves.toBeUndefined();
    expect((await readdir(output)).sort()).toEqual([assets.windowsInstaller, assets.windowsBlockmap, assets.windowsMetadata].sort());
    await expect(stagePlatformArtifacts(source, output, "windows", contract)).rejects.toThrow();

    const hostileOutput = join(root, "staged", "hostile");
    await rm(join(source, assets.windowsInstaller));
    await symlink(join(source, "builder-debug.yml"), join(source, assets.windowsInstaller));
    await expect(stagePlatformArtifacts(source, hostileOutput, "windows", contract)).rejects.toThrow();
    await expect(stagePlatformArtifacts(source, join(root, "invalid-platform"), "freebsd", contract)).rejects.toThrow();
  });

  it("assembles one regular copy of every platform artifact into a new isolated directory", async () => {
    const { assembleRelease } = await loadModule();
    const root = await mkdtemp(join(tmpdir(), "civcom-assembly-"));
    const incoming = join(root, "incoming");
    const output = join(root, "assembled");
    const groups = {
      windows: [assets.windowsInstaller, assets.windowsBlockmap, assets.windowsMetadata],
      macos: [assets.macDmg, assets.macZip, assets.macBlockmap, assets.macMetadata],
      linux: [assets.linuxAppImage, assets.linuxDeb, assets.linuxMetadata]
    } as const;
    for (const [group, names] of Object.entries(groups)) {
      for (const name of names) {
        const platformRoot = join(incoming, `PRODUCTION-${group}`);
        await mkdir(platformRoot, { recursive: true });
        await writeFile(join(platformRoot, name), `${group}:${name}`);
      }
    }
    await expect(assembleRelease(incoming, output, contract)).resolves.toBeUndefined();
    expect((await readdir(output)).sort()).toEqual(Object.values(assets).filter((name) => name !== assets.buildSbom && name !== assets.checksums && name !== assets.md5Checksums).sort());
    expect(await readFile(join(output, assets.linuxDeb), "utf8")).toBe(`linux:${assets.linuxDeb}`);
    await expect(assembleRelease(incoming, output, contract)).rejects.toThrow();
  });

  it("rejects every unexpected, nested, or symlinked input during assembly", async () => {
    const { assembleRelease } = await loadModule();
    const root = await mkdtemp(join(tmpdir(), "civcom-hostile-assembly-"));
    const incoming = join(root, "incoming");
    for (const [group, names] of Object.entries({ windows: [assets.windowsInstaller, assets.windowsBlockmap, assets.windowsMetadata], macos: [assets.macDmg, assets.macZip, assets.macBlockmap, assets.macMetadata], linux: [assets.linuxAppImage, assets.linuxDeb, assets.linuxMetadata] })) {
      await mkdir(join(incoming, `PRODUCTION-${group}`), { recursive: true });
      for (const name of names) await writeFile(join(incoming, `PRODUCTION-${group}`, name), "payload");
    }
    await writeFile(join(incoming, "PRODUCTION-windows", "unexpected.txt"), "unexpected");
    await expect(assembleRelease(incoming, join(root, "unexpected-output"), contract)).rejects.toThrow();

    await rm(join(incoming, "PRODUCTION-windows", "unexpected.txt"));
    await mkdir(join(incoming, "PRODUCTION-windows", "nested"));
    await expect(assembleRelease(incoming, join(root, "nested-output"), contract)).rejects.toThrow();

    const linkedRoot = await mkdtemp(join(tmpdir(), "civcom-linked-assembly-"));
    const linkedIncoming = join(linkedRoot, "incoming");
    for (const [group, names] of Object.entries({ windows: [assets.windowsInstaller, assets.windowsBlockmap, assets.windowsMetadata], macos: [assets.macDmg, assets.macZip, assets.macBlockmap, assets.macMetadata], linux: [assets.linuxAppImage, assets.linuxDeb, assets.linuxMetadata] })) {
      await mkdir(join(linkedIncoming, `PRODUCTION-${group}`), { recursive: true });
      for (const name of names) await writeFile(join(linkedIncoming, `PRODUCTION-${group}`, name), "payload");
    }
    const target = join(linkedRoot, "outside.exe");
    await writeFile(target, "payload");
    await symlink(target, join(linkedIncoming, "PRODUCTION-windows", "unexpected-link"));
    await expect(assembleRelease(linkedIncoming, join(linkedRoot, "linked-output"), contract)).rejects.toThrow();
  });

  it("builds only a gated draft, verify-draft, or final publish command plan with publish last", async () => {
    const { createPublicationPlan } = await loadModule();
    const context = { githubActions: "true", allowPublication: "confirmed", eventName: "push", refType: "tag", refName: "v0.1.0", refProtected: "true", repository: "KGPSP/civcom-desktop", packageVersion: "0.1.0", releaseDirectory: "/tmp/assembled", releaseNotesPath: "/tmp/RELEASE_NOTES.md", assetNames: Object.values(assets) };
    const draft = createPublicationPlan("draft", context);
    expect(draft.commands).toHaveLength(1);
    expect(draft.commands[0]?.args).toContain("--draft");
    expect(draft.commands[0]?.args).toContain("--latest=false");
    expect(draft.commands[0]?.args).toContain("--notes-file");
    expect(draft.commands[0]?.args).toContain("/tmp/RELEASE_NOTES.md");
    expect(draft.commands[0]?.args).not.toContain("--notes");
    const verify = createPublicationPlan("verify-draft", context);
    expect(verify.commands.map(({ args }) => args.join(" ")).join("\n")).not.toContain("--draft=false");
    const publish = createPublicationPlan("publish", context);
    expect(publish.commands.at(-1)?.args).toContain("--draft=false");
    expect(publish.commands.at(-1)?.args).toContain("--latest");
    for (const mode of ["draft", "verify-draft", "publish"]) expect(() => createPublicationPlan(mode, { ...context, githubActions: "false" })).toThrow();
    expect(() => createPublicationPlan("publish", { ...context, allowPublication: "yes" })).toThrow();
  });
});
