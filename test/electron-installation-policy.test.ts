import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const moduleUrl = new URL("../scripts/verify-electron-binary.mjs", import.meta.url).href;

type ElectronVerificationModule = Readonly<{
  verifyElectronInstallation?: (input: Readonly<{ installationRoot: string; platform: string; expectedVersion: string }>) => Promise<void>;
}>;

describe("Electron dependency installation policy", () => {
  it("validates the pinned executable without launching it during dependency installation", async () => {
    const module = await import(moduleUrl) as ElectronVerificationModule;
    expect(module.verifyElectronInstallation).toBeTypeOf("function");
    if (typeof module.verifyElectronInstallation !== "function") return;

    const installationRoot = await mkdtemp(join(tmpdir(), "civcom-electron-installation-"));
    try {
      await mkdir(join(installationRoot, "dist"));
      await writeFile(join(installationRoot, "package.json"), '{"name":"electron","version":"43.4.1"}\n');
      await writeFile(join(installationRoot, "path.txt"), "electron");
      await writeFile(join(installationRoot, "dist", "version"), "43.4.1");
      const executable = join(installationRoot, "dist", "electron");
      await writeFile(executable, "this is deliberately not a runnable Electron binary\n");
      await chmod(executable, 0o755);
      const sandbox = join(installationRoot, "dist", "chrome-sandbox");
      await writeFile(sandbox, "sandbox fixture\n");
      await chmod(sandbox, 0o755);

      await expect(module.verifyElectronInstallation({ installationRoot, platform: "linux", expectedVersion: "43.4.1" })).resolves.toBeUndefined();
      await writeFile(join(installationRoot, "dist", "version"), "43.4.0");
      await expect(module.verifyElectronInstallation({ installationRoot, platform: "linux", expectedVersion: "43.4.1" })).rejects.toThrow("version");
      await writeFile(join(installationRoot, "dist", "version"), "43.4.1");
      await writeFile(join(installationRoot, "package.json"), '{"name":"electron","version":"43.4.0"}\n');
      await expect(module.verifyElectronInstallation({ installationRoot, platform: "linux", expectedVersion: "43.4.1" })).rejects.toThrow("version");
    } finally {
      await rm(installationRoot, { recursive: true, force: true });
    }
  });

  it("keeps postinstall verification static instead of starting Chromium before CI configures its sandbox", () => {
    const packageJson = require("../package.json") as { scripts: Record<string, string> };
    expect(packageJson.scripts.postinstall).toBe("npm run verify:electron");
    expect(packageJson.scripts["verify:electron"]).toBe("install-electron --no && node scripts/verify-electron-binary.mjs");
  });
});
