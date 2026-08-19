import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { loadReleaseContract } from "./release-contract.mjs";

const PLATFORM_KEYS = Object.freeze({
  windows: Object.freeze(["windowsInstaller", "windowsBlockmap", "windowsMetadata"]),
  macos: Object.freeze(["macDmg", "macZip", "macBlockmap", "macMetadata"]),
  linux: Object.freeze(["linuxAppImage", "linuxDeb", "linuxMetadata"])
});
const PUBLIC_ASSET_NAMES = Object.freeze([
  "CivCom-Windows-x64.exe", "CivCom-Windows-x64.exe.blockmap", "latest.yml",
  "CivCom-macOS-universal.dmg", "CivCom-macOS-universal.zip", "CivCom-macOS-universal.zip.blockmap", "latest-mac.yml",
  "CivCom-Linux-x86_64.AppImage", "CivCom-Linux-x86_64.deb", "latest-linux.yml",
  "CivCom-build.spdx.json", "SHA256SUMS", "MD5SUMS"
]);

function plainRecord(value, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
  return value;
}

function exactString(value, expected, message) {
  if (value !== expected) throw new Error(message);
}

export function validateReleasePreflight(inputValue) {
  const input = plainRecord(inputValue, "Invalid release preflight context");
  exactString(input.eventName, "push", "Production release must originate from a push");
  exactString(input.refType, "tag", "Production release must originate from a tag");
  exactString(input.refProtected, "true", "Production release tag must be protected");
  exactString(input.repository, "KGPSP/civcom-desktop", "Unexpected production repository");
  exactString(input.buildMode, "production", "Production build mode is required");
  if (input.worktreeClean !== true) throw new Error("Production release worktree is not clean");
  if (typeof input.packageVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(input.packageVersion)) throw new Error("Invalid package version");
  if (input.lockVersion !== input.packageVersion || input.releaseNotesVersion !== input.packageVersion || input.refName !== `v${input.packageVersion}`) throw new Error("Tag, package, lock, and release notes versions differ");
  if (typeof input.githubSha !== "string" || !/^[0-9a-f]{40}$/.test(input.githubSha) || input.headSha !== input.githubSha) throw new Error("Tagged workflow SHA differs from checkout HEAD");
  if (input.mainAncestor !== true) throw new Error("Tagged workflow SHA is not reachable from origin/main");
}

async function regularNonemptyFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) throw new Error(`Invalid ${label}`);
}

function expectedPlatformNames(platform, contract) {
  const keys = PLATFORM_KEYS[platform];
  if (keys === undefined) throw new Error("Unsupported release platform");
  return keys.map((key) => contract.assets[key]);
}

export async function stagePlatformArtifacts(sourceDirectory, outputDirectory, platform, contractValue) {
  if (typeof sourceDirectory !== "string" || typeof outputDirectory !== "string" || !isAbsolute(sourceDirectory) || !isAbsolute(outputDirectory) || sourceDirectory === outputDirectory) throw new Error("Staging directories must be distinct absolute paths");
  const contract = loadReleaseContract(contractValue);
  const expected = expectedPlatformNames(platform, contract);
  const sourceMetadata = await lstat(sourceDirectory);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) throw new Error("Invalid package output directory");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const outputMetadata = await lstat(outputDirectory);
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) throw new Error("Invalid staging output directory");
  for (const name of expected) {
    const source = join(sourceDirectory, name);
    await regularNonemptyFile(source, `package artifact: ${name}`);
    await copyFile(source, join(outputDirectory, name), constants.COPYFILE_EXCL);
  }
}

export async function assembleRelease(inputDirectory, outputDirectory, contractValue) {
  if (typeof inputDirectory !== "string" || typeof outputDirectory !== "string" || !isAbsolute(inputDirectory) || !isAbsolute(outputDirectory) || inputDirectory === outputDirectory) throw new Error("Assembly directories must be distinct absolute paths");
  const contract = loadReleaseContract(contractValue);
  const platformNames = new Set(Object.entries(contract.assets).filter(([key]) => key !== "buildSbom" && key !== "checksums" && key !== "md5Checksums").map(([, name]) => name));
  const found = new Map();
  const incomingMetadata = await lstat(inputDirectory);
  if (!incomingMetadata.isDirectory() || incomingMetadata.isSymbolicLink()) throw new Error("Invalid incoming release directory");
  const expectedRoots = Object.keys(PLATFORM_KEYS).map((platform) => `PRODUCTION-${platform}`).sort();
  const incomingEntries = await readdir(inputDirectory, { withFileTypes: true });
  const incomingNames = incomingEntries.map((entry) => entry.name).sort();
  if (incomingNames.length !== expectedRoots.length || incomingNames.some((name, index) => name !== expectedRoots[index]) || incomingEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) throw new Error("Unexpected incoming platform artifact set");
  for (const [platform, keys] of Object.entries(PLATFORM_KEYS)) {
    const root = join(inputDirectory, `PRODUCTION-${platform}`);
    const expected = keys.map((key) => contract.assets[key]);
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error(`Invalid ${platform} artifact directory`);
    const entries = await readdir(root, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    const sortedExpected = [...expected].sort();
    if (names.length !== sortedExpected.length || names.some((name, index) => name !== sortedExpected[index]) || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) throw new Error(`Missing, nested, symlinked, or unexpected ${platform} artifact`);
    for (const name of expected) {
      const path = join(root, name);
      await regularNonemptyFile(path, `incoming release artifact: ${name}`);
      if (found.has(name)) throw new Error(`Duplicate release artifact across platforms: ${name}`);
      found.set(name, path);
    }
  }
  if (found.size !== platformNames.size) throw new Error("Incomplete assembled release");
  await mkdir(outputDirectory, { mode: 0o700 });
  for (const name of [...platformNames].sort()) await copyFile(found.get(name), join(outputDirectory, name), constants.COPYFILE_EXCL);
}

export function createPublicationPlan(mode, inputValue) {
  if (mode !== "draft" && mode !== "verify-draft" && mode !== "publish") throw new Error("Invalid publication mode");
  const input = plainRecord(inputValue, "Invalid publication context");
  for (const [key, expected] of [["githubActions", "true"], ["allowPublication", "confirmed"], ["eventName", "push"], ["refType", "tag"], ["refProtected", "true"], ["repository", "KGPSP/civcom-desktop"]]) exactString(input[key], expected, `Invalid publication gate: ${key}`);
  if (typeof input.packageVersion !== "string" || input.refName !== `v${input.packageVersion}` || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(input.packageVersion)) throw new Error("Publication tag/version mismatch");
  if (typeof input.releaseDirectory !== "string" || !isAbsolute(input.releaseDirectory)) throw new Error("Publication directory must be absolute");
  if (typeof input.releaseNotesPath !== "string" || !isAbsolute(input.releaseNotesPath) || basename(input.releaseNotesPath) !== "RELEASE_NOTES.md") throw new Error("Publication notes path must be the fixed release notes file");
  if (!Array.isArray(input.assetNames) || input.assetNames.length !== PUBLIC_ASSET_NAMES.length || input.assetNames.some((name, index) => name !== PUBLIC_ASSET_NAMES[index])) throw new Error("Publication assets do not match the canonical contract");
  const common = [input.refName, "--repo", input.repository];
  let commands;
  if (mode === "draft") {
    commands = [{ command: "gh", args: ["release", "create", ...common, "--verify-tag", "--draft", "--latest=false", "--title", `CivCom ${input.refName}`, "--notes-file", input.releaseNotesPath, ...input.assetNames.map((name) => join(input.releaseDirectory, name))] }];
  } else if (mode === "verify-draft") {
    commands = [{ command: "gh", args: ["release", "view", ...common, "--json", "tagName,isDraft,isPrerelease,assets"] }];
  } else {
    commands = [
      { command: "gh", args: ["release", "view", ...common, "--json", "tagName,isDraft,isPrerelease,assets"] },
      { command: "gh", args: ["release", "edit", ...common, "--draft=false", "--latest"] }
    ];
  }
  return Object.freeze({ commands: Object.freeze(commands.map(({ command, args }) => Object.freeze({ command, args: Object.freeze(args) }))) });
}
