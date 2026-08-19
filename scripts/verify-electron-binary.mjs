import { access, constants, lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXPECTED_ELECTRON_VERSION = "43.4.1";

const binaryByPlatform = {
  darwin: ["Electron.app", "Contents", "MacOS", "Electron"],
  linux: ["electron"],
  win32: ["electron.exe"]
};

async function requireExecutable(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) throw new Error(`${label} is not a regular nonempty file`);
  await access(path, constants.X_OK);
}

export async function verifyElectronInstallation(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Electron installation verification input");
  const { installationRoot, platform, expectedVersion } = input;
  if (typeof installationRoot !== "string" || !isAbsolute(installationRoot)) throw new Error("Electron installation root must be absolute");
  if (expectedVersion !== EXPECTED_ELECTRON_VERSION) throw new Error("Unexpected Electron version expectation");
  const binaryParts = binaryByPlatform[platform];
  if (binaryParts === undefined) throw new Error(`Unsupported platform for Electron binary verification: ${String(platform)}`);

  const packageMetadata = JSON.parse(await readFile(join(installationRoot, "package.json"), "utf8"));
  if (packageMetadata === null || typeof packageMetadata !== "object" || packageMetadata.name !== "electron" || packageMetadata.version !== expectedVersion) throw new Error("Electron package version differs from the pinned version");
  const [installedVersion, installedPath] = await Promise.all([
    readFile(join(installationRoot, "dist", "version"), "utf8"),
    readFile(join(installationRoot, "path.txt"), "utf8")
  ]);
  if (installedVersion !== expectedVersion || installedPath !== binaryParts.join("/")) throw new Error("Installed Electron version or platform path differs from the pinned package");
  const binary = join(installationRoot, "dist", ...binaryParts);
  await requireExecutable(binary, "Electron binary");
  if (platform === "linux") await requireExecutable(join(installationRoot, "dist", "chrome-sandbox"), "Electron sandbox helper");
}

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyElectronInstallation({ installationRoot: join(projectRoot, "node_modules", "electron"), platform: process.platform, expectedVersion: EXPECTED_ELECTRON_VERSION });
}
