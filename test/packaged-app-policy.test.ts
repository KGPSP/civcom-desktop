import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/packaged-app-policy.mjs", import.meta.url).href;

type PackagedPolicy = Readonly<{
  resolvePackagedLayout(input: Readonly<{ target: string; releaseDirectory: string }>): Readonly<{ appRoot: string; executable: string; resources: string; infoPlist?: string; smokeExecutable: string }>;
  verifyPackagedLayout(layout: Readonly<{ appRoot: string; executable: string; resources: string; infoPlist?: string; smokeExecutable: string }>, expectedMarker: string): Promise<void>;
  createLaunchPlan(input: Readonly<{ target: string; layout: Readonly<{ appRoot: string; executable: string; resources: string; infoPlist?: string; smokeExecutable: string }>; userDataDirectory: string; environment?: Readonly<Record<string, string | undefined>> }>): Readonly<{ command: string; args: readonly string[]; environment: Readonly<Record<string, string>> }>;
  createLinuxInspectionPlan(input: Readonly<{ layout: Readonly<{ smokeExecutable: string }>; scratchDirectory: string }>): Readonly<{ deb: Readonly<{ command: string; args: readonly string[]; desktopFile: string }>; appImage: Readonly<{ command: string; args: readonly string[]; cwd: string; desktopFile: string }> }>;
  createTamperProbePlan(input: Readonly<{ target: string; layout: Readonly<{ appRoot: string }>; scratchDirectory: string }>): Readonly<{ attempts: readonly Readonly<{ kind: string; copyRoot: string; executable: string; resources: string; userData: string; smokeResult: string }>[] }>;
  validateLinuxDesktopEntry(value: unknown, variant: string, expectedVersion: string): void;
  validateMacEntitlementKeys(value: unknown, profile: string): void;
  validateTamperProbeOutcome(value: unknown): void;
  validateMacInfoPlist(value: unknown): void;
  validateWindowsIntegrityEntries(value: unknown): void;
  validateSmokeResult(value: unknown): void;
  parseVerifierArguments(args: readonly string[], environment?: Readonly<Record<string, string | undefined>>): Readonly<{ mode: "pilot" | "production"; target: "windows" | "macos" | "linux" }>;
  validateWindowsPublisherSubject(value: unknown): string;
  validateMacSigningDetails(value: unknown, expectedTeam: string): void;
  validateMacAdHocSigningDetails(value: unknown): void;
  validateUniversalArchitectures(value: unknown): void;
  validateAuthenticodeResult(value: unknown, expectedSubject: string): void;
}>;

async function loadModule(): Promise<PackagedPolicy> {
  return await import(moduleUrl) as PackagedPolicy;
}

describe("packaged application verification policy", () => {
  it("does not depend on a hoisted PE parser and proves Windows ASAR enforcement with native tamper probes", async () => {
    const verifier = await readFile(new URL("../scripts/verify-packaged-app.mjs", import.meta.url), "utf8");
    expect(verifier).not.toMatch(/require\(["']resedit["']\)/);
    expect(verifier).toContain("verifyAsarTamperResistance(target, layout)");
  });

  it("resolves only canonical native unpacked layouts and Linux AppImage smoke target", async () => {
    const { resolvePackagedLayout } = await loadModule();
    expect(resolvePackagedLayout({ target: "macos", releaseDirectory: "/tmp/release" })).toEqual({
      appRoot: "/tmp/release/mac-universal/CivCom.app",
      executable: "/tmp/release/mac-universal/CivCom.app/Contents/MacOS/CivCom",
      resources: "/tmp/release/mac-universal/CivCom.app/Contents/Resources",
      infoPlist: "/tmp/release/mac-universal/CivCom.app/Contents/Info.plist",
      smokeExecutable: "/tmp/release/mac-universal/CivCom.app/Contents/MacOS/CivCom"
    });
    expect(resolvePackagedLayout({ target: "windows", releaseDirectory: "C:\\release" })).toMatchObject({ executable: "C:\\release\\win-unpacked\\CivCom.exe", resources: "C:\\release\\win-unpacked\\resources" });
    expect(resolvePackagedLayout({ target: "linux", releaseDirectory: "/tmp/release" })).toMatchObject({ executable: "/tmp/release/linux-unpacked/civcom", resources: "/tmp/release/linux-unpacked/resources", smokeExecutable: "/tmp/release/CivCom-Linux-x86_64.AppImage" });
    for (const input of [{ target: "freebsd", releaseDirectory: "/tmp/release" }, { target: "macos", releaseDirectory: "relative" }, { target: "windows", releaseDirectory: "relative" }]) expect(() => resolvePackagedLayout(input)).toThrow();
  });

  it("requires regular app.asar/executable/marker files and rejects loose or linked application code", async () => {
    const { resolvePackagedLayout, verifyPackagedLayout } = await loadModule();
    const releaseDirectory = await mkdtemp(join(tmpdir(), "civcom-packaged-layout-"));
    const layout = resolvePackagedLayout({ target: "macos", releaseDirectory });
    await mkdir(layout.resources, { recursive: true });
    await mkdir(dirname(layout.executable), { recursive: true });
    await writeFile(layout.executable, "binary");
    await writeFile(join(layout.resources, "app.asar"), "asar");
    await writeFile(join(layout.resources, "package-type"), "macos\n");
    await expect(verifyPackagedLayout(layout, "macos")).resolves.toBeUndefined();
    await mkdir(join(layout.resources, "app"));
    await expect(verifyPackagedLayout(layout, "macos")).rejects.toThrow();

    const linkedRelease = await mkdtemp(join(tmpdir(), "civcom-packaged-linked-"));
    const linked = resolvePackagedLayout({ target: "linux", releaseDirectory: linkedRelease });
    await mkdir(linked.resources, { recursive: true });
    await writeFile(linked.executable, "binary");
    await writeFile(join(linked.resources, "real.asar"), "asar");
    await symlink(join(linked.resources, "real.asar"), join(linked.resources, "app.asar"));
    await writeFile(join(linked.resources, "package-type"), "deb\n");
    await expect(verifyPackagedLayout(linked, "deb")).rejects.toThrow();
  });

  it("creates a native offline launch without debugging or sandbox bypass flags", async () => {
    const { createLaunchPlan, resolvePackagedLayout } = await loadModule();
    const userDataDirectory = "/tmp/civcom-smoke";
    for (const target of ["macos", "windows", "linux"] as const) {
      const releaseDirectory = target === "windows" ? "C:\\release" : "/tmp/release";
      const layout = resolvePackagedLayout({ target, releaseDirectory });
      const plan = createLaunchPlan({ target, layout, userDataDirectory, environment: {
        PATH: "/usr/bin",
        NODE_OPTIONS: "--inspect",
        CIVCOM_DEV_URL: "https://attacker.invalid",
        DEBUG: "electron*",
        PWDEBUG: "1",
        ELECTRON_ENABLE_LOGGING: "1",
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        HTTPS_PROXY: "https://proxy.invalid",
        NO_PROXY: "*"
      } });
      expect(plan.args).toContain("--civcom-packaged-smoke");
      expect(plan.args).toContain(`--user-data-dir=${userDataDirectory}`);
      expect(plan.args.join(" ")).not.toMatch(/inspect|no-sandbox|matrix\.org|civcom\.soia\.gov\.pl/i);
      expect(plan.environment).not.toHaveProperty("NODE_OPTIONS");
      expect(plan.environment).not.toHaveProperty("CIVCOM_DEV_URL");
      for (const name of ["DEBUG", "PWDEBUG", "ELECTRON_ENABLE_LOGGING", "ELECTRON_OZONE_PLATFORM_HINT", "HTTPS_PROXY", "NO_PROXY"]) expect(plan.environment).not.toHaveProperty(name);
      if (target === "linux") expect(plan.args).not.toContain("--appimage-extract-and-run");
    }
  });

  it("inspects exact DEB and AppImage desktop files without weakening the AppImage launch", async () => {
    const { createLinuxInspectionPlan, resolvePackagedLayout, validateLinuxDesktopEntry } = await loadModule();
    const layout = resolvePackagedLayout({ target: "linux", releaseDirectory: "/tmp/release" });
    const plan = createLinuxInspectionPlan({ layout, scratchDirectory: "/tmp/inspect" });
    expect(plan.deb).toEqual({
      command: "dpkg-deb",
      args: ["--extract", "/tmp/release/CivCom-Linux-x86_64.deb", "/tmp/inspect/deb"],
      desktopFile: "/tmp/inspect/deb/usr/share/applications/info.soia.civcom.desktop"
    });
    expect(plan.appImage).toEqual({
      command: "/tmp/release/CivCom-Linux-x86_64.AppImage",
      args: ["--appimage-extract"],
      cwd: "/tmp/inspect/appimage",
      desktopFile: "/tmp/inspect/appimage/squashfs-root/info.soia.civcom.desktop"
    });
    const common = [
      "[Desktop Entry]", "Name=CivCom", "Terminal=false", "Type=Application", "Icon=civcom",
      "StartupWMClass=info.soia.civcom.desktop", "StartupNotify=true", "X-GNOME-UsesNotifications=true",
      "Keywords=CivCom;Matrix;komunikator;wiadomości;", "Categories=Network;InstantMessaging;"
    ];
    expect(() => validateLinuxDesktopEntry([...common, "Exec=/opt/CivCom/civcom %U", ""].join("\n"), "deb", "0.1.0")).not.toThrow();
    expect(() => validateLinuxDesktopEntry([...common, "Exec=AppRun %U", "X-AppImage-Version=0.1.0", ""].join("\n"), "appimage", "0.1.0")).not.toThrow();
    for (const hostile of [
      [...common, "Exec=/opt/CivCom/civcom %U", "MimeType=x-scheme-handler/civcom;", ""].join("\n"),
      [...common, "Exec=AppRun --no-sandbox %U", "X-AppImage-Version=0.1.0", ""].join("\n"),
      [...common, "Exec=AppRun %U", "X-AppImage-Version=9.9.9", ""].join("\n"),
      [...common, "Exec=/opt/CivCom/civcom %U", "Name=Duplicate", ""].join("\n")
    ]) expect(() => validateLinuxDesktopEntry(hostile, hostile.includes("AppRun") ? "appimage" : "deb", "0.1.0")).toThrow();
  });

  it("requires exact root and inherited macOS entitlement profiles", async () => {
    const { validateMacEntitlementKeys } = await loadModule();
    const plist = (keys: readonly string[]): string => `<?xml version="1.0"?><plist><dict>${keys.map((key) => `<key>${key}</key><true/>`).join("")}</dict></plist>`;
    expect(() => validateMacEntitlementKeys(plist(["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input", "com.apple.security.device.camera"]), "root")).not.toThrow();
    expect(() => validateMacEntitlementKeys(plist(["com.apple.security.cs.allow-jit"]), "inherit")).not.toThrow();
    expect(() => validateMacEntitlementKeys(plist(["com.apple.security.cs.allow-jit", "com.apple.security.device.camera"]), "inherit")).toThrow();
    expect(() => validateMacEntitlementKeys(plist(["com.apple.security.cs.allow-jit"]), "root")).toThrow();
  });

  it("plans isolated macOS/Windows ASAR tamper and loose-app probes and requires a prompt launch failure", async () => {
    const { createTamperProbePlan, validateTamperProbeOutcome } = await loadModule();
    const mac = createTamperProbePlan({ target: "macos", layout: { appRoot: "/release/mac-universal/CivCom.app" }, scratchDirectory: "/tmp/probe" });
    expect(mac.attempts.map(({ kind }) => kind)).toEqual(["tampered-asar", "loose-app"]);
    expect(mac.attempts[0]).toMatchObject({ copyRoot: "/tmp/probe/tampered-asar/CivCom.app", executable: "/tmp/probe/tampered-asar/CivCom.app/Contents/MacOS/CivCom", resources: "/tmp/probe/tampered-asar/CivCom.app/Contents/Resources", smokeResult: "/tmp/probe/tampered-asar-user-data/packaged-smoke.json" });
    const windows = createTamperProbePlan({ target: "windows", layout: { appRoot: "C:\\release\\win-unpacked" }, scratchDirectory: "C:\\Temp\\probe" });
    expect(windows.attempts[1]).toMatchObject({ copyRoot: "C:\\Temp\\probe\\loose-app\\win-unpacked", executable: "C:\\Temp\\probe\\loose-app\\win-unpacked\\CivCom.exe", resources: "C:\\Temp\\probe\\loose-app\\win-unpacked\\resources" });
    expect(() => createTamperProbePlan({ target: "linux", layout: { appRoot: "/release/linux-unpacked" }, scratchDirectory: "/tmp/probe" })).toThrow();
    expect(() => validateTamperProbeOutcome({ status: 1, signal: null, timedOut: false, smokeResultExists: false })).not.toThrow();
    expect(() => validateTamperProbeOutcome({ status: null, signal: "SIGTRAP", timedOut: false, smokeResultExists: false })).not.toThrow();
    for (const outcome of [
      { status: 0, signal: null, timedOut: false, smokeResultExists: false },
      { status: 1, signal: null, timedOut: false, smokeResultExists: true },
      { status: null, signal: "SIGKILL", timedOut: true, smokeResultExists: false },
      { status: null, signal: null, timedOut: false, smokeResultExists: false }
    ]) expect(() => validateTamperProbeOutcome(outcome)).toThrow();
  });

  it("validates effective macOS usage strings/integrity, Windows integrity, and smoke evidence", async () => {
    const { validateMacInfoPlist, validateSmokeResult, validateWindowsIntegrityEntries } = await loadModule();
    const mac = {
      NSCameraUsageDescription: "CivCom używa kamery wyłącznie podczas połączeń wybranych przez użytkownika.",
      NSMicrophoneUsageDescription: "CivCom używa mikrofonu wyłącznie podczas połączeń wybranych przez użytkownika.",
      NSScreenCaptureUsageDescription: "CivCom udostępnia wybrany ekran lub okno wyłącznie po potwierdzeniu użytkownika.",
      NSAudioCaptureUsageDescription: "CivCom może przechwycić dźwięk wybranego źródła podczas udostępniania za zgodą użytkownika.",
      ElectronAsarIntegrity: { "Resources/app.asar": { algorithm: "SHA256", hash: "a".repeat(64) } }
    };
    expect(() => validateMacInfoPlist(mac)).not.toThrow();
    expect(() => validateMacInfoPlist({ ...mac, ElectronAsarIntegrity: {} })).toThrow();
    const win = [{ file: "resources\\app.asar", alg: "SHA256", value: "b".repeat(64) }];
    expect(() => validateWindowsIntegrityEntries(win)).not.toThrow();
    expect(() => validateWindowsIntegrityEntries([{ ...win[0], file: "resources\\other.asar" }])).toThrow();
    expect(() => validateSmokeResult({ schemaVersion: 1, status: "ok", windowVisible: true, loadedUrl: "data:text/html;charset=utf-8,test" })).not.toThrow();
    expect(() => validateSmokeResult({ schemaVersion: 1, status: "ok", windowVisible: false, loadedUrl: "https://civcom.soia.gov.pl/" })).toThrow();
  });

  it("parses an explicit verification mode and target without ambiguous extras", async () => {
    const { parseVerifierArguments } = await loadModule();
    expect(parseVerifierArguments(["--mode", "pilot", "--target", "macos"], { CIVCOM_BUILD_MODE: "pilot" })).toEqual({ mode: "pilot", target: "macos" });
    for (const args of [[], ["--mode", "pilot"], ["--mode", "debug", "--target", "macos"], ["--target", "macos", "--mode", "pilot", "extra"], ["--mode", "pilot", "--mode", "pilot", "--target", "macos"]]) expect(() => parseVerifierArguments(args)).toThrow();
    expect(() => parseVerifierArguments(["--mode", "pilot", "--target", "macos"], { CIVCOM_BUILD_MODE: "production" })).toThrow();
  });

  it("accepts a safe full Windows Subject DN without assuming RDN order or attributes", async () => {
    const { validateWindowsPublisherSubject } = await loadModule();
    const subject = "C=PL, O=Test Organisation, OU=Release Engineering, CN=Test Fixture";
    expect(validateWindowsPublisherSubject(subject)).toBe(subject);
    for (const value of ["", "root", " CN=leading-space", "CN=control\nO=bad", "x".repeat(4097)]) expect(() => validateWindowsPublisherSubject(value)).toThrow();
  });

  it("requires hardened Developer ID/team, universal binaries, and timestamped exact-subject Authenticode", async () => {
    const { validateAuthenticodeResult, validateMacAdHocSigningDetails, validateMacSigningDetails, validateUniversalArchitectures } = await loadModule();
    expect(() => validateMacAdHocSigningDetails("Signature=adhoc\nTeamIdentifier=not set\nflags=0x2(adhoc)\n")).not.toThrow();
    for (const details of ["Signature=adhoc\nAuthority=Developer ID Application: Fixture\nTeamIdentifier=A1B2C3D4E5\n", "Signature=adhoc\nTeamIdentifier=A1B2C3D4E5\n", "Signature=Developer ID\nTeamIdentifier=not set\n"]) expect(() => validateMacAdHocSigningDetails(details)).toThrow();
    expect(() => validateMacSigningDetails("Authority=Developer ID Application: Fixture\nTeamIdentifier=A1B2C3D4E5\nflags=0x10000(runtime)", "A1B2C3D4E5")).not.toThrow();
    for (const details of ["TeamIdentifier=A1B2C3D4E5\nflags=0x10000(runtime)", "Authority=Developer ID Application: Fixture\nTeamIdentifier=OTHERTEAM1\nflags=0x10000(runtime)", "Authority=Developer ID Application: Fixture\nTeamIdentifier=A1B2C3D4E5\nflags=0x0(none)"]) expect(() => validateMacSigningDetails(details, "A1B2C3D4E5")).toThrow();
    expect(() => validateUniversalArchitectures("x86_64 arm64\n")).not.toThrow();
    expect(() => validateUniversalArchitectures("arm64\n")).toThrow();
    const subject = "C=PL, O=Test Organisation, CN=Test Fixture";
    expect(() => validateAuthenticodeResult({ Status: "Valid", Subject: subject, TimestampSubject: "CN=Test Timestamp Authority" }, subject)).not.toThrow();
    for (const result of [{ Status: "NotSigned", Subject: subject, TimestampSubject: "CN=Time" }, { Status: "Valid", Subject: "CN=Other", TimestampSubject: "CN=Time" }, { Status: "Valid", Subject: subject, TimestampSubject: null }]) expect(() => validateAuthenticodeResult(result, subject)).toThrow();
  });
});
