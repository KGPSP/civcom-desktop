import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
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
  "rect"
]);
const safePaint = /^(?:none|currentColor|transparent|#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8}))$/i;
const numberPattern = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const pathDataPattern = /^[MmZzLlHhVvCcSsQqTtAa0-9,.\s+-]+$/;
const pathCommand = /[MmZzLlHhVvCcSsQqTtAa]/;
const plainLabel = /^[\p{L}\p{N}\p{Zs}.,:;!?'()-]{1,120}$/u;
const xmlEntityReference = /&(?:#\d+|#x[\da-f]+|[a-z][\w.-]*);/i;
const xmlDtd = /<!DOCTYPE\b|<!ENTITY\b/i;
const requiredRasterSizes = new Map([["civcom-tray.png", 44], ["civcom-tray@2x.png", 88]]);

function pngSize(contents) {
  return contents.length >= 24 && contents.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? { width: contents.readUInt32BE(16), height: contents.readUInt32BE(20) }
    : undefined;
}

function parseNumber(value) {
  if (!numberPattern.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumberList(value) {
  const normalized = value.trim();
  if (normalized === "") {
    return undefined;
  }

  const values = normalized.split(/[\s,]+/);
  const parsed = values.map(parseNumber);
  return parsed.every((number) => number !== undefined) ? parsed : undefined;
}

function isFiniteNumber(value) {
  return parseNumber(value) !== undefined;
}

function isNonNegativeNumber(value) {
  const number = parseNumber(value);
  return number !== undefined && number >= 0;
}

function isPositiveNumber(value) {
  const number = parseNumber(value);
  return number !== undefined && number > 0;
}

function isOpacity(value) {
  const number = parseNumber(value);
  return number !== undefined && number >= 0 && number <= 1;
}

function isViewBox(value) {
  const values = parseNumberList(value);
  return values !== undefined && values.length === 4 && values[2] > 0 && values[3] > 0;
}

function isPoints(value) {
  const values = parseNumberList(value);
  return values !== undefined && values.length >= 4 && values.length % 2 === 0;
}

function isPathData(value) {
  return pathDataPattern.test(value) && pathCommand.test(value);
}

function isTransform(value) {
  const allowedArity = {
    translate: new Set([1, 2]),
    scale: new Set([1, 2]),
    rotate: new Set([1, 3]),
    skewX: new Set([1]),
    skewY: new Set([1]),
    matrix: new Set([6])
  };
  let remaining = value.trim();
  let foundTransform = false;

  while (remaining !== "") {
    const match = /^(translate|scale|rotate|skewX|skewY|matrix)\(([^()]*)\)/.exec(remaining);
    if (match === null) {
      return false;
    }

    const values = parseNumberList(match[2]);
    if (values === undefined || !allowedArity[match[1]].has(values.length)) {
      return false;
    }

    foundTransform = true;
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return foundTransform;
}

const attributeValidators = new Map([
  ["viewBox", isViewBox],
  ["width", isPositiveNumber],
  ["height", isPositiveNumber],
  ["role", (value) => value === "img"],
  ["aria-label", (value) => plainLabel.test(value)],
  ["x", isFiniteNumber],
  ["y", isFiniteNumber],
  ["x1", isFiniteNumber],
  ["x2", isFiniteNumber],
  ["y1", isFiniteNumber],
  ["y2", isFiniteNumber],
  ["cx", isFiniteNumber],
  ["cy", isFiniteNumber],
  ["r", isNonNegativeNumber],
  ["rx", isNonNegativeNumber],
  ["ry", isNonNegativeNumber],
  ["d", isPathData],
  ["points", isPoints],
  ["fill", (value) => safePaint.test(value)],
  ["fill-opacity", isOpacity],
  ["fill-rule", (value) => value === "nonzero" || value === "evenodd"],
  ["stroke", (value) => safePaint.test(value)],
  ["stroke-opacity", isOpacity],
  ["stroke-width", isNonNegativeNumber],
  ["stroke-linecap", (value) => value === "butt" || value === "round" || value === "square"],
  ["stroke-linejoin", (value) => value === "miter" || value === "round" || value === "bevel"],
  ["stroke-miterlimit", isNonNegativeNumber],
  ["opacity", isOpacity],
  ["transform", isTransform]
]);

function isSafeAttributeValue(name, value) {
  if (value.includes("\\") || value.includes("/*") || value.includes("*/") || /url\s*\(/i.test(value)) {
    return false;
  }

  return attributeValidators.get(name)?.(value) ?? false;
}

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
  parser.on("xmldecl", () => {
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
    if (text.trim() !== "") {
      isSafe = false;
    }
  });
  parser.on("opentag", (tag) => {
    if (elementDepth === 0) {
      if (rootSeen || tag.name !== "svg") {
        isSafe = false;
      }
      rootSeen = true;
    }

    elementDepth += 1;

    if (!permittedElements.has(tag.name) || tag.uri !== svgNamespace) {
      isSafe = false;
    }

    for (const attribute of Object.values(tag.attributes)) {
      const isRootNamespace =
        elementDepth === 1 && attribute.name === "xmlns" && attribute.value === svgNamespace;

      if (
        attribute.prefix !== "" ||
        (!isRootNamespace && !isSafeAttributeValue(attribute.name, attribute.value))
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
  const seen = new Set();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    seen.add(entry.name);
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
    const expectedSize = requiredRasterSizes.get(entry.name);
    if (expectedSize !== undefined) {
      const dimensions = pngSize(await readFile(location));
      if (dimensions === undefined || dimensions.width !== expectedSize || dimensions.height !== expectedSize) throw new Error(`Invalid tray raster derivative: ${entry.name}`);
    }
  }
  if (resolve(directory) === resolve(assetDirectory)) for (const name of requiredRasterSizes.keys()) if (!seen.has(name)) throw new Error(`Missing required tray raster derivative: ${name}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === thisFile) {
  await verifyAssetDirectory();
}
