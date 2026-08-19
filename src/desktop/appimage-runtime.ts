import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats
} from "node:fs";
import { isAbsolute, join } from "node:path";

const APPIMAGE_TYPE2_HEADER_BYTES = 11;
const APPIMAGE_MAGIC_OFFSET = 8;
const APPIMAGE_MAGIC = Object.freeze([0x41, 0x49, 0x02]);
const EXPECTED_EXECUTABLE_NAME = "civcom";

function safeAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 4096 && isAbsolute(value) && ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function executable(mode: bigint): boolean {
  return (mode & 0o111n) !== 0n;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function canonicalDirectory(path: unknown): path is string {
  if (!safeAbsolutePath(path)) return false;
  const metadata = lstatSync(path, { bigint: true });
  return metadata.isDirectory() && !metadata.isSymbolicLink() && realpathSync(path) === path;
}

function canonicalExecutable(path: unknown): path is string {
  if (!safeAbsolutePath(path)) return false;
  const metadata = lstatSync(path, { bigint: true });
  return metadata.isFile() && !metadata.isSymbolicLink() && executable(metadata.mode) && realpathSync(path) === path;
}

function validMountedRuntime(appDir: unknown, executablePath: unknown, resourcesPath: unknown): boolean {
  if (!canonicalDirectory(appDir)) return false;
  if (executablePath !== join(appDir, EXPECTED_EXECUTABLE_NAME) || !canonicalExecutable(executablePath)) return false;
  if (resourcesPath !== join(appDir, "resources") || !canonicalDirectory(resourcesPath)) return false;
  return canonicalExecutable(join(appDir, "AppRun"));
}

/**
 * Binds the persistent APPIMAGE file to the exact static-runtime AppDir that
 * launched Electron. The file is inspected through one no-follow descriptor;
 * path and descriptor identity are compared again before it is accepted.
 */
export function resolveVerifiedAppImageRuntime(input: Readonly<{
  appImagePath: unknown;
  appDir: unknown;
  executablePath: unknown;
  resourcesPath: unknown;
}>): string | undefined {
  let descriptor: number | undefined;
  try {
    if (!safeAbsolutePath(input.appImagePath) || typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) return undefined;
    descriptor = openSync(input.appImagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const initial = fstatSync(descriptor, { bigint: true });
    if (!initial.isFile() || !executable(initial.mode) || initial.size < BigInt(APPIMAGE_TYPE2_HEADER_BYTES)) return undefined;

    const header = Buffer.alloc(APPIMAGE_TYPE2_HEADER_BYTES);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) return undefined;
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return undefined;
    if (!APPIMAGE_MAGIC.every((byte, index) => header[APPIMAGE_MAGIC_OFFSET + index] === byte)) return undefined;

    const resolved = realpathSync(input.appImagePath);
    if (resolved !== input.appImagePath) return undefined;
    const pathSnapshot = statSync(resolved, { bigint: true });
    if (!sameFileSnapshot(initial, pathSnapshot)) return undefined;
    if (!validMountedRuntime(input.appDir, input.executablePath, input.resourcesPath)) return undefined;

    const finalDescriptorSnapshot = fstatSync(descriptor, { bigint: true });
    const finalPathSnapshot = statSync(resolved, { bigint: true });
    if (!sameFileSnapshot(initial, finalDescriptorSnapshot) || !sameFileSnapshot(initial, finalPathSnapshot)) return undefined;
    return resolved;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* inspection is already fail-closed */ }
    }
  }
}
