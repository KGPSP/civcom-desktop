import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const binaryByPlatform = {
  darwin: ["Electron.app", "Contents", "MacOS", "Electron"],
  linux: ["electron"],
  win32: ["electron.exe"]
};

const binaryParts = binaryByPlatform[process.platform];

if (binaryParts === undefined) {
  throw new Error(`Unsupported platform for Electron binary verification: ${process.platform}`);
}

await access(join("node_modules", "electron", "dist", ...binaryParts), constants.X_OK);
