import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPublicationPlan } from "./release-automation.mjs";
import { loadReleaseContract, verifyIdenticalReleaseDirectories, verifyReleaseDirectory } from "./release-contract.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixedReleaseDirectory = join(projectRoot, "release", "assembled");
const downloads = JSON.parse(await readFile(join(projectRoot, "docs", "downloads.json"), "utf8"));
const contract = loadReleaseContract(downloads);
const packageMetadata = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, shell: false });
  if (result.error !== undefined || result.status !== 0) throw new Error("Protected release command failed");
  return result.stdout;
}

function context() {
  if (typeof process.env.GH_TOKEN !== "string" || process.env.GH_TOKEN === "") throw new Error("GitHub workflow token is required for protected publication");
  return Object.freeze({
    githubActions: process.env.GITHUB_ACTIONS,
    allowPublication: process.env.CIVCOM_ALLOW_PUBLICATION,
    eventName: process.env.GITHUB_EVENT_NAME,
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    refProtected: process.env.GITHUB_REF_PROTECTED,
    repository: process.env.GITHUB_REPOSITORY,
    packageVersion: packageMetadata.version,
    releaseDirectory: fixedReleaseDirectory,
    assetNames: contract.orderedAssets
  });
}

async function verifyRemoteDraft(planContext) {
  const view = createPublicationPlan("verify-draft", planContext).commands[0];
  const remote = JSON.parse(run(view.command, view.args));
  if (remote.tagName !== planContext.refName || remote.isDraft !== true || remote.isPrerelease !== false || !Array.isArray(remote.assets) || remote.assets.length !== contract.orderedAssets.length) throw new Error("Remote release is not the expected draft");
  const localSizes = new Map();
  for (const name of contract.orderedAssets) localSizes.set(name, (await lstat(join(fixedReleaseDirectory, name))).size);
  const remoteNames = new Set();
  for (const asset of remote.assets) {
    if (asset === null || typeof asset !== "object" || typeof asset.name !== "string" || !localSizes.has(asset.name) || asset.size !== localSizes.get(asset.name) || remoteNames.has(asset.name)) throw new Error("Remote draft assets differ from the local verified release");
    remoteNames.add(asset.name);
  }
  const downloaded = await mkdtemp(join(tmpdir(), "civcom-release-verification-"));
  try {
    run("gh", ["release", "download", planContext.refName, "--repo", planContext.repository, "--dir", downloaded]);
    await verifyReleaseDirectory(downloaded, downloads, { expectedVersion: packageMetadata.version });
    await verifyIdenticalReleaseDirectories(fixedReleaseDirectory, downloaded, downloads);
  } finally {
    await rm(downloaded, { recursive: true, force: true });
  }
}

export async function runPublication(mode, requestedDirectory) {
  const releaseDirectory = resolve(projectRoot, requestedDirectory);
  if (releaseDirectory !== fixedReleaseDirectory) throw new Error("Publication accepts only the fixed assembled release directory");
  await verifyReleaseDirectory(releaseDirectory, downloads, { expectedVersion: packageMetadata.version });
  const planContext = context();
  const plan = createPublicationPlan(mode, planContext);
  if (mode === "draft") {
    const command = plan.commands[0];
    run(command.command, command.args);
    return;
  }
  await verifyRemoteDraft(planContext);
  if (mode === "publish") {
    const finalCommand = plan.commands.at(-1);
    run(finalCommand.command, finalCommand.args);
  }
}

if (process.argv.length !== 4) throw new Error("Expected publication mode and assembled directory");
await runPublication(process.argv[2], process.argv[3]);
