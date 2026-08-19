import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { URL } from "node:url";

const assetDirectory = new URL("../assets/", import.meta.url);
const permittedExtensions = new Set([".icns", ".ico", ".png", ".svg"]);

async function verifyDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = join(directory, entry.name);
    const metadata = await lstat(location);

    if (metadata.isSymbolicLink()) {
      throw new Error(`Assets must not be symbolic links: ${relative(assetDirectory.pathname, location)}`);
    }

    if (metadata.isDirectory()) {
      await verifyDirectory(location);
      continue;
    }

    if (!metadata.isFile() || !permittedExtensions.has(extname(entry.name).toLowerCase())) {
      throw new Error(`Unsupported asset: ${relative(assetDirectory.pathname, location)}`);
    }

    if (extname(entry.name).toLowerCase() === ".svg") {
      const content = await readFile(location, "utf8");
      if (/<(?:script|foreignObject|image)\b|\b(?:href|src)\s*=\s*["'](?:https?:|data:|\/\/)/i.test(content)) {
        throw new Error(`SVG must be self-contained and non-executable: ${relative(assetDirectory.pathname, location)}`);
      }
    }
  }
}

await verifyDirectory(assetDirectory.pathname);
