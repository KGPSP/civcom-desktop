import { lstat, realpath } from "node:fs/promises";
import { posix } from "node:path";

export const INSTALLED_CIVCOM_ROOT = "/opt/CivCom";

function safeCanonicalRoot(root) {
  if (typeof root !== "string" || root.length === 0 || root.length > 4096 || !posix.isAbsolute(root) || posix.normalize(root) !== root || root === "/" || posix.basename(root) !== "CivCom" || [...root].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) throw new Error("Invalid installed CivCom root");
  return root;
}

export function createInstalledDebLayout(root = INSTALLED_CIVCOM_ROOT) {
  const appRoot = safeCanonicalRoot(root);
  return Object.freeze({
    appRoot,
    executable: posix.join(appRoot, "civcom"),
    resources: posix.join(appRoot, "resources"),
    smokeExecutable: posix.join(appRoot, "civcom"),
    sandboxHelper: posix.join(appRoot, "chrome-sandbox")
  });
}

function rootOwned(metadata) {
  return metadata.uid === 0 && metadata.gid === 0;
}

const SAFE_INSTALLED_MODES = Object.freeze({
  root: Object.freeze([0o755]),
  executable: Object.freeze([0o755]),
  resources: Object.freeze([0o755]),
  sandbox: Object.freeze([0o755, 0o4755]),
  profile: Object.freeze([0o644]),
  asar: Object.freeze([0o644]),
  packageMarker: Object.freeze([0o644])
});

export function validateInstalledDebPermissions(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid installed CivCom permissions");
  for (const [name, allowedModes] of Object.entries(SAFE_INSTALLED_MODES)) {
    const metadata = input[name];
    if (metadata === null
      || typeof metadata !== "object"
      || !Number.isSafeInteger(metadata.uid)
      || !Number.isSafeInteger(metadata.gid)
      || !Number.isSafeInteger(metadata.mode)
      || !rootOwned(metadata)
      || !allowedModes.includes(metadata.mode & 0o7777)) throw new Error("Invalid installed CivCom permissions");
  }
}

export async function verifyInstalledDebInstallation(layout) {
  const expected = createInstalledDebLayout();
  if (layout === null || typeof layout !== "object" || Object.keys(expected).some((key) => layout[key] !== expected[key])) throw new Error("Unexpected installed CivCom layout");
  const profilePath = posix.join(expected.resources, "apparmor-profile");
  const asarPath = posix.join(expected.resources, "app.asar");
  const packageMarkerPath = posix.join(expected.resources, "package-type");
  const [root, executable, resources, sandbox, profile, asar, packageMarker] = await Promise.all([
    lstat(expected.appRoot),
    lstat(expected.executable),
    lstat(expected.resources),
    lstat(expected.sandboxHelper),
    lstat(profilePath),
    lstat(asarPath),
    lstat(packageMarkerPath)
  ]);
  validateInstalledDebPermissions({ root, executable, resources, sandbox, profile, asar, packageMarker });
  if (!root.isDirectory() || root.isSymbolicLink() || !rootOwned(root) || await realpath(expected.appRoot) !== expected.appRoot) throw new Error("Invalid installed CivCom root");
  if (!executable.isFile() || executable.isSymbolicLink() || executable.size <= 0 || !rootOwned(executable) || (executable.mode & 0o111) === 0 || await realpath(expected.executable) !== expected.executable) throw new Error("Invalid installed CivCom executable");
  if (!resources.isDirectory() || resources.isSymbolicLink() || !rootOwned(resources) || await realpath(expected.resources) !== expected.resources) throw new Error("Invalid installed CivCom resources");
  const sandboxMode = sandbox.mode & 0o7777;
  if (!sandbox.isFile() || sandbox.isSymbolicLink() || sandbox.size <= 0 || !rootOwned(sandbox) || (sandboxMode !== 0o755 && sandboxMode !== 0o4755) || await realpath(expected.sandboxHelper) !== expected.sandboxHelper) throw new Error("Invalid installed Chromium sandbox helper");
  if (!profile.isFile() || profile.isSymbolicLink() || profile.size <= 0 || !rootOwned(profile) || await realpath(profilePath) !== profilePath) throw new Error("Invalid installed CivCom AppArmor profile");
  if (!asar.isFile() || asar.isSymbolicLink() || asar.size <= 0 || !rootOwned(asar) || await realpath(asarPath) !== asarPath) throw new Error("Invalid installed CivCom ASAR");
  if (!packageMarker.isFile() || packageMarker.isSymbolicLink() || packageMarker.size <= 0 || !rootOwned(packageMarker) || await realpath(packageMarkerPath) !== packageMarkerPath) throw new Error("Invalid installed CivCom package marker");
}
