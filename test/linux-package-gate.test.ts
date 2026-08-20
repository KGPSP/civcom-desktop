import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflowModuleUrl = new URL("../scripts/verify-workflows.mjs", import.meta.url).href;
const installedDebModuleUrl = new URL("../scripts/linux-installed-deb.mjs", import.meta.url).href;

type WorkflowModule = Readonly<{
  validateWorkflowSource(name: string, source: string): void;
}>;

type InstalledDebModule = Readonly<{
  createInstalledDebLayout(root?: string): Readonly<{
    appRoot: string;
    executable: string;
    resources: string;
    smokeExecutable: string;
    sandboxHelper: string;
  }>;
  validateInstalledDebPermissions(input: Readonly<Record<string, Readonly<{ uid: number; gid: number; mode: number }>>>): void;
}>;

async function readLf(url: URL): Promise<string> {
  const source = await readFile(url, "utf8");
  if (/\r(?!\n)/.test(source)) throw new Error("Linux package fixture contains a bare carriage return");
  return source.replaceAll("\r\n", "\n");
}

const packageCommand = "      - run: npm run ${{ matrix.package-script }}\n";
const installStep = [
  "      - name: Install Linux DEB for sandboxed smoke",
  "        if: matrix.target == 'linux'",
  "        shell: bash",
  "        run: |",
  "          set -eu",
  "          workspace_path=\"$(realpath \"$GITHUB_WORKSPACE\")\"",
  "          package_path=\"$workspace_path/release/CivCom-Linux-x86_64.deb\"",
  "          test -f \"$package_path\"",
  "          test ! -L \"$package_path\"",
  "          test \"$(realpath \"$package_path\")\" = \"$package_path\"",
  "          package_version=\"$(dpkg-deb --field \"$package_path\" Version)\"",
  "          sudo apt-get install --yes --no-install-recommends \"$package_path\"",
  "          installed_version=\"$(dpkg-query --show --showformat='${Version}' civcom)\"",
  "          test \"$installed_version\" = \"$package_version\"",
  "          installed_root=\"/opt/CivCom\"",
  "          test -d \"$installed_root\"",
  "          test ! -L \"$installed_root\"",
  "          test \"$(realpath \"$installed_root\")\" = \"$installed_root\"",
  "          test \"$(stat -c '%u:%g:%a' \"$installed_root\")\" = \"0:0:755\"",
  "          test -f \"$installed_root/civcom\"",
  "          test ! -L \"$installed_root/civcom\"",
  "          test \"$(realpath \"$installed_root/civcom\")\" = \"$installed_root/civcom\"",
  "          test -x \"$installed_root/civcom\"",
  "          test \"$(stat -c '%u:%g:%a' \"$installed_root/civcom\")\" = \"0:0:755\"",
  "          test -d \"$installed_root/resources\"",
  "          test ! -L \"$installed_root/resources\"",
  "          test \"$(realpath \"$installed_root/resources\")\" = \"$installed_root/resources\"",
  "          test \"$(stat -c '%u:%g:%a' \"$installed_root/resources\")\" = \"0:0:755\"",
  "          for runtime_file in app.asar package-type apparmor-profile; do",
  "            runtime_path=\"$installed_root/resources/$runtime_file\"",
  "            test -f \"$runtime_path\"",
  "            test ! -L \"$runtime_path\"",
  "            test \"$(realpath \"$runtime_path\")\" = \"$runtime_path\"",
  "            test \"$(stat -c '%u:%g:%a' \"$runtime_path\")\" = \"0:0:644\"",
  "          done",
  "          test -f \"$installed_root/chrome-sandbox\"",
  "          test ! -L \"$installed_root/chrome-sandbox\"",
  "          test \"$(realpath \"$installed_root/chrome-sandbox\")\" = \"$installed_root/chrome-sandbox\"",
  "          sandbox_state=\"$(stat -c '%u:%g:%a' \"$installed_root/chrome-sandbox\")\"",
  "          test \"$sandbox_state\" = \"0:0:755\" || test \"$sandbox_state\" = \"0:0:4755\"",
  "          test -s \"$installed_root/resources/app.asar\"",
  "          test -s \"$installed_root/resources/package-type\"",
  "          test -s \"$installed_root/resources/apparmor-profile\""
].join("\n") + "\n";
const releaseInstallStep = installStep.replace("        if: matrix.target == 'linux'\n", "");
const linuxPilotStageStep = [
  "      - name: Stage Linux DEB only for the internal pilot",
  "        if: matrix.target == 'linux'",
  "        shell: bash",
  "        run: |",
  "          set -eu",
  "          workspace_path=\"$(realpath \"$GITHUB_WORKSPACE\")\"",
  "          package_path=\"$workspace_path/release/CivCom-Linux-x86_64.deb\"",
  "          output_path=\"$workspace_path/release/staged/linux\"",
  "          test -f \"$package_path\"",
  "          test ! -L \"$package_path\"",
  "          test \"$(realpath \"$package_path\")\" = \"$package_path\"",
  "          mkdir -p -- \"$output_path\"",
  "          test -z \"$(find \"$output_path\" -mindepth 1 -maxdepth 1 -print -quit)\"",
  "          cp --no-dereference -- \"$package_path\" \"$output_path/CivCom-Linux-x86_64.deb\"",
  "          test \"$(find \"$output_path\" -mindepth 1 -maxdepth 1 -type f -name 'CivCom-Linux-x86_64.deb' | wc -l)\" = \"1\"",
  "          test \"$(find \"$output_path\" -mindepth 1 -maxdepth 1 | wc -l)\" = \"1\""
].join("\n") + "\n";

function withRequiredLinuxInstall(source: string): string {
  if (source.includes("name: Install Linux DEB for sandboxed smoke")) return source;
  const candidate = source.replace(packageCommand, `${packageCommand}${installStep}`);
  if (candidate === source) throw new Error("pilot package command fixture missing");
  return candidate;
}

describe("native Linux pilot package gate", () => {
  it("requires the freshly built DEB to be installed before packaged verification", async () => {
    const { validateWorkflowSource } = await import(workflowModuleUrl) as WorkflowModule;
    const current = await readLf(new URL("../.github/workflows/pilot.yml", import.meta.url));
    const candidate = withRequiredLinuxInstall(current);

    expect(() => validateWorkflowSource("pilot.yml", candidate)).not.toThrow();
    expect(() => validateWorkflowSource("pilot.yml", candidate.replace(installStep, ""))).toThrow(/installed DEB sandbox smoke gate/i);
    expect(() => validateWorkflowSource("pilot.yml", candidate.replace("installed_root=\"/opt/CivCom\"", "installed_root=\"$workspace_path/release/CivCom-Linux-x86_64.AppImage\""))).toThrow(/installed DEB sandbox smoke gate/i);
  });

  it("targets the fixed installed DEB runtime instead of the AppImage wrapper", async () => {
    const { createInstalledDebLayout } = await import(installedDebModuleUrl) as InstalledDebModule;
    expect(createInstalledDebLayout()).toEqual({
      appRoot: "/opt/CivCom",
      executable: "/opt/CivCom/civcom",
      resources: "/opt/CivCom/resources",
      smokeExecutable: "/opt/CivCom/civcom",
      sandboxHelper: "/opt/CivCom/chrome-sandbox"
    });
    expect(() => createInstalledDebLayout("relative/CivCom")).toThrow();
    expect(() => createInstalledDebLayout("/opt/CivCom/../Other")).toThrow();
  });

  it("rejects every group- or world-writable installed runtime component", async () => {
    const { validateInstalledDebPermissions } = await import(installedDebModuleUrl) as InstalledDebModule;
    const secure = {
      root: { uid: 0, gid: 0, mode: 0o40755 },
      executable: { uid: 0, gid: 0, mode: 0o100755 },
      resources: { uid: 0, gid: 0, mode: 0o40755 },
      sandbox: { uid: 0, gid: 0, mode: 0o100755 },
      profile: { uid: 0, gid: 0, mode: 0o100644 },
      asar: { uid: 0, gid: 0, mode: 0o100644 },
      packageMarker: { uid: 0, gid: 0, mode: 0o100644 }
    };

    expect(() => validateInstalledDebPermissions(secure)).not.toThrow();
    expect(() => validateInstalledDebPermissions({ ...secure, sandbox: { ...secure.sandbox, mode: 0o104755 } })).not.toThrow();
    for (const key of Object.keys(secure)) {
      const entry = secure[key as keyof typeof secure];
      for (const writableBit of [0o020, 0o002]) {
        expect(() => validateInstalledDebPermissions({
          ...secure,
          [key]: { ...entry, mode: entry.mode | writableBit }
        })).toThrow(/permissions/i);
      }
    }
    expect(() => validateInstalledDebPermissions({ ...secure, asar: { ...secure.asar, uid: 1000 } })).toThrow(/permissions/i);
    expect(() => validateInstalledDebPermissions({ ...secure, executable: { ...secure.executable, mode: 0o100644 } })).toThrow(/permissions/i);
  });

  it("keeps the production Linux verifier on the same installed DEB gate", async () => {
    const { validateWorkflowSource } = await import(workflowModuleUrl) as WorkflowModule;
    const current = await readLf(new URL("../.github/workflows/release.yml", import.meta.url));
    const marker = "      - run: npm run package:linux\n";
    const candidate = current.includes("name: Install Linux DEB for sandboxed smoke") ? current : current.replace(marker, `${marker}${releaseInstallStep}`);
    expect(candidate).toContain(releaseInstallStep);
    expect(() => validateWorkflowSource("release.yml", candidate)).not.toThrow();
    expect(() => validateWorkflowSource("release.yml", candidate.replace(releaseInstallStep, ""))).toThrow(/installed DEB sandbox smoke gate/i);
  });

  it("withholds AppImage from the internal pilot and retains its smoke gate for production", async () => {
    const { validateWorkflowSource } = await import(workflowModuleUrl) as WorkflowModule;
    const pilot = await readLf(new URL("../.github/workflows/pilot.yml", import.meta.url));
    const verifier = await readLf(new URL("../scripts/verify-packaged-app.mjs", import.meta.url));
    expect(pilot).toContain(linuxPilotStageStep);
    expect(() => validateWorkflowSource("pilot.yml", pilot.replace(linuxPilotStageStep, ""))).toThrow(/Linux DEB-only pilot staging/i);
    expect(verifier).toContain('if (target === "linux" && mode === "production") await smoke(target, layout);');
  });
});
