import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleasePreflight } from "./release-automation.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function git(args) {
  const result = spawnSync("git", args, { cwd: projectRoot, env: process.env, encoding: "utf8", maxBuffer: 1024 * 1024, shell: false });
  if (result.error !== undefined || result.status !== 0) throw new Error("Release preflight git inspection failed");
  return result.stdout.trim();
}

export function inspectMainAncestry(run = spawnSync) {
  const result = run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: projectRoot, env: process.env, encoding: "utf8", maxBuffer: 1024 * 1024, shell: false });
  if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) throw new Error("Release preflight git ancestry inspection failed");
  return result.status === 0;
}

export async function runReleasePreflight(environment = process.env) {
  const packageMetadata = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(projectRoot, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || lock.packages?.[""]?.version !== lock.version) throw new Error("Unsupported or inconsistent package lock");
  validateReleasePreflight({
    eventName: environment.GITHUB_EVENT_NAME,
    refType: environment.GITHUB_REF_TYPE,
    refName: environment.GITHUB_REF_NAME,
    refProtected: environment.GITHUB_REF_PROTECTED,
    githubSha: environment.GITHUB_SHA,
    headSha: git(["rev-parse", "HEAD"]),
    mainAncestor: inspectMainAncestry(),
    packageVersion: packageMetadata.version,
    lockVersion: lock.packages[""].version,
    worktreeClean: git(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
    buildMode: environment.CIVCOM_BUILD_MODE,
    repository: environment.GITHUB_REPOSITORY
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Release preflight accepts no arguments");
  await runReleasePreflight();
}
