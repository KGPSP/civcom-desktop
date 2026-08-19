import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const policyUrl = new URL("../scripts/fuse-policy.mjs", import.meta.url).href;

type FusePolicy = Readonly<{
  FUSE_VALUES: Readonly<Record<string, boolean>>;
  createFuseConfig(api: Readonly<{ FuseVersion: Readonly<{ V1: string }>; FuseV1Options: Readonly<Record<string, number>> }>): Readonly<Record<string | number, unknown>>;
  shouldFlipFuses(input: Readonly<{ platform: string; arch: number }>): boolean;
  resolveElectronExecutable(input: Readonly<{ platform: string; appOutDir: string; productFilename: string; executableName?: string }>): string;
  verifyFuseWire(wire: Readonly<Record<string | number, unknown>>, api: Readonly<{ FuseVersion: Readonly<{ V1: string }>; FuseV1Options: Readonly<Record<string, number>>; FuseState: Readonly<{ ENABLE: number; DISABLE: number }> }>): void;
}>;

async function loadPolicy(): Promise<FusePolicy> {
  return await import(policyUrl) as FusePolicy;
}

const options = Object.freeze({
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7,
  WasmTrapHandlers: 8
});

describe("Electron fuse policy", () => {
  it("pins the only direct fuse package to 2.1.3 and explicitly configures all nine V1 fuses", async () => {
    const packageJson = require("../package.json") as { devDependencies: Record<string, string> };
    expect(packageJson.devDependencies["@electron/fuses"]).toBe("2.1.3");
    const policy = await loadPolicy();
    expect(policy.FUSE_VALUES).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: false,
      WasmTrapHandlers: true
    });
    const config = policy.createFuseConfig({ FuseVersion: { V1: "1" }, FuseV1Options: options });
    expect(config).toEqual({
      version: "1",
      strictlyRequireAllFuses: true,
      resetAdHocDarwinSignature: true,
      0: false, 1: true, 2: false, 3: false, 4: true, 5: true, 6: false, 7: false, 8: true
    });
  });

  it("uses Electron's supported stock snapshot lookup without binary string patching", async () => {
    const afterPack = await readFile(new URL("../scripts/after-pack.mjs", import.meta.url), "utf8");

    expect(afterPack).not.toContain("browser-snapshot");
    expect(afterPack).not.toContain("prepareBrowserSnapshot");
    await expect(access(new URL("../scripts/browser-snapshot.mjs", import.meta.url))).rejects.toThrow();
  });

  it("resolves only the exact executable layout for each supported packaged OS", async () => {
    const { resolveElectronExecutable } = await loadPolicy();
    expect(resolveElectronExecutable({ platform: "darwin", appOutDir: "/out", productFilename: "CivCom" })).toBe("/out/CivCom.app/Contents/MacOS/CivCom");
    expect(resolveElectronExecutable({ platform: "win32", appOutDir: "C:\\out", productFilename: "CivCom" })).toBe("C:\\out\\CivCom.exe");
    expect(resolveElectronExecutable({ platform: "linux", appOutDir: "/out", productFilename: "CivCom", executableName: "civcom" })).toBe("/out/civcom");
    for (const input of [
      { platform: "freebsd", appOutDir: "/out", productFilename: "CivCom", executableName: "civcom" },
      { platform: "linux", appOutDir: "/out", productFilename: "CivCom" },
      { platform: "linux", appOutDir: "relative", productFilename: "CivCom", executableName: "civcom" },
      { platform: "darwin", appOutDir: "/out", productFilename: "../CivCom", executableName: "civcom" }
    ]) expect(() => resolveElectronExecutable(input)).toThrow();
  });

  it("flips a universal macOS executable only after the architecture merge", async () => {
    const { shouldFlipFuses } = await loadPolicy();
    expect(shouldFlipFuses({ platform: "darwin", arch: 1 })).toBe(false);
    expect(shouldFlipFuses({ platform: "darwin", arch: 3 })).toBe(false);
    expect(shouldFlipFuses({ platform: "darwin", arch: 4 })).toBe(true);
    expect(shouldFlipFuses({ platform: "win32", arch: 1 })).toBe(true);
    expect(shouldFlipFuses({ platform: "linux", arch: 1 })).toBe(true);
    for (const input of [{ platform: "darwin", arch: 0 }, { platform: "win32", arch: 3 }, { platform: "linux", arch: 4 }, { platform: "freebsd", arch: 1 }]) expect(() => shouldFlipFuses(input)).toThrow();
  });

  it("accepts the exact final wire and fails closed on wrong, missing, extra, or unknown fuse data", async () => {
    const { verifyFuseWire } = await loadPolicy();
    const api = { FuseVersion: { V1: "1" }, FuseV1Options: options, FuseState: { ENABLE: 49, DISABLE: 48 } };
    const valid = { version: "1", 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49, 6: 48, 7: 48, 8: 49 };
    expect(() => verifyFuseWire(valid, api)).not.toThrow();
    for (const wire of [
      { ...valid, version: "2" },
      { ...valid, 7: 49 },
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "8")),
      { ...valid, 9: 49 },
      { ...valid, 8: 114 }
    ]) expect(() => verifyFuseWire(wire, api)).toThrow();
  });
});
