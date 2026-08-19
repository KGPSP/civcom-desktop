import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSha256Manifest, loadReleaseContract, resolveExpectedAppVersion, validateBuildSbom, verifyReleaseDirectory } from "./release-contract.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const downloads = JSON.parse(await readFile(join(projectRoot, "docs", "downloads.json"), "utf8"));
const contract = loadReleaseContract(downloads);
const packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
const expectedAppVersion = resolveExpectedAppVersion(packageMetadata, packageLock);

async function writeNewFile(path, contents) {
  try { await lstat(path); throw new Error(`Refusing to replace an existing release output: ${path}`); } catch (error) {
    if (error && typeof error === "object" && error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

export async function generateChecksums(directory) {
  const filenames = contract.orderedAssets.filter((filename) => filename !== contract.assets.checksums);
  const contents = await createSha256Manifest(directory, filenames);
  await writeNewFile(join(directory, contract.assets.checksums), contents);
}

export function createSbomInvocation(environment) {
  let npmCli;
  try {
    const descriptor = environment !== null && typeof environment === "object" ? Object.getOwnPropertyDescriptor(environment, "npm_execpath") : undefined;
    npmCli = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    npmCli = undefined;
  }
  if (typeof npmCli !== "string" || !npmCli.endsWith(".js")) throw new Error("Run SBOM generation through an npm package script");
  return Object.freeze({ command: process.execPath, args: Object.freeze([npmCli, "sbom", "--sbom-format=spdx"]) });
}

export async function generateBuildSbom(directory, environment = process.env) {
  const invocation = createSbomInvocation(environment);
  const result = spawnSync(invocation.command, invocation.args, { cwd: projectRoot, env: { ...environment, NO_COLOR: "1" }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, shell: false });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") throw new Error("npm SPDX generation failed");
  const sbom = JSON.parse(result.stdout);
  sbom.name = "CivCom npm lockfile and build supply chain";
  validateBuildSbom(sbom, expectedAppVersion);
  await writeNewFile(join(directory, contract.assets.buildSbom), `${JSON.stringify(sbom, null, 2)}\n`);
}

export async function verifyRelease(directory) {
  await verifyReleaseDirectory(directory, downloads, { expectedVersion: expectedAppVersion });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, requestedDirectory = "release/assembled", ...extra] = process.argv.slice(2);
  if (extra.length !== 0) throw new Error("Unexpected release artifact arguments");
  const directory = resolve(projectRoot, requestedDirectory);
  if (command === "sha256") await generateChecksums(directory);
  else if (command === "sbom") await generateBuildSbom(directory);
  else if (command === "verify") await verifyRelease(directory);
  else throw new Error("Expected release command: sha256, sbom, or verify");
}
