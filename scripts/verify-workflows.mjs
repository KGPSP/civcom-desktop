import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictYaml } from "./strict-yaml.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PINNED_ACTIONS = Object.freeze({
  "actions/checkout": "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  "actions/setup-node": "249970729cb0ef3589644e2896645e5dc5ba9c38",
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact": "37930b1c2abaa49bbe596cd826c3c89aef350131",
  "actions/attest-build-provenance": "977bb373ede98d70efdf65b84cb5f73e068dcc2a",
  "actions/attest-sbom": "4651f806c01d8637787e274ac3bdf724ef169f34"
});

function record(value, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value;
}

function steps(workflow) {
  const result = [];
  for (const job of Object.values(record(workflow.jobs, "Workflow jobs must be an object"))) {
    const jobRecord = record(job, "Workflow job must be an object");
    if (!Array.isArray(jobRecord.steps)) throw new Error("Every workflow job must define steps");
    result.push(...jobRecord.steps.map((step) => record(step, "Workflow step must be an object")));
  }
  return result;
}

function validatePinnedActions(workflow) {
  for (const step of steps(workflow)) {
    if (typeof step.uses !== "string") continue;
    const match = /^([^@]+)@([0-9a-f]{40})$/.exec(step.uses);
    if (match === null || PINNED_ACTIONS[match[1]] !== match[2]) throw new Error(`Unpinned or unapproved action: ${String(step.uses)}`);
    if (match[1] === "actions/checkout") {
      const withOptions = record(step.with, "Checkout must disable credential persistence");
      if (withOptions["persist-credentials"] !== false) throw new Error("Checkout credentials must not persist");
    }
  }
}

function commandText(workflow) {
  return steps(workflow).map((step) => typeof step.run === "string" ? step.run : "").join("\n");
}

function validateTopLevel(workflow, source) {
  if (!Object.hasOwn(workflow, "on") || source.includes("pull_request_target") || /uses:\s*[^\s]+@(?![0-9a-f]{40}(?:\s|$))/.test(source)) throw new Error("Unsafe workflow trigger or action reference");
  const permissions = record(workflow.permissions, "Top-level permissions must be explicit");
  if (Object.keys(permissions).length !== 0) throw new Error("Top-level workflow permissions must be empty");
  validatePinnedActions(workflow);
  for (const [name, jobValue] of Object.entries(record(workflow.jobs, "Workflow jobs must be an object"))) {
    const job = record(jobValue, "Workflow job must be an object");
    const hasCheckout = Array.isArray(job.steps) && job.steps.some((step) => step?.uses?.startsWith("actions/checkout@"));
    if (!hasCheckout) continue;
    const permissions = record(job.permissions, "Checkout jobs need explicit contents permission");
    const expected = name === "publish" ? "write" : "read";
    if (Object.keys(permissions).length !== 1 || permissions.contents !== expected) throw new Error(`Unexpected checkout permissions for job: ${name}`);
  }
}

function validateCi(workflow, source) {
  validateTopLevel(workflow, source);
  const triggers = record(workflow.on, "CI triggers missing");
  if (!Object.hasOwn(triggers, "push") || !Object.hasOwn(triggers, "pull_request") || /\$\{\{\s*secrets\./.test(source)) throw new Error("CI must be secret-free push and pull-request verification");
  const commands = commandText(workflow);
  if (!commands.includes("npm ci") || !commands.includes("npm run verify") || !commands.includes("xvfb-run -a npm run test:electron:local") || !source.includes("node-version: 24")) throw new Error("CI verification contract missing");
  if (/test:live:anonymous|test:manual:production/.test(source)) throw new Error("CI must remain local-only");
}

function validateAnonymousLiveSmoke(workflow, source) {
  validateTopLevel(workflow, source);
  const triggers = record(workflow.on, "Anonymous live triggers missing");
  if (Object.keys(triggers).sort().join(",") !== "push,workflow_dispatch") throw new Error("Anonymous live triggers are not exact");
  const push = record(triggers.push, "Anonymous live push trigger missing");
  if (!Array.isArray(push.branches) || push.branches.length !== 1 || push.branches[0] !== "main") throw new Error("Anonymous live push must target main only");
  if (triggers.workflow_dispatch !== null) throw new Error("Anonymous live dispatch must not accept inputs");
  const concurrency = record(workflow.concurrency, "Anonymous live concurrency missing");
  if (concurrency.group !== "anonymous-production-smoke" || concurrency["cancel-in-progress"] !== false) throw new Error("Anonymous live concurrency is not fixed and non-cancelling");
  const jobs = record(workflow.jobs, "Anonymous live job missing");
  if (Object.keys(jobs).join(",") !== "smoke") throw new Error("Anonymous live must be one serial job");
  const smoke = record(jobs.smoke, "Anonymous live smoke job missing");
  if (smoke.if !== "github.event_name != 'workflow_dispatch' || github.ref_name == github.event.repository.default_branch") throw new Error("Manual live dispatch must stay on the default branch");
  if (smoke["runs-on"] !== "ubuntu-24.04" || !Number.isInteger(smoke["timeout-minutes"]) || smoke["timeout-minutes"] < 1 || smoke["timeout-minutes"] > 20) throw new Error("Anonymous live runner or timeout invalid");
  if (smoke.environment !== undefined || smoke.strategy !== undefined || smoke["continue-on-error"] !== undefined) throw new Error("Anonymous live job may not use a release environment, matrix, or soft failure");
  const environment = record(smoke.env, "Anonymous live opt-in missing");
  if (Object.keys(environment).join(",") !== "CIVCOM_ALLOW_ANONYMOUS_PRODUCTION_SMOKE" || environment.CIVCOM_ALLOW_ANONYMOUS_PRODUCTION_SMOKE !== "confirmed") throw new Error("Anonymous live opt-in must be constant");
  const commands = steps({ jobs: { smoke } }).map((step) => step.run).filter((command) => typeof command === "string");
  if (commands.length !== 2 || commands[0] !== "npm ci" || commands[1] !== "xvfb-run -a npm run test:live:anonymous" || !source.includes("node-version: 24")) throw new Error("Anonymous live command contract missing");
  if (/pull_request|workflow_run|schedule|secrets\s*:|\$\{\{\s*secrets\.|secrets:\s*inherit|environment\s*:|upload-artifact|download-artifact|GITHUB_STEP_SUMMARY|\btrace\b|\bhar\b|\bretr(?:y|ies)\b|https?:\/\//i.test(source)) throw new Error("Anonymous live trust boundary widened");
}

function validatePilot(workflow, source) {
  validateTopLevel(workflow, source);
  const triggers = record(workflow.on, "Pilot trigger missing");
  if (!Object.hasOwn(triggers, "workflow_dispatch") || /\$\{\{\s*secrets\.|\bgh\s+release\b|attest-|pages:|contents:\s*write/i.test(source)) throw new Error("Pilot must be manual, unsigned, and non-publishing");
  if (!source.includes("CIVCOM_BUILD_MODE: pilot") || !source.includes("UNSIGNED-PILOT-") || !source.includes("retention-days: 14")) throw new Error("Pilot artifact policy missing");
  if (!source.includes("node scripts/stage-platform-artifacts.mjs ${{ matrix.target }}") || !source.includes("path: release/staged/${{ matrix.target }}/") || /^\s+path:\s+release\/\s*$/m.test(source)) throw new Error("Pilot artifact staging policy missing");
  if (source.includes("windows-latest") || source.includes("ubuntu-latest") || !source.includes("windows-2025") || !source.includes("ubuntu-24.04")) throw new Error("Pilot runner images are not pinned");
  const jobs = record(workflow.jobs, "Pilot jobs missing");
  const packageJob = record(jobs.package, "Pilot package matrix missing");
  const matrix = record(record(record(packageJob.strategy, "Pilot strategy missing").matrix, "Pilot matrix missing"), "Pilot matrix invalid");
  if (!Array.isArray(matrix.include) || matrix.include.length !== 3 || new Set(matrix.include.map((entry) => entry.target)).size !== 3) throw new Error("Pilot must cover three native targets");
}

function permissionKeys(value) {
  return Object.keys(record(value, "Job permissions must be explicit")).sort();
}

function validateRelease(workflow, source) {
  validateTopLevel(workflow, source);
  const triggers = record(workflow.on, "Release trigger missing");
  const tags = record(triggers.push, "Release push trigger missing").tags;
  if (!Array.isArray(tags) || tags.length !== 1 || tags[0] !== "v*") throw new Error("Release must trigger only on v tags");
  const concurrency = record(workflow.concurrency, "Release concurrency missing");
  if (concurrency["cancel-in-progress"] !== false) throw new Error("Production release must not be cancelled in progress");
  const jobs = record(workflow.jobs, "Release jobs missing");
  for (const [name, jobValue] of Object.entries(jobs)) {
    const job = record(jobValue, "Invalid release job");
    if (job.environment !== "production-release") throw new Error(`Release job lacks protected environment: ${name}`);
    if (job.permissions !== undefined && name !== "attest" && name !== "publish" && permissionKeys(job.permissions).join(",") !== "contents") throw new Error("Release job permissions exceed contents read");
  }
  if (permissionKeys(record(jobs.attest, "Attestation job missing").permissions).join(",") !== "artifact-metadata,attestations,contents,id-token") throw new Error("Attestation permissions are not exact");
  if (permissionKeys(record(jobs.publish, "Publication job missing").permissions).join(",") !== "contents") throw new Error("Publication permissions are not exact");
  const preflight = record(jobs.preflight, "Release preflight missing");
  const preflightCommands = steps({ jobs: { preflight } }).map((step) => step.run).filter((command) => typeof command === "string");
  if (preflightCommands.join("\n") !== ["npm ci", "npm run verify", "xvfb-run -a npm run test:live:anonymous", "node scripts/release-preflight.mjs"].join("\n")) throw new Error("Release live preflight sequence missing");
  const preflightEnvironment = record(preflight.env, "Release preflight environment missing");
  if (preflightEnvironment.CIVCOM_ALLOW_ANONYMOUS_PRODUCTION_SMOKE !== "confirmed" || /\$\{\{\s*secrets\./.test(JSON.stringify(preflight))) throw new Error("Release preflight live smoke must be constant and secret-free");
  for (const name of ["build-windows", "build-macos", "build-linux"]) if (record(jobs[name], `Release build missing: ${name}`).needs !== "preflight") throw new Error(`Release build does not depend on live preflight: ${name}`);
  const publishPermissions = record(record(jobs.publish, "Publication job missing").permissions, "Publication permissions missing");
  if (publishPermissions.contents !== "write") throw new Error("Final publication job requires contents write");
  const publication = commandText({ jobs: { publish: jobs.publish } });
  const draft = publication.indexOf("publish-release.mjs draft");
  const verify = publication.indexOf("publish-release.mjs verify-draft");
  const publish = publication.indexOf("publish-release.mjs publish");
  if (draft < 0 || verify <= draft || publish <= verify || !source.includes("name: Create and upload draft") || !source.includes("name: Verify remote draft assets") || !source.includes("name: Publish only after draft verification") || !source.includes("CIVCOM_BUILD_MODE: production") || !source.includes("node scripts/release-preflight.mjs")) throw new Error("Draft-first release sequence or production preflight missing");
  if (source.includes("windows-latest") || source.includes("ubuntu-latest") || !source.includes("windows-2025") || !source.includes("ubuntu-24.04")) throw new Error("Production runner images are not pinned");
  for (const platform of ["windows", "macos", "linux"]) {
    if (!source.includes(`node scripts/stage-platform-artifacts.mjs ${platform}`) || !source.includes(`path: release/staged/${platform}/`)) throw new Error(`Production artifact staging policy missing: ${platform}`);
  }
  if (/^\s+path:\s+release\/\s*$/m.test(source)) throw new Error("Production workflow may not upload the entire package output");
  if (/^\s+APPLE_API_KEY:\s*\$\{\{\s*secrets\./m.test(source) || !source.includes("CIVCOM_APPLE_API_KEY_CONTENT: ${{ secrets.CIVCOM_APPLE_API_KEY }}") || !source.includes("$RUNNER_TEMP/civcom-notarization-key.p8") || !source.includes("chmod 0600") || !source.includes('test -s "$key_path"') || !source.includes("if: always()")) throw new Error("macOS notarization key is not handled as a temporary nonempty 0600 file");
  if (!source.includes("gh attestation verify") || !String(record(jobs.publish, "Publication job missing").needs).includes("attest")) throw new Error("Attestations are not verified before publication");
}

export function validateWorkflowSource(name, source) {
  if (typeof source !== "string" || source.length === 0 || source.length > 256 * 1024) throw new Error("Invalid workflow source");
  let workflow;
  try { workflow = record(parseStrictYaml(source), "Workflow YAML root must be an object"); } catch { throw new Error("Invalid workflow YAML"); }
  if (name === "ci.yml") validateCi(workflow, source);
  else if (name === "anonymous-live-smoke.yml") validateAnonymousLiveSmoke(workflow, source);
  else if (name === "pilot.yml") validatePilot(workflow, source);
  else if (name === "release.yml") validateRelease(workflow, source);
  else throw new Error("Unexpected workflow filename");
}

function validateDependabot(source) {
  const config = record(parseStrictYaml(source), "Dependabot YAML root must be an object");
  if (config.version !== 2 || !Array.isArray(config.updates) || config.updates.length !== 2) throw new Error("Dependabot policy missing");
  const ecosystems = new Set(config.updates.map((entry) => {
    const update = record(entry, "Invalid Dependabot entry");
    if (update.directory !== "/" || record(update.schedule, "Dependabot schedule missing").interval !== "weekly" || update["open-pull-requests-limit"] !== 5) throw new Error("Invalid Dependabot scope");
    return update["package-ecosystem"];
  }));
  if (!ecosystems.has("npm") || !ecosystems.has("github-actions")) throw new Error("Dependabot ecosystems missing");
}

export async function validateRepositoryAutomation(rootDirectory) {
  const expectedWorkflows = ["anonymous-live-smoke.yml", "ci.yml", "pilot.yml", "release.yml"];
  const actualWorkflows = (await readdir(join(rootDirectory, ".github", "workflows"), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (actualWorkflows.join("\n") !== expectedWorkflows.join("\n")) throw new Error("Unexpected workflow file set");
  for (const name of expectedWorkflows) {
    validateWorkflowSource(name, await readFile(join(rootDirectory, ".github", "workflows", name), "utf8"));
  }
  validateDependabot(await readFile(join(rootDirectory, ".github", "dependabot.yml"), "utf8"));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Workflow verifier accepts no arguments");
  await validateRepositoryAutomation(projectRoot);
}
