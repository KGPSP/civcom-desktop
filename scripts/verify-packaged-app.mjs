import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import { verifyUpdateMetadataFiles } from "./release-contract.mjs";
import { verifyFuseWire } from "./fuse-policy.mjs";
import { createInstalledDebLayout, verifyInstalledDebInstallation } from "./linux-installed-deb.mjs";
import { runPackagedCommand } from "./packaged-command.mjs";
import { createLaunchPlan, createLinuxInspectionPlan, createTamperProbePlan, parseVerifierArguments, resolvePackagedLayout, validateAuthenticodeResult, validateLinuxDesktopEntry, validateMacAdHocSigningDetails, validateMacEntitlementKeys, validateMacInfoPlist, validateMacSigningDetails, validateSmokeResult, validateTamperProbeOutcome, validateUniversalArchitectures, validateWindowsPublisherSubject, verifyPackagedLayout } from "./packaged-app-policy.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDirectory = join(projectRoot, "release");
const downloads = JSON.parse(await readFile(join(projectRoot, "docs", "downloads.json"), "utf8"));
const packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const fusePackage = JSON.parse(await readFile(join(projectRoot, "node_modules", "@electron", "fuses", "package.json"), "utf8"));

if (fusePackage.version !== "2.1.3") throw new Error("Packaged verification requires direct @electron/fuses 2.1.3");

function run(command, args, options = {}) {
  return runPackagedCommand(command, args, { cwd: options.cwd ?? projectRoot, environment: options.environment ?? process.env, timeout: options.timeout ?? 60_000 });
}

async function requireRegular(path, executable = false) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || (executable && (metadata.mode & 0o111) === 0)) throw new Error("Missing or invalid packaged artifact");
}

async function verifyMetadata(target) {
  if (target === "windows") {
    await Promise.all([requireRegular(join(releaseDirectory, downloads.assets.windowsInstaller)), requireRegular(join(releaseDirectory, downloads.assets.windowsBlockmap))]);
    await verifyUpdateMetadataFiles(releaseDirectory, await readFile(join(releaseDirectory, downloads.assets.windowsMetadata), "utf8"), downloads.assets.windowsInstaller, packageMetadata.version);
  } else if (target === "macos") {
    await Promise.all([requireRegular(join(releaseDirectory, downloads.assets.macDmg)), requireRegular(join(releaseDirectory, downloads.assets.macZip)), requireRegular(join(releaseDirectory, downloads.assets.macBlockmap))]);
    await verifyUpdateMetadataFiles(releaseDirectory, await readFile(join(releaseDirectory, downloads.assets.macMetadata), "utf8"), downloads.assets.macZip, packageMetadata.version);
  } else {
    await Promise.all([requireRegular(join(releaseDirectory, downloads.assets.linuxAppImage), true), requireRegular(join(releaseDirectory, downloads.assets.linuxDeb))]);
    await verifyUpdateMetadataFiles(releaseDirectory, await readFile(join(releaseDirectory, downloads.assets.linuxMetadata), "utf8"), [downloads.assets.linuxAppImage, downloads.assets.linuxDeb], packageMetadata.version);
  }
}

function plistJson(path) {
  return JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]));
}

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Missing or invalid packaged verification input: ${name}`);
  return value;
}

async function macUniversalBinaries(layout) {
  const frameworks = join(layout.appRoot, "Contents", "Frameworks");
  const binaries = [layout.executable, join(frameworks, "Electron Framework.framework", "Versions", "A", "Electron Framework")];
  const helperApps = (await readdir(frameworks, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith("CivCom Helper") && entry.name.endsWith(".app"));
  if (helperApps.length < 4) throw new Error("Expected macOS helper applications are missing");
  for (const helper of helperApps) {
    const macosDirectory = join(frameworks, helper.name, "Contents", "MacOS");
    const entries = await readdir(macosDirectory, { withFileTypes: true });
    const executables = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink());
    if (executables.length !== 1) throw new Error("Unexpected macOS helper executable layout");
    binaries.push(join(macosDirectory, executables[0].name));
  }
  for (const binary of binaries) {
    await requireRegular(binary, true);
    validateUniversalArchitectures(run("/usr/bin/lipo", ["-archs", binary]));
  }
  return Object.freeze({ binaries: Object.freeze(binaries), helperApps: Object.freeze(helperApps.map((helper) => join(frameworks, helper.name))) });
}

async function verifyMac(layout, mode) {
  validateMacInfoPlist(plistJson(layout.infoPlist));
  const { binaries: universalBinaries, helperApps } = await macUniversalBinaries(layout);
  if (mode === "pilot") {
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", layout.appRoot]);
    for (const binary of universalBinaries) validateMacAdHocSigningDetails(run("/usr/bin/codesign", ["-d", "--verbose=4", binary]));
    return;
  }
  const team = requiredEnvironment("APPLE_TEAM_ID", /^[A-Z0-9]{10}$/);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", layout.appRoot]);
  const details = run("/usr/bin/codesign", ["-d", "--verbose=4", layout.appRoot]);
  validateMacSigningDetails(details, team);
  for (const binary of universalBinaries) validateMacSigningDetails(run("/usr/bin/codesign", ["-d", "--verbose=4", binary]), team);
  validateMacEntitlementKeys(run("/usr/bin/codesign", ["-d", "--entitlements", ":-", layout.appRoot]), "root");
  for (const helperApp of helperApps) validateMacEntitlementKeys(run("/usr/bin/codesign", ["-d", "--entitlements", ":-", helperApp]), "inherit");
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", layout.appRoot]);
  run("/usr/bin/xcrun", ["stapler", "validate", layout.appRoot]);
  run("/usr/bin/xcrun", ["stapler", "validate", join(releaseDirectory, downloads.assets.macDmg)]);
}

function verifyAuthenticode(path, expectedSubject) {
  const script = join(projectRoot, "scripts", "verify-authenticode.ps1");
  const value = JSON.parse(run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", path]));
  validateAuthenticodeResult(value, expectedSubject);
}

function verifyWindows(layout, mode) {
  if (mode !== "production") return;
  const publisher = validateWindowsPublisherSubject(requiredEnvironment("CIVCOM_WINDOWS_PUBLISHER_DN", /^.{1,2048}$/));
  verifyAuthenticode(layout.executable, publisher);
  verifyAuthenticode(join(releaseDirectory, downloads.assets.windowsInstaller), publisher);
}

async function verifyLinux(layout, mode) {
  const maintainer = requiredEnvironment("CIVCOM_LINUX_MAINTAINER", /^[^<>]{2,100} <[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}>$/i);
  const deb = join(releaseDirectory, downloads.assets.linuxDeb);
  if (run("dpkg-deb", ["--field", deb, "Package"]).trim() !== "civcom") throw new Error("Unexpected DEB package name");
  if (run("dpkg-deb", ["--field", deb, "Maintainer"]).trim() !== maintainer) throw new Error("Unexpected DEB maintainer");
  const scratch = await mkdtemp(join(tmpdir(), "civcom-linux-inspection-"));
  try {
    const inspection = createLinuxInspectionPlan({ layout, scratchDirectory: scratch });
    const environment = createLaunchPlan({ target: "linux", layout, userDataDirectory: scratch, environment: process.env }).environment;
    run(inspection.deb.command, inspection.deb.args, { environment });
    validateLinuxDesktopEntry(await readFile(inspection.deb.desktopFile, "utf8"), "deb", packageMetadata.version);
    await mkdir(inspection.appImage.cwd, { mode: 0o700 });
    run(inspection.appImage.command, inspection.appImage.args, { cwd: inspection.appImage.cwd, environment, timeout: 90_000 });
    validateLinuxDesktopEntry(await readFile(inspection.appImage.desktopFile, "utf8"), "appimage", packageMetadata.version);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const installedLayout = createInstalledDebLayout();
  await verifyInstalledDebInstallation(installedLayout);
  await verifyPackagedLayout(installedLayout, "deb", mode, packageMetadata.version);
  verifyFuseWire(await getCurrentFuseWire(installedLayout.executable), { FuseState, FuseV1Options, FuseVersion });
  return installedLayout;
}

async function smoke(target, layout) {
  const userData = await mkdtemp(join(tmpdir(), "civcom-packaged-smoke-"));
  try {
    const plan = createLaunchPlan({ target, layout, userDataDirectory: userData, environment: process.env });
    if (target === "linux") run("xvfb-run", ["-a", plan.command, ...plan.args], { cwd: userData, environment: plan.environment, timeout: 90_000 });
    else run(plan.command, plan.args, { cwd: userData, environment: plan.environment, timeout: 60_000 });
    validateSmokeResult(JSON.parse(await readFile(join(userData, "packaged-smoke.json"), "utf8")));
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
}

async function mutateAsarByte(path) {
  const handle = await open(path, "r+");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 64) throw new Error("ASAR is too small for a tamper probe");
    const byte = Buffer.alloc(1);
    const position = metadata.size - 1;
    const readResult = await handle.read(byte, 0, 1, position);
    if (readResult.bytesRead !== 1) throw new Error("Could not read ASAR tamper byte");
    byte[0] ^= 1;
    const writeResult = await handle.write(byte, 0, 1, position);
    if (writeResult.bytesWritten !== 1) throw new Error("Could not write ASAR tamper byte");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path) {
  try { await lstat(path); return true; } catch (error) { if (error && typeof error === "object" && error.code === "ENOENT") return false; throw error; }
}

const LOOSE_PROBE_MAIN = `"use strict";\nconst { app } = require("electron");\nconst { writeFileSync } = require("node:fs");\nconst { join } = require("node:path");\nvoid app.whenReady().then(() => { writeFileSync(join(app.getPath("userData"), "packaged-smoke.json"), "loose-app-executed\\n", { flag: "wx", mode: 0o600 }); app.exit(0); });\n`;

async function installLooseProbe(resources) {
  await rm(join(resources, "app.asar"));
  const loose = join(resources, "app");
  await mkdir(loose, { mode: 0o700 });
  await writeFile(join(loose, "package.json"), '{"name":"civcom-loose-probe","version":"1.0.0","main":"index.cjs"}\n', { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(join(loose, "index.cjs"), LOOSE_PROBE_MAIN, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function rawProbeLaunch(plan, cwd) {
  return spawnSync(plan.command, plan.args, { cwd, env: plan.environment, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000, killSignal: "SIGKILL", shell: false });
}

async function verifyAsarTamperResistance(target, layout, mode) {
  if (target === "linux") return;
  const scratch = await mkdtemp(join(tmpdir(), "civcom-asar-tamper-"));
  try {
    const probe = createTamperProbePlan({ target, layout, scratchDirectory: scratch });
    for (const attempt of probe.attempts) {
      await mkdir(dirname(attempt.copyRoot), { recursive: true, mode: 0o700 });
      await cp(probe.sourceRoot, attempt.copyRoot, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true });
      await verifyPackagedLayout(attempt, target === "windows" ? "windows" : "macos", mode, packageMetadata.version);
      verifyFuseWire(await getCurrentFuseWire(attempt.executable), { FuseState, FuseV1Options, FuseVersion });
      if (attempt.kind === "tampered-asar") await mutateAsarByte(join(attempt.resources, "app.asar"));
      else await installLooseProbe(attempt.resources);
      if (target === "macos") run("/usr/bin/codesign", ["--sign", "-", "--force", "--preserve-metadata=entitlements,requirements,flags,runtime", "--deep", attempt.copyRoot]);
      await mkdir(attempt.userData, { mode: 0o700 });
      const launch = createLaunchPlan({ target, layout: attempt, userDataDirectory: attempt.userData, environment: process.env });
      const result = rawProbeLaunch(launch, attempt.userData);
      validateTamperProbeOutcome({
        status: result.status,
        signal: result.signal,
        timedOut: result.error !== undefined && result.error.code === "ETIMEDOUT",
        smokeResultExists: await pathExists(attempt.smokeResult)
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function verifyPackagedApplication(argumentsList = process.argv.slice(2)) {
  const { mode, target } = parseVerifierArguments(argumentsList, process.env);
  const nativeTarget = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "unsupported";
  if (target !== nativeTarget) throw new Error("Packaged verification must run on its native platform");
  const layout = resolvePackagedLayout({ target, releaseDirectory });
  await verifyPackagedLayout(layout, target === "linux" ? "deb" : target, mode, packageMetadata.version);
  verifyFuseWire(await getCurrentFuseWire(layout.executable), { FuseState, FuseV1Options, FuseVersion });
  await verifyMetadata(target);
  if (target === "macos") await verifyMac(layout, mode);
  else if (target === "windows") verifyWindows(layout, mode);
  const smokeLayout = target === "linux" ? await verifyLinux(layout, mode) : layout;
  await smoke(target, smokeLayout);
  if (target === "linux" && mode === "production") await smoke(target, layout);
  await verifyAsarTamperResistance(target, layout, mode);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyPackagedApplication();
