import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleRelease } from "./release-automation.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedInput = join(projectRoot, "release", "incoming");
const expectedOutput = join(projectRoot, "release", "assembled");

if (process.argv.length !== 4) throw new Error("Expected isolated incoming and assembled release directories");
const input = resolve(projectRoot, process.argv[2]);
const output = resolve(projectRoot, process.argv[3]);
if (input !== expectedInput || output !== expectedOutput) throw new Error("Release assembly paths must be the fixed ignored directories");
const contract = JSON.parse(await readFile(join(projectRoot, "docs", "downloads.json"), "utf8"));
await assembleRelease(input, output, contract);
