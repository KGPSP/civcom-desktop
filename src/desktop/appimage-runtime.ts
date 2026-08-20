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
import { posix } from "node:path";

const APPIMAGE_TYPE2_HEADER_BYTES = 11;
const APPIMAGE_MAGIC_OFFSET = 8;
const APPIMAGE_MAGIC = Object.freeze([0x41, 0x49, 0x02]);
const EXPECTED_EXECUTABLE_NAME = "civcom";

function safeAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 4096 && posix.isAbsolute(value) && ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function isType2AppImageHeader(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
    && value.byteLength >= APPIMAGE_TYPE2_HEADER_BYTES
    && value[0] === 0x7f
    && value[1] === 0x45
    && value[2] === 0x4c
    && value[3] === 0x46
    && APPIMAGE_MAGIC.every((byte, index) => value[APPIMAGE_MAGIC_OFFSET + index] === byte);
}

export function hasExpectedAppImageRuntimePaths(input: Readonly<{
  appDir: unknown;
  executablePath: unknown;
  resourcesPath: unknown;
}>): boolean {
  try {
    return safeAbsolutePath(input.appDir)
      && safeAbsolutePath(input.executablePath)
      && safeAbsolutePath(input.resourcesPath)
      && input.executablePath === posix.join(input.appDir, EXPECTED_EXECUTABLE_NAME)
      && input.resourcesPath === posix.join(input.appDir, "resources");
  } catch {
    return false;
  }
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
  if (!hasExpectedAppImageRuntimePaths({ appDir, executablePath, resourcesPath })) return false;
  if (!canonicalDirectory(appDir)) return false;
  if (!canonicalExecutable(executablePath)) return false;
  if (!canonicalDirectory(resourcesPath)) return false;
  return canonicalExecutable(posix.join(appDir, "AppRun"));
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
    if (!isType2AppImageHeader(header)) return undefined;

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
