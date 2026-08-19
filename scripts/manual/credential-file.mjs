import * as nodeFileSystem from "node:fs";

const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");
const MAX_FILE_BYTES = 16 * 1024;
const routeValues = new WeakMap();

class RouteCapability {
  toString() { return "[CivCom route]"; }
  toJSON() { return "[CivCom route]"; }
  [INSPECT_CUSTOM]() { return "[CivCom route]"; }
}

function rejected(code) {
  return Object.freeze({ kind: "rejected", code });
}

function safeText(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10) continue;
    if (code === 13 && value.charCodeAt(index + 1) === 10) continue;
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

function hasUnsafeUrlCharacter(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\\" || /\s/u.test(character) || code <= 31 || code === 127) return true;
  }
  return false;
}

function validRoute(value) {
  if (typeof value !== "string" || value.length > 8192 || value !== value.trim() || hasUnsafeUrlCharacter(value) || value.includes("?")) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:"
    && url.origin === "https://civcom.soia.info"
    && url.username === ""
    && url.password === ""
    && url.port === ""
    && url.pathname === "/"
    && url.search === ""
    && url.hash.startsWith("#/room/")
    && url.hash.length > "#/room/".length;
}

export function parseManualCredentialText(text) {
  if (!safeText(text)) return rejected("INVALID_FORMAT");
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 3) return rejected("INVALID_FORMAT");
  const expected = new Set(["adres_test", "login", "pass"]);
  const values = new Map();
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) return rejected("INVALID_FORMAT");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!expected.has(key)) return rejected("UNEXPECTED_KEY");
    if (values.has(key)) return rejected("DUPLICATE_KEY");
    values.set(key, value);
  }
  const routeValue = values.get("adres_test");
  const login = values.get("login");
  const pass = values.get("pass");
  if (typeof login !== "string" || login.length === 0 || typeof pass !== "string" || pass.length === 0) return rejected("EMPTY_CREDENTIAL");
  if (!validRoute(routeValue)) return rejected("INVALID_ROUTE");
  const route = Object.freeze(new RouteCapability());
  routeValues.set(route, routeValue);
  return Object.freeze({ kind: "accepted", route });
}

function safeStat(stat, uid) {
  try {
    return stat !== null
      && typeof stat === "object"
      && stat.isFile() === true
      && stat.nlink === 1
      && stat.uid === uid
      && (stat.mode & 0o777) === 0o600
      && Number.isSafeInteger(stat.size)
      && stat.size >= 1
      && stat.size <= MAX_FILE_BYTES
      && Number.isSafeInteger(stat.dev)
      && Number.isSafeInteger(stat.ino)
      && typeof stat.mtimeMs === "number"
      && Number.isFinite(stat.mtimeMs)
      && typeof stat.ctimeMs === "number"
      && Number.isFinite(stat.ctimeMs);
  } catch {
    return false;
  }
}

function sameStat(left, right) {
  try {
    return left.dev === right.dev
      && left.ino === right.ino
      && left.uid === right.uid
      && left.mode === right.mode
      && left.nlink === right.nlink
      && left.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs
      && left.isFile() === true
      && right.isFile() === true;
  } catch {
    return false;
  }
}

export function readManualCredentialFile(input) {
  if (input?.platform === "win32") return rejected("WINDOWS_ACL_UNSUPPORTED");
  let descriptor;
  let buffer;
  try {
    if (input === null || typeof input !== "object" || typeof input.filePath !== "string" || !Number.isSafeInteger(input.uid) || input.uid < 0) return rejected("CREDENTIAL_FILE_REJECTED");
    const fileSystem = input.fileSystem;
    if (fileSystem === null || typeof fileSystem !== "object") return rejected("CREDENTIAL_FILE_REJECTED");
    const before = fileSystem.lstatSync(input.filePath);
    if (!safeStat(before, input.uid)) return rejected("CREDENTIAL_FILE_REJECTED");
    const noFollow = typeof fileSystem.constants?.O_NOFOLLOW === "number" ? fileSystem.constants.O_NOFOLLOW : 0;
    descriptor = fileSystem.openSync(input.filePath, fileSystem.constants.O_RDONLY | noFollow);
    const opened = fileSystem.fstatSync(descriptor);
    if (!safeStat(opened, input.uid) || !sameStat(before, opened)) return rejected("CREDENTIAL_FILE_REJECTED");
    buffer = Buffer.alloc(opened.size);
    const bytesRead = fileSystem.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) return rejected("CREDENTIAL_FILE_REJECTED");
    const after = fileSystem.fstatSync(descriptor);
    if (!safeStat(after, input.uid) || !sameStat(opened, after)) return rejected("CREDENTIAL_FILE_REJECTED");
    return parseManualCredentialText(buffer.toString("utf8"));
  } catch {
    return rejected("CREDENTIAL_FILE_REJECTED");
  } finally {
    if (buffer !== undefined) buffer.fill(0);
    if (descriptor !== undefined) {
      try { input.fileSystem.closeSync(descriptor); } catch { /* constant rejection above */ }
    }
  }
}

export function readFixedManualCredentialFile(filePath) {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  return readManualCredentialFile({ filePath, platform: process.platform, uid, fileSystem: nodeFileSystem });
}

export async function navigateCredentialRoute(route, browser) {
  if (route === null || (typeof route !== "object" && typeof route !== "function")) return rejected("ROUTE_REJECTED");
  const url = routeValues.get(route);
  if (url === undefined) return rejected("ROUTE_REJECTED");
  let navigate;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(browser, "navigate");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") return rejected("ROUTE_REJECTED");
    navigate = descriptor.value;
  } catch {
    return rejected("ROUTE_REJECTED");
  }
  routeValues.delete(route);
  try {
    await navigate(url);
    return Object.freeze({ kind: "accepted", code: "ROUTE_NAVIGATED" });
  } catch {
    return rejected("ROUTE_REJECTED");
  }
}
