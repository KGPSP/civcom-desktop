import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePlatformArtifacts } from "./release-automation.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

if (process.argv.length !== 3) throw new Error("Expected one native release platform");
const platform = process.argv[2];
if (platform !== "windows" && platform !== "macos" && platform !== "linux") throw new Error("Unsupported release platform");
const source = join(projectRoot, "release");
const output = join(projectRoot, "release", "staged", platform);
const contract = JSON.parse(await readFile(join(projectRoot, "docs", "downloads.json"), "utf8"));
await stagePlatformArtifacts(source, output, platform, contract);
