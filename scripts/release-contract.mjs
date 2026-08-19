import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const RELEASE_BASE_URL = "https://github.com/KGPSP/civcom-desktop/releases/latest/download";
export const LATEST_RELEASE_URL = "https://github.com/KGPSP/civcom-desktop/releases/latest";
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const ASSET_NAMES = Object.freeze({
  windowsInstaller: "CivCom-Windows-x64.exe",
  windowsBlockmap: "CivCom-Windows-x64.exe.blockmap",
  windowsMetadata: "latest.yml",
  macDmg: "CivCom-macOS-universal.dmg",
  macZip: "CivCom-macOS-universal.zip",
  macBlockmap: "CivCom-macOS-universal.zip.blockmap",
  macMetadata: "latest-mac.yml",
  linuxAppImage: "CivCom-Linux-x86_64.AppImage",
  linuxDeb: "CivCom-Linux-x86_64.deb",
  linuxMetadata: "latest-linux.yml",
  buildSbom: "CivCom-build.spdx.json",
  checksums: "SHA256SUMS",
  md5Checksums: "MD5SUMS"
});
const ASSET_KEYS = Object.freeze(Object.keys(ASSET_NAMES));
const PINNED_BUILD_PACKAGES = Object.freeze({
  electron: "43.4.1",
  "electron-updater": "6.8.9",
  "@electron/fuses": "2.1.3"
});
const PACKAGE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function plainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Expected a plain object");
  return value;
}

function safeFilename(value) {
  if (typeof value !== "string" || value === "" || value.length > 240 || value === "." || value === ".." || value.includes("/") || value.includes("\\") || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) throw new Error("Unsafe release filename");
  return value;
}

export function loadReleaseContract(value) {
  const record = plainRecord(value);
  if (record.schemaVersion !== 1 || record.releaseBaseUrl !== RELEASE_BASE_URL || record.latestReleaseUrl !== LATEST_RELEASE_URL) throw new Error("Unsupported release contract");
  const assets = plainRecord(record.assets);
  const keys = Object.keys(assets);
  if (keys.length !== ASSET_KEYS.length || ASSET_KEYS.some((key) => !Object.hasOwn(assets, key))) throw new Error("Missing or unexpected release asset key");
  const normalized = {};
  for (const key of ASSET_KEYS) {
    const filename = safeFilename(assets[key]);
    if (filename !== ASSET_NAMES[key]) throw new Error(`Unexpected canonical filename: ${key}`);
    normalized[key] = filename;
  }
  const orderedAssets = Object.freeze(ASSET_KEYS.map((key) => normalized[key]));
  if (new Set(orderedAssets).size !== orderedAssets.length) throw new Error("Duplicate release filename");
  return Object.freeze({ schemaVersion: 1, releaseBaseUrl: RELEASE_BASE_URL, latestReleaseUrl: LATEST_RELEASE_URL, assets: Object.freeze(normalized), orderedAssets });
}

function decodeSha512(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) throw new Error("Invalid SHA-512 encoding");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== value) throw new Error("Invalid SHA-512 digest");
  return value;
}

export function parseUpdateMetadata(text, expectedFilenames, expectedVersion) {
  const filenames = (typeof expectedFilenames === "string" ? [expectedFilenames] : Array.isArray(expectedFilenames) ? [...expectedFilenames] : []).map(safeFilename);
  if (filenames.length === 0 || filenames.length > 4 || new Set(filenames).size !== filenames.length) throw new Error("Invalid expected updater payload set");
  if (typeof text !== "string" || text.length === 0 || text.length > 64 * 1024 || text.includes("\r") || text.includes("\t") || [...text].some((character) => {
    const code = character.charCodeAt(0);
    return (code <= 31 && character !== "\n") || code === 127;
  })) throw new Error("Invalid updater metadata text");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const version = /^version: ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/.exec(lines[0] ?? "")?.[1];
  if (lines[1] !== "files:" || version !== expectedVersion) throw new Error("Updater metadata does not match the release contract");
  let index = 2;
  const files = [];
  while ((lines[index] ?? "").startsWith("  - url: ")) {
    const url = /^ {2}- url: ([A-Za-z0-9_.-]+)$/.exec(lines[index] ?? "")?.[1];
    const sha512 = /^ {4}sha512: ([A-Za-z0-9+/=]+)$/.exec(lines[index + 1] ?? "")?.[1];
    const sizeText = /^ {4}size: ([0-9]+)$/.exec(lines[index + 2] ?? "")?.[1];
    if (url === undefined || sha512 === undefined || sizeText === undefined) throw new Error("Invalid updater file entry");
    safeFilename(url);
    decodeSha512(sha512);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ARTIFACT_BYTES) throw new Error("Invalid updater artifact size");
    index += 3;
    let blockMapSize;
    const blockMapText = /^ {4}blockMapSize: ([0-9]+)$/.exec(lines[index] ?? "")?.[1];
    if (blockMapText !== undefined) {
      blockMapSize = Number(blockMapText);
      if (!Number.isSafeInteger(blockMapSize) || blockMapSize <= 0 || blockMapSize > size) throw new Error("Invalid updater block-map size");
      index += 1;
    }
    files.push(Object.freeze({ url, sha512, size, ...(blockMapSize === undefined ? {} : { blockMapSize }) }));
  }
  if (files.length !== filenames.length || files.some((file, position) => file.url !== filenames[position]) || new Set(files.map((file) => file.url)).size !== files.length) throw new Error("Updater payload set does not match the release contract");
  const path = /^path: ([A-Za-z0-9_.-]+)$/.exec(lines[index] ?? "")?.[1];
  const topSha = /^sha512: ([A-Za-z0-9+/=]+)$/.exec(lines[index + 1] ?? "")?.[1];
  const releaseDate = /^releaseDate: '?([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)'?$/.exec(lines[index + 2] ?? "")?.[1];
  if (lines.length !== index + 3 || path !== filenames[0] || topSha === undefined || files[0]?.sha512 !== topSha || releaseDate === undefined) throw new Error("Updater metadata does not match the release contract");
  decodeSha512(topSha);
  if (Number.isNaN(Date.parse(releaseDate))) throw new Error("Invalid updater release date");
  return Object.freeze({ version, files: Object.freeze(files), url: files[0]?.url, size: files[0]?.size, path, sha512: topSha, releaseDate });
}

export function resolveExpectedAppVersion(packageMetadataValue, packageLockValue) {
  const packageMetadata = plainRecord(packageMetadataValue);
  const packageLock = plainRecord(packageLockValue);
  const lockPackages = plainRecord(packageLock.packages);
  const lockRoot = plainRecord(lockPackages[""]);
  const version = packageMetadata.version;
  if (packageMetadata.name !== "civcom-desktop"
    || typeof version !== "string"
    || !PACKAGE_VERSION_PATTERN.test(version)
    || packageLock.lockfileVersion !== 3
    || packageLock.name !== "civcom-desktop"
    || packageLock.version !== version
    || lockRoot.name !== "civcom-desktop"
    || lockRoot.version !== version) throw new Error("Package metadata and lock version differ");
  return version;
}

export function validateBuildSbom(value, expectedAppVersion) {
  if (typeof expectedAppVersion !== "string" || !PACKAGE_VERSION_PATTERN.test(expectedAppVersion)) throw new Error("Invalid expected application version");
  const record = plainRecord(value);
  if (record.spdxVersion !== "SPDX-2.3" || record.dataLicense !== "CC0-1.0" || record.name !== "CivCom npm lockfile and build supply chain" || /full binary inventory/i.test(JSON.stringify(record))) throw new Error("Invalid build supply-chain SBOM identity");
  if (!Array.isArray(record.packages) || record.packages.length === 0 || record.packages.some((entry) => {
    try { const item = plainRecord(entry); return typeof item.name !== "string" || item.name === ""; } catch { return true; }
  })) throw new Error("Empty or invalid build supply-chain SBOM");
  const requiredPackages = { "civcom-desktop": expectedAppVersion, ...PINNED_BUILD_PACKAGES };
  for (const [required, version] of Object.entries(requiredPackages)) {
    if (!record.packages.some((entry) => entry.name === required && entry.versionInfo === version)) throw new Error(`Build supply-chain SBOM omits required package version: ${required}@${version}`);
  }
}

async function regularFile(directory, filename) {
  safeFilename(filename);
  const path = join(directory, filename);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_ARTIFACT_BYTES) throw new Error(`Invalid release asset: ${filename}`);
  return path;
}

export async function verifyUpdateMetadataFiles(directory, text, expectedFilenames, expectedVersion) {
  const metadata = parseUpdateMetadata(text, expectedFilenames, expectedVersion);
  for (const file of metadata.files) {
    const path = await regularFile(directory, file.url);
    const contents = await readFile(path);
    if (contents.length !== file.size || createHash("sha512").update(contents).digest("base64") !== file.sha512) throw new Error(`Updater metadata digest or size differs from the packaged payload: ${file.url}`);
  }
  return metadata;
}

async function createDigestManifest(directory, filenames, algorithm, label) {
  const names = [...filenames].map(safeFilename).sort();
  if (new Set(names).size !== names.length || names.includes(ASSET_NAMES.checksums) || names.includes(ASSET_NAMES.md5Checksums)) throw new Error(`Invalid ${label} checksum input set`);
  const lines = [];
  for (const filename of names) {
    const path = await regularFile(directory, filename);
    const hash = createHash(algorithm);
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const digest = hash.digest("hex");
    lines.push(`${digest}  ${filename}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function createSha256Manifest(directory, filenames) {
  return await createDigestManifest(directory, filenames, "sha256", "SHA-256");
}

export async function createMd5Manifest(directory, filenames) {
  return await createDigestManifest(directory, filenames, "md5", "MD5");
}

export async function verifyIdenticalReleaseDirectories(localDirectory, remoteDirectory, contractValue) {
  const contract = loadReleaseContract(contractValue);
  if (typeof localDirectory !== "string" || typeof remoteDirectory !== "string" || localDirectory === remoteDirectory) throw new Error("Release comparison requires distinct directories");
  for (const filename of contract.orderedAssets) {
    const localPath = await regularFile(localDirectory, filename);
    const remotePath = await regularFile(remoteDirectory, filename);
    const [localContents, remoteContents] = await Promise.all([readFile(localPath), readFile(remotePath)]);
    if (localContents.length !== remoteContents.length || createHash("sha256").update(localContents).digest("hex") !== createHash("sha256").update(remoteContents).digest("hex")) throw new Error(`Remote draft asset differs from the local verified release: ${filename}`);
  }
}

async function verifyChecksums(directory, contract) {
  const payloadNames = contract.orderedAssets.filter((filename) => filename !== contract.assets.checksums && filename !== contract.assets.md5Checksums);
  const checksumPath = await regularFile(directory, contract.assets.checksums);
  const actual = await readFile(checksumPath, "utf8");
  const expected = await createSha256Manifest(directory, payloadNames);
  if (actual !== expected) throw new Error("SHA256SUMS does not match the canonical release assets");
  const md5ChecksumPath = await regularFile(directory, contract.assets.md5Checksums);
  const actualMd5 = await readFile(md5ChecksumPath, "utf8");
  const expectedMd5 = await createMd5Manifest(directory, payloadNames);
  if (actualMd5 !== expectedMd5) throw new Error("MD5SUMS does not match the canonical release assets");
}

export async function verifyReleaseDirectory(directory, contractValue, options = {}) {
  const contract = loadReleaseContract(contractValue);
  if (typeof options.expectedVersion !== "string" || !PACKAGE_VERSION_PATTERN.test(options.expectedVersion)) throw new Error("Release verification requires an expected application version");
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const expectedNames = [...contract.orderedAssets].sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) throw new Error("Missing or unexpected release directory entry");
  for (const filename of contract.orderedAssets) await regularFile(directory, filename);
  for (const [metadataName, payloadNames] of [[contract.assets.windowsMetadata, [contract.assets.windowsInstaller]], [contract.assets.macMetadata, [contract.assets.macZip]], [contract.assets.linuxMetadata, [contract.assets.linuxAppImage, contract.assets.linuxDeb]]]) {
    await verifyUpdateMetadataFiles(directory, await readFile(join(directory, metadataName), "utf8"), payloadNames, options.expectedVersion);
  }
  validateBuildSbom(JSON.parse(await readFile(join(directory, contract.assets.buildSbom), "utf8")), options.expectedVersion);
  await verifyChecksums(directory, contract);
}
