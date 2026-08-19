import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/release-contract.mjs", import.meta.url).href;

type ReleaseContractModule = Readonly<{
  loadReleaseContract(value: unknown): Readonly<{ assets: Readonly<Record<string, string>>; orderedAssets: readonly string[] }>;
  verifyReleaseDirectory(directory: string, contract: unknown, options?: Readonly<{ expectedVersion?: string }>): Promise<void>;
  parseUpdateMetadata(text: string, expectedFilenames: string | readonly string[], expectedVersion: string): Readonly<Record<string, unknown>>;
  createSha256Manifest(directory: string, filenames: readonly string[]): Promise<string>;
  verifyIdenticalReleaseDirectories(localDirectory: string, remoteDirectory: string, contract: unknown): Promise<void>;
  resolveExpectedAppVersion(packageMetadata: unknown, packageLock: unknown): string;
  validateBuildSbom(value: unknown, expectedAppVersion: string): void;
}>;

async function loadModule(): Promise<ReleaseContractModule> {
  return await import(moduleUrl) as ReleaseContractModule;
}

const expectedAssets = Object.freeze({
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
  checksums: "SHA256SUMS"
});

function contractValue(assets: Record<string, unknown> = { ...expectedAssets }): unknown {
  return { schemaVersion: 1, releaseBaseUrl: "https://github.com/KGPSP/civcom-desktop/releases/latest/download", latestReleaseUrl: "https://github.com/KGPSP/civcom-desktop/releases/latest", assets };
}

const sha512 = createHash("sha512").update("payload").digest("base64");

function metadata(filenames: string | readonly string[]): string {
  const values = typeof filenames === "string" ? [filenames] : filenames;
  const files = values.map((filename) => `  - url: ${filename}\n    sha512: ${sha512}\n    size: 7`).join("\n");
  return `version: 0.1.0\nfiles:\n${files}\npath: ${values[0]}\nsha512: ${sha512}\nreleaseDate: '2026-08-19T00:00:00.000Z'\n`;
}

const requiredSbomPackages = Object.freeze([
  { name: "civcom-desktop", versionInfo: "0.1.0" },
  { name: "electron", versionInfo: "43.4.1" },
  { name: "electron-updater", versionInfo: "6.8.9" },
  { name: "@electron/fuses", versionInfo: "2.1.3" }
]);

async function populatedRelease(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "civcom-release-"));
  for (const filename of Object.values(expectedAssets)) {
    const contents = filename === "latest.yml" ? metadata(expectedAssets.windowsInstaller)
      : filename === "latest-mac.yml" ? metadata(expectedAssets.macZip)
      : filename === "latest-linux.yml" ? metadata([expectedAssets.linuxAppImage, expectedAssets.linuxDeb])
      : filename === "CivCom-build.spdx.json" ? JSON.stringify({ spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", name: "CivCom npm lockfile and build supply chain", packages: requiredSbomPackages })
      : filename === "SHA256SUMS" ? "pending"
      : "payload";
    await writeFile(join(root, filename), contents);
  }
  const lines: string[] = [];
  for (const filename of Object.values(expectedAssets).filter((name) => name !== expectedAssets.checksums).sort()) {
    const digest = createHash("sha256").update(await readFile(join(root, filename))).digest("hex");
    lines.push(`${digest}  ${filename}`);
  }
  await writeFile(join(root, expectedAssets.checksums), `${lines.join("\n")}\n`);
  return root;
}

describe("canonical release contract", () => {
  it("loads the checked-in canonical filenames in deterministic order", async () => {
    const { loadReleaseContract } = await loadModule();
    const actual = JSON.parse(await readFile(new URL("../docs/downloads.json", import.meta.url), "utf8")) as unknown;
    const contract = loadReleaseContract(actual);
    expect(contract.assets).toEqual(expectedAssets);
    expect(contract.orderedAssets).toEqual(Object.values(expectedAssets));
  });

  it("rejects duplicate, missing, unexpected, path-like, control-bearing, and oversized names", async () => {
    const { loadReleaseContract } = await loadModule();
    const invalid = [
      { ...expectedAssets, linuxDeb: expectedAssets.linuxAppImage },
      Object.fromEntries(Object.entries(expectedAssets).filter(([key]) => key !== "linuxDeb")),
      { ...expectedAssets, extra: "unexpected.bin" },
      { ...expectedAssets, linuxDeb: "../CivCom.deb" },
      { ...expectedAssets, linuxDeb: "dir/CivCom.deb" },
      { ...expectedAssets, linuxDeb: "CivCom\n.deb" },
      { ...expectedAssets, linuxDeb: `${"x".repeat(241)}.deb` }
    ];
    for (const assets of invalid) expect(() => loadReleaseContract(contractValue(assets))).toThrow();
  });

  it("strictly validates updater metadata filename, SHA-512, size, version, and duplicate keys", async () => {
    const { parseUpdateMetadata } = await loadModule();
    expect(parseUpdateMetadata(metadata(expectedAssets.windowsInstaller), expectedAssets.windowsInstaller, "0.1.0")).toMatchObject({ path: expectedAssets.windowsInstaller, size: 7 });
    for (const hostile of [
      metadata("../CivCom-Windows-x64.exe"),
      metadata(expectedAssets.windowsInstaller).replace(sha512, "AAAA"),
      metadata(expectedAssets.windowsInstaller).replace("size: 7", "size: 0"),
      metadata(expectedAssets.windowsInstaller).replace("version: 0.1.0", "version: 9.9.9"),
      `${metadata(expectedAssets.windowsInstaller)}path: ${expectedAssets.windowsInstaller}\n`,
      `${metadata(expectedAssets.windowsInstaller)}evil: true\n`,
      metadata(expectedAssets.windowsInstaller).replace("files:", "files: &files")
    ]) expect(() => parseUpdateMetadata(hostile, expectedAssets.windowsInstaller, "0.1.0")).toThrow();

    const linux = metadata([expectedAssets.linuxAppImage, expectedAssets.linuxDeb]);
    expect(parseUpdateMetadata(linux, [expectedAssets.linuxAppImage, expectedAssets.linuxDeb], "0.1.0")).toMatchObject({
      path: expectedAssets.linuxAppImage,
      files: [
        { url: expectedAssets.linuxAppImage, size: 7 },
        { url: expectedAssets.linuxDeb, size: 7 }
      ]
    });
    expect(() => parseUpdateMetadata(linux, expectedAssets.linuxAppImage, "0.1.0")).toThrow();
    expect(() => parseUpdateMetadata(metadata(expectedAssets.linuxAppImage), [expectedAssets.linuxAppImage, expectedAssets.linuxDeb], "0.1.0")).toThrow();
  });

  it("rejects missing, unexpected, empty, oversized, non-regular, and symlinked release assets", async () => {
    const { verifyReleaseDirectory } = await loadModule();
    await expect(verifyReleaseDirectory(await populatedRelease(), contractValue(), { expectedVersion: "0.1.0" })).resolves.toBeUndefined();

    const missing = await populatedRelease();
    await writeFile(join(missing, expectedAssets.linuxDeb), "");
    await expect(verifyReleaseDirectory(missing, contractValue(), { expectedVersion: "0.1.0" })).rejects.toThrow();

    const unexpected = await populatedRelease();
    await writeFile(join(unexpected, "extra.bin"), "x");
    await expect(verifyReleaseDirectory(unexpected, contractValue(), { expectedVersion: "0.1.0" })).rejects.toThrow();

    const directoryAsset = await populatedRelease();
    await rm(join(directoryAsset, expectedAssets.linuxDeb));
    await mkdir(join(directoryAsset, expectedAssets.linuxDeb), { recursive: true });
    await expect(verifyReleaseDirectory(directoryAsset, contractValue(), { expectedVersion: "0.1.0" })).rejects.toThrow();

    if (process.platform !== "win32") {
      const linked = await populatedRelease();
      const target = join(linked, "target.deb");
      await writeFile(target, "payload");
      await writeFile(join(linked, expectedAssets.linuxDeb), "").catch(() => undefined);
      await rm(join(linked, expectedAssets.linuxDeb));
      await symlink(target, join(linked, expectedAssets.linuxDeb));
      await expect(verifyReleaseDirectory(linked, contractValue(), { expectedVersion: "0.1.0" })).rejects.toThrow();
    }
  });

  it("recomputes every updater payload SHA-512 and size instead of trusting self-consistent metadata text", async () => {
    const { createSha256Manifest, loadReleaseContract, verifyReleaseDirectory } = await loadModule();
    const root = await populatedRelease();
    await writeFile(join(root, expectedAssets.windowsInstaller), "PAYLOAD");
    const contract = loadReleaseContract(contractValue());
    await writeFile(join(root, expectedAssets.checksums), await createSha256Manifest(root, contract.orderedAssets.filter((name) => name !== expectedAssets.checksums)));
    await expect(verifyReleaseDirectory(root, contractValue(), { expectedVersion: "0.1.0" })).rejects.toThrow();
  });

  it("generates a sorted SHA-256 manifest without shell interpolation", async () => {
    const { createSha256Manifest } = await loadModule();
    const root = await mkdtemp(join(tmpdir(), "civcom-checksum-"));
    await writeFile(join(root, "b.bin"), "b");
    await writeFile(join(root, "a.bin"), "a");
    await expect(createSha256Manifest(root, ["b.bin", "a.bin"])).resolves.toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a.bin\n" +
      "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b.bin\n"
    );
  });

  it("requires every downloaded draft asset to be byte-identical to the locally verified release", async () => {
    const { createSha256Manifest, loadReleaseContract, verifyIdenticalReleaseDirectories } = await loadModule();
    const local = await populatedRelease();
    const remote = await populatedRelease();
    await expect(verifyIdenticalReleaseDirectories(local, remote, contractValue())).resolves.toBeUndefined();

    await writeFile(join(remote, expectedAssets.linuxDeb), "PAYLOAD");
    const contract = loadReleaseContract(contractValue());
    await writeFile(join(remote, expectedAssets.checksums), await createSha256Manifest(remote, contract.orderedAssets.filter((name) => name !== expectedAssets.checksums)));
    await expect(verifyIdenticalReleaseDirectories(local, remote, contractValue())).rejects.toThrow();
  });

  it("labels the SPDX document as npm lockfile and build supply-chain scope", async () => {
    const { validateBuildSbom } = await loadModule();
    const sbom = { spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", name: "CivCom npm lockfile and build supply chain", packages: requiredSbomPackages };
    expect(() => validateBuildSbom(sbom, "0.1.0")).not.toThrow();
    for (const missingName of ["electron", "electron-updater", "@electron/fuses"]) {
      expect(() => validateBuildSbom({ ...sbom, packages: requiredSbomPackages.filter(({ name }) => name !== missingName) }, "0.1.0")).toThrow();
    }
    for (const [name, versionInfo] of [["civcom-desktop", "9.9.9"], ["electron", "42.0.0"], ["electron-updater", "6.8.8"], ["@electron/fuses", "2.1.2"]]) {
      const packages = requiredSbomPackages.map((entry) => entry.name === name ? { ...entry, versionInfo } : entry);
      expect(() => validateBuildSbom({ ...sbom, packages }, "0.1.0")).toThrow();
    }
    for (const value of [null, {}, { spdxVersion: "SPDX-2.2", dataLicense: "CC0-1.0", name: "full binary inventory", packages: [] }, { spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", name: "CivCom npm lockfile and build supply chain", packages: [] }]) expect(() => validateBuildSbom(value, "0.1.0")).toThrow();
    expect(() => validateBuildSbom(sbom, "")).toThrow();
  });

  it("takes the app SBOM version from matching package metadata and lock data instead of a hardcoded release", async () => {
    const { resolveExpectedAppVersion, validateBuildSbom } = await loadModule();
    const bumpedPackages = requiredSbomPackages.map((entry) => entry.name === "civcom-desktop" ? { ...entry, versionInfo: "0.2.0" } : entry);
    const bumpedSbom = { spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", name: "CivCom npm lockfile and build supply chain", packages: bumpedPackages };
    expect(resolveExpectedAppVersion(
      { name: "civcom-desktop", version: "0.2.0" },
      { name: "civcom-desktop", lockfileVersion: 3, version: "0.2.0", packages: { "": { name: "civcom-desktop", version: "0.2.0" } } }
    )).toBe("0.2.0");
    expect(() => validateBuildSbom(bumpedSbom, "0.2.0")).not.toThrow();
    expect(() => validateBuildSbom(bumpedSbom, "0.1.0")).toThrow();
    for (const packageLock of [
      { name: "civcom-desktop", lockfileVersion: 3, version: "0.1.0", packages: { "": { name: "civcom-desktop", version: "0.1.0" } } },
      { name: "civcom-desktop", lockfileVersion: 2, version: "0.2.0", packages: { "": { name: "civcom-desktop", version: "0.2.0" } } },
      { name: "civcom-desktop", lockfileVersion: 3, version: "0.2.0", packages: { "": { name: "wrong-name", version: "0.2.0" } } }
    ]) expect(() => resolveExpectedAppVersion({ name: "civcom-desktop", version: "0.2.0" }, packageLock)).toThrow();
  });
});
