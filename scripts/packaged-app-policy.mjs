import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";

const LINUX_DESKTOP_FILE = "info.soia.civcom.desktop.desktop";
const LINUX_APP_IMAGE = "CivCom-Linux-x86_64.AppImage";
const LINUX_DEB = "CivCom-Linux-x86_64.deb";

const USAGE_STRINGS = Object.freeze({
  NSCameraUsageDescription: "CivCom używa kamery wyłącznie podczas połączeń wybranych przez użytkownika.",
  NSMicrophoneUsageDescription: "CivCom używa mikrofonu wyłącznie podczas połączeń wybranych przez użytkownika.",
  NSScreenCaptureUsageDescription: "CivCom udostępnia wybrany ekran lub okno wyłącznie po potwierdzeniu użytkownika.",
  NSAudioCaptureUsageDescription: "CivCom może przechwycić dźwięk wybranego źródła podczas udostępniania za zgodą użytkownika."
});

function plainRecord(value, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
  return value;
}

function absoluteDirectory(value, windows = false) {
  if (typeof value !== "string" || value === "" || [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) throw new Error("Invalid release directory");
  if (!(windows ? win32.isAbsolute(value) : isAbsolute(value))) throw new Error("Release directory must be absolute");
  return value;
}

export function resolvePackagedLayout(input) {
  if (input === null || typeof input !== "object") throw new Error("Invalid packaged-layout input");
  const target = input.target;
  if (target === "windows") {
    const release = absoluteDirectory(input.releaseDirectory, true);
    const appRoot = win32.join(release, "win-unpacked");
    return Object.freeze({ appRoot, executable: win32.join(appRoot, "CivCom.exe"), resources: win32.join(appRoot, "resources"), smokeExecutable: win32.join(appRoot, "CivCom.exe") });
  }
  const release = absoluteDirectory(input.releaseDirectory);
  if (target === "macos") {
    const appRoot = join(release, "mac-universal", "CivCom.app");
    return Object.freeze({ appRoot, executable: join(appRoot, "Contents", "MacOS", "CivCom"), resources: join(appRoot, "Contents", "Resources"), infoPlist: join(appRoot, "Contents", "Info.plist"), smokeExecutable: join(appRoot, "Contents", "MacOS", "CivCom") });
  }
  if (target === "linux") {
    const appRoot = join(release, "linux-unpacked");
    return Object.freeze({ appRoot, executable: join(appRoot, "civcom"), resources: join(appRoot, "resources"), smokeExecutable: join(release, "CivCom-Linux-x86_64.AppImage") });
  }
  throw new Error("Unsupported packaged target");
}

async function requireRegular(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) throw new Error(`Invalid packaged ${label}`);
}

export async function verifyPackagedLayout(layoutValue, expectedMarker) {
  const layout = plainRecord(layoutValue, "Invalid packaged layout");
  if (typeof expectedMarker !== "string" || !/^(windows|macos|deb)$/.test(expectedMarker)) throw new Error("Invalid package marker expectation");
  for (const key of ["appRoot", "executable", "resources"]) if (typeof layout[key] !== "string" || layout[key] === "") throw new Error("Incomplete packaged layout");
  const appRoot = await lstat(layout.appRoot);
  if (!appRoot.isDirectory() || appRoot.isSymbolicLink()) throw new Error("Invalid packaged application root");
  await requireRegular(layout.executable, "executable");
  await requireRegular(join(layout.resources, "app.asar"), "ASAR");
  await requireRegular(join(layout.resources, "package-type"), "package marker");
  try {
    await lstat(join(layout.resources, "app"));
    throw new Error("Loose resources/app is forbidden");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  if (await readFile(join(layout.resources, "package-type"), "utf8") !== `${expectedMarker}\n`) throw new Error("Unexpected package marker");
}

export function createLaunchPlan(input) {
  if (input === null || typeof input !== "object" || !["windows", "macos", "linux"].includes(input.target)) throw new Error("Invalid smoke launch input");
  const layout = plainRecord(input.layout, "Invalid smoke layout");
  if (typeof layout.smokeExecutable !== "string" || layout.smokeExecutable === "") throw new Error("Missing smoke executable");
  const userData = input.userDataDirectory;
  if (typeof userData !== "string" || (!isAbsolute(userData) && !win32.isAbsolute(userData)) || [...userData].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) throw new Error("Invalid smoke user-data directory");
  const environment = {};
  const source = input.environment ?? {};
  const allowedEnvironment = new Set(["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TMP", "TEMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]);
  for (const key of Object.keys(source)) {
    if (!allowedEnvironment.has(key)) continue;
    const value = source[key];
    if (typeof value === "string") environment[key] = value;
  }
  environment.NO_COLOR = "1";
  const args = [`--user-data-dir=${userData}`, "--civcom-packaged-smoke"];
  if (args.some((value) => /--inspect|--no-sandbox|civcom\.soia\.gov\.pl|matrix\.org/i.test(value))) throw new Error("Unsafe smoke launch argument");
  return Object.freeze({ command: layout.smokeExecutable, args: Object.freeze(args), environment: Object.freeze(environment) });
}

export function createLinuxInspectionPlan(input) {
  const layout = plainRecord(input?.layout, "Invalid Linux inspection layout");
  const appImage = layout.smokeExecutable;
  const scratch = input?.scratchDirectory;
  if (typeof appImage !== "string" || !isAbsolute(appImage) || basename(appImage) !== LINUX_APP_IMAGE || typeof scratch !== "string" || !isAbsolute(scratch)) throw new Error("Invalid Linux inspection paths");
  const release = dirname(appImage);
  const debRoot = join(scratch, "deb");
  const appImageRoot = join(scratch, "appimage");
  return Object.freeze({
    deb: Object.freeze({ command: "dpkg-deb", args: Object.freeze(["--extract", join(release, LINUX_DEB), debRoot]), desktopFile: join(debRoot, "usr", "share", "applications", LINUX_DESKTOP_FILE) }),
    appImage: Object.freeze({ command: appImage, args: Object.freeze(["--appimage-extract"]), cwd: appImageRoot, desktopFile: join(appImageRoot, "squashfs-root", LINUX_DESKTOP_FILE) })
  });
}

export function createTamperProbePlan(input) {
  const layout = plainRecord(input?.layout, "Invalid tamper probe layout");
  const target = input?.target;
  const windows = target === "windows";
  if (!windows && target !== "macos") throw new Error("ASAR tamper probes are supported only on Windows and macOS");
  const appRoot = absoluteDirectory(layout.appRoot, windows);
  const scratch = absoluteDirectory(input?.scratchDirectory, windows);
  const pathApi = windows ? win32 : { basename, join };
  const rootName = pathApi.basename(appRoot);
  if ((windows && rootName !== "win-unpacked") || (!windows && rootName !== "CivCom.app")) throw new Error("Unexpected tamper probe application root");
  const attempts = ["tampered-asar", "loose-app"].map((kind) => {
    const copyRoot = pathApi.join(scratch, kind, rootName);
    const executable = windows ? pathApi.join(copyRoot, "CivCom.exe") : pathApi.join(copyRoot, "Contents", "MacOS", "CivCom");
    const resources = windows ? pathApi.join(copyRoot, "resources") : pathApi.join(copyRoot, "Contents", "Resources");
    const userData = pathApi.join(scratch, `${kind}-user-data`);
    return Object.freeze({ kind, copyRoot, appRoot: copyRoot, executable, resources, smokeExecutable: executable, ...(!windows ? { infoPlist: pathApi.join(copyRoot, "Contents", "Info.plist") } : {}), userData, smokeResult: pathApi.join(userData, "packaged-smoke.json") });
  });
  return Object.freeze({ sourceRoot: appRoot, attempts: Object.freeze(attempts) });
}

export function validateTamperProbeOutcome(value) {
  const outcome = plainRecord(value, "Invalid ASAR tamper probe outcome");
  const failedByStatus = Number.isInteger(outcome.status) && outcome.status > 0 && outcome.signal === null;
  const failedBySignal = outcome.status === null && typeof outcome.signal === "string" && /^SIG[A-Z0-9]+$/.test(outcome.signal);
  if (outcome.timedOut !== false || outcome.smokeResultExists !== false || (!failedByStatus && !failedBySignal)) throw new Error("ASAR tamper probe did not fail closed promptly");
}

export function validateLinuxDesktopEntry(value, variant, expectedVersion) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024 || !value.endsWith("\n") || value.includes("\r") || (variant !== "deb" && variant !== "appimage") || typeof expectedVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) throw new Error("Invalid Linux desktop entry input");
  const lines = value.slice(0, -1).split("\n");
  if (lines.shift() !== "[Desktop Entry]" || lines.some((line) => line === "" || line.startsWith("["))) throw new Error("Invalid Linux desktop entry structure");
  const entries = {};
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9-]*)=(.*)$/.exec(line);
    if (match === null || Object.hasOwn(entries, match[1])) throw new Error("Invalid or duplicate Linux desktop entry key");
    entries[match[1]] = match[2];
  }
  const expected = {
    Name: "CivCom",
    Terminal: "false",
    Type: "Application",
    Icon: "civcom",
    StartupWMClass: "info.soia.civcom.desktop",
    StartupNotify: "true",
    "X-GNOME-UsesNotifications": "true",
    Keywords: "CivCom;Matrix;komunikator;wiadomości;",
    Categories: "Network;InstantMessaging;",
    Exec: variant === "deb" ? "/opt/CivCom/civcom %U" : "AppRun %U"
  };
  for (const [key, expectedValue] of Object.entries(expected)) if (entries[key] !== expectedValue) throw new Error(`Unexpected Linux desktop entry: ${key}`);
  if (Object.hasOwn(entries, "MimeType")) throw new Error("The remote CivCom app must not install a protocol handler");
  if (variant === "appimage") {
    if (entries["X-AppImage-Version"] !== expectedVersion) throw new Error("Unexpected AppImage desktop version");
  } else if (Object.hasOwn(entries, "X-AppImage-Version")) throw new Error("Unexpected DEB AppImage metadata");
}

export function validateMacEntitlementKeys(value, profile) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024 || (profile !== "root" && profile !== "inherit")) throw new Error("Invalid effective macOS entitlements");
  const keys = [...value.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort();
  const expected = (profile === "root"
    ? ["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input", "com.apple.security.device.camera"]
    : ["com.apple.security.cs.allow-jit"]).sort();
  if (keys.length !== expected.length || new Set(keys).size !== keys.length || keys.some((key, index) => key !== expected[index])) throw new Error("Unexpected effective macOS entitlements");
}

function validIntegrity(value, pathKey, algorithmKey, hashKey) {
  const record = plainRecord(value, "Invalid ASAR integrity record");
  return record[pathKey] === "Resources/app.asar" || record[pathKey] === "resources\\app.asar"
    ? record[algorithmKey] === "SHA256" && typeof record[hashKey] === "string" && /^[0-9a-f]{64}$/.test(record[hashKey])
    : false;
}

export function validateMacInfoPlist(value) {
  const plist = plainRecord(value, "Invalid macOS Info.plist");
  for (const [key, expected] of Object.entries(USAGE_STRINGS)) if (plist[key] !== expected) throw new Error(`Missing effective macOS usage string: ${key}`);
  const integrity = plainRecord(plist.ElectronAsarIntegrity, "Missing macOS ASAR integrity");
  const entry = integrity["Resources/app.asar"];
  if (Object.keys(integrity).length !== 1 || !validIntegrity({ path: "Resources/app.asar", ...plainRecord(entry, "Invalid macOS ASAR integrity") }, "path", "algorithm", "hash")) throw new Error("Invalid macOS ASAR integrity");
}

export function validateWindowsIntegrityEntries(value) {
  if (!Array.isArray(value) || value.length !== 1 || !validIntegrity(value[0], "file", "alg", "value")) throw new Error("Invalid Windows ASAR integrity resource");
}

export function validateSmokeResult(value) {
  const result = plainRecord(value, "Invalid packaged smoke result");
  if (result.schemaVersion !== 1 || result.status !== "ok" || result.windowVisible !== true || typeof result.loadedUrl !== "string" || !result.loadedUrl.startsWith("data:text/html;charset=utf-8,") || result.loadedUrl.length > 64 * 1024) throw new Error("Packaged smoke did not prove an offline visible window");
}

export function parseVerifierArguments(args, environment = {}) {
  if (!Array.isArray(args) || args.length !== 4) throw new Error("Expected --mode and --target verification arguments");
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if ((key !== "--mode" && key !== "--target") || Object.hasOwn(values, key) || typeof value !== "string") throw new Error("Invalid packaged verifier arguments");
    values[key] = value;
  }
  const mode = values["--mode"];
  const target = values["--target"];
  if (mode !== "pilot" && mode !== "production") throw new Error("Invalid packaged verification mode");
  if (target !== "windows" && target !== "macos" && target !== "linux") throw new Error("Invalid packaged verification target");
  let environmentMode;
  try {
    const descriptor = environment !== null && typeof environment === "object" ? Object.getOwnPropertyDescriptor(environment, "CIVCOM_BUILD_MODE") : undefined;
    environmentMode = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    environmentMode = undefined;
  }
  if (environmentMode !== undefined && environmentMode !== mode) throw new Error("Verification mode differs from packaging mode");
  return Object.freeze({ mode, target });
}

export function validateWindowsPublisherSubject(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || value.length > 2048 || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) throw new Error("Invalid Windows publisher Subject DN");
  const equals = value.indexOf("=");
  if (equals <= 0 || equals === value.length - 1) throw new Error("Invalid Windows publisher Subject DN");
  return value;
}

export function validateMacAdHocSigningDetails(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024 || !/^Signature=adhoc$/m.test(value) || !/^TeamIdentifier=not set$/m.test(value) || /^Authority=/m.test(value)) throw new Error("macOS pilot is not exclusively ad hoc signed");
}

export function validateMacSigningDetails(value, expectedTeam) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024 || typeof expectedTeam !== "string" || !/^[A-Z0-9]{10}$/.test(expectedTeam)) throw new Error("Invalid macOS signing evidence");
  if (!/^Authority=Developer ID Application:.+$/m.test(value) || !new RegExp(`^TeamIdentifier=${expectedTeam}$`, "m").test(value) || !/^flags=0x[0-9a-f]+\([^\n]*runtime[^\n]*\)$/mi.test(value)) throw new Error("macOS package lacks hardened Developer ID/team evidence");
}

export function validateUniversalArchitectures(value) {
  if (typeof value !== "string") throw new Error("Invalid architecture evidence");
  const architectures = value.trim().split(/\s+/).filter(Boolean);
  if (architectures.length !== 2 || new Set(architectures).size !== 2 || !architectures.includes("arm64") || !architectures.includes("x86_64")) throw new Error("macOS binary is not exactly universal arm64/x86_64");
}

export function validateAuthenticodeResult(value, expectedSubject) {
  const result = plainRecord(value, "Invalid Authenticode evidence");
  const subject = validateWindowsPublisherSubject(expectedSubject);
  if (result.Status !== "Valid" || result.Subject !== subject || typeof result.TimestampSubject !== "string" || result.TimestampSubject.trim() === "" || result.TimestampSubject.length > 2048) throw new Error("Authenticode signature, exact Subject, or timestamp is invalid");
}
