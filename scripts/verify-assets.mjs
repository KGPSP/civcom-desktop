import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { SaxesParser } from "saxes";

const assetDirectory = fileURLToPath(new URL("../assets/", import.meta.url));
const thisFile = fileURLToPath(import.meta.url);
const svgNamespace = "http://www.w3.org/2000/svg";
const permittedExtensions = new Set([".icns", ".ico", ".png", ".svg"]);
const permittedElements = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "rect",
  "title",
  "desc"
]);
const permittedAttributes = new Set([
  "viewBox",
  "width",
  "height",
  "role",
  "aria-label",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "transform"
]);
const xmlEntityReference = /&(?:#\d+|#x[\da-f]+|[a-z][\w.-]*);/i;
const xmlDtd = /<!DOCTYPE\b|<!ENTITY\b/i;
const paintServerReference = /url\s*\(/i;

export function isSafeSvgContent(content) {
  if (xmlDtd.test(content) || xmlEntityReference.test(content)) {
    return false;
  }

  let isSafe = true;
  let elementDepth = 0;
  let rootSeen = false;
  const parser = new SaxesParser({ xmlns: true });

  parser.on("error", () => {
    isSafe = false;
  });
  parser.on("doctype", () => {
    isSafe = false;
  });
  parser.on("processinginstruction", () => {
    isSafe = false;
  });
  parser.on("cdata", () => {
    isSafe = false;
  });
  parser.on("text", (text) => {
    if (elementDepth === 0 && text.trim() !== "") {
      isSafe = false;
    }
  });
  parser.on("opentag", (tag) => {
    if (!rootSeen) {
      rootSeen = true;
      if (tag.name !== "svg") {
        isSafe = false;
      }
    }

    elementDepth += 1;

    if (!permittedElements.has(tag.name) || tag.uri !== svgNamespace) {
      isSafe = false;
    }

    for (const attribute of Object.values(tag.attributes)) {
      const isRootNamespace =
        elementDepth === 1 && attribute.name === "xmlns" && attribute.value === svgNamespace;
      const isPermittedAttribute =
        attribute.name !== "xmlns" && permittedAttributes.has(attribute.name);

      if (
        attribute.prefix !== "" ||
        (!isRootNamespace && !isPermittedAttribute) ||
        paintServerReference.test(attribute.value)
      ) {
        isSafe = false;
      }
    }
  });
  parser.on("closetag", () => {
    elementDepth -= 1;
  });

  try {
    parser.write(content).close();
  } catch {
    return false;
  }

  return isSafe && rootSeen && elementDepth === 0;
}

export async function verifyAssetDirectory(directory = assetDirectory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = join(directory, entry.name);
    const metadata = await lstat(location);

    if (metadata.isSymbolicLink()) {
      throw new Error(`Assets must not be symbolic links: ${relative(assetDirectory, location)}`);
    }

    if (metadata.isDirectory()) {
      await verifyAssetDirectory(location);
      continue;
    }

    if (!metadata.isFile() || !permittedExtensions.has(extname(entry.name).toLowerCase())) {
      throw new Error(`Unsupported asset: ${relative(assetDirectory, location)}`);
    }

    if (extname(entry.name).toLowerCase() === ".svg") {
      const content = await readFile(location, "utf8");
      if (!isSafeSvgContent(content)) {
        throw new Error(`SVG must be static, self-contained, and non-executable: ${relative(assetDirectory, location)}`);
      }
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === thisFile) {
  await verifyAssetDirectory();
}
