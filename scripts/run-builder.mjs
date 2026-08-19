import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const TARGET_ARGUMENTS = Object.freeze({
  windows: Object.freeze(["--config", "electron-builder.config.cjs", "--win", "nsis", "--x64", "--publish", "never"]),
  macos: Object.freeze(["--config", "electron-builder.config.cjs", "--mac", "dmg", "zip", "--universal", "--publish", "never"]),
  linux: Object.freeze(["--config", "electron-builder.config.cjs", "--linux", "AppImage", "deb", "--x64", "--publish", "never"])
});

export function createBuilderInvocation(target) {
  const args = TARGET_ARGUMENTS[target];
  if (args === undefined) throw new Error("Expected exactly one supported release target");
  return Object.freeze({ executable: process.execPath, args, environment: Object.freeze({ CIVCOM_RELEASE_TARGET: target }) });
}

function run(command, args, environment) {
  const result = spawnSync(command, args, { cwd: resolve(fileURLToPath(new URL("..", import.meta.url))), env: environment, stdio: "inherit", shell: false });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`Packaging command failed with status ${String(result.status)}`);
}

export function runBuilder(target, environment = process.env) {
  if (environment.CIVCOM_BUILD_MODE !== "pilot" && environment.CIVCOM_BUILD_MODE !== "production") throw new Error("CIVCOM_BUILD_MODE must be explicitly pilot or production");
  const npmCli = environment.npm_execpath;
  if (typeof npmCli !== "string" || !npmCli.endsWith(".js")) throw new Error("Run packaging through an npm package script");
  const invocation = createBuilderInvocation(target);
  const childEnvironment = { ...environment, ...invocation.environment };
  run(process.execPath, [npmCli, "run", "build"], childEnvironment);
  const builderCli = fileURLToPath(new URL("../node_modules/electron-builder/out/cli/cli.js", import.meta.url));
  run(invocation.executable, [builderCli, ...invocation.args], childEnvironment);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2);
  if (targets.length !== 1) throw new Error("Expected exactly one release target");
  runBuilder(targets[0]);
}
