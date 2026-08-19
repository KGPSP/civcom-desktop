const SAFE_RESOURCE_TYPES = new Set([
  "mainFrame",
  "subFrame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xhr",
  "media",
  "other"
]);
const FORBIDDEN_RESOURCE_TYPES = new Set(["webSocket", "ping", "cspReport"]);
const EXPECTED_SEQUENCE = Object.freeze(["opt-in", "paths", "memory-session", "tls", "guard", "window", "listeners", "navigate"]);
const PRODUCTION_ORIGINS = Object.freeze(["https://civcom.soia.info", "https://matrix.soia.info", "https://auth.soia.info"]);

function ownData(input, required, optional = []) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const result = new Map();
    for (const key of required) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      result.set(key, descriptor.value);
    }
    for (const key of optional) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor)) return undefined;
      result.set(key, descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

function block(code) {
  return Object.freeze({ kind: "block", code });
}

function safeOriginSet(origins) {
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 4) throw new Error("INVALID_ORIGINS");
  const result = new Set();
  for (const value of origins) {
    if (typeof value !== "string" || value.length > 256 || /[\s\\]/.test(value)) throw new Error("INVALID_ORIGINS");
    let url;
    try { url = new URL(value); } catch { throw new Error("INVALID_ORIGINS"); }
    const productionOrigin = url.protocol === "https:" && url.port === "";
    const loopbackPort = Number(url.port);
    const localOrigin = (url.protocol === "http:" || url.protocol === "https:") && url.hostname === "127.0.0.1" && Number.isInteger(loopbackPort) && loopbackPort >= 1 && loopbackPort <= 65535;
    if ((!productionOrigin && !localOrigin) || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.origin !== value) throw new Error("INVALID_ORIGINS");
    result.add(value);
  }
  return result;
}

function hasCredentialQuery(url) {
  for (const [rawKey, rawValue] of url.searchParams) {
    const key = rawKey.toLowerCase().replaceAll(/[-_.]/g, "");
    const value = rawValue.toLowerCase();
    if (["accesstoken", "logintoken", "idtoken", "code", "authorization", "password", "passwd", "credential", "clientsecret"].includes(key)) return true;
    if (/\bbearer\s|access[_-]?token|login[_-]?token|id[_-]?token|client[_-]?secret/.test(value)) return true;
  }
  return false;
}

function hasUnsafeUrlCharacter(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\\" || /\s/u.test(character) || code <= 31 || code === 127) return true;
  }
  return false;
}

function parseSafeRequestUrl(value, allowedOrigins) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192 || hasUnsafeUrlCharacter(value)) return undefined;
  let url;
  try { url = new URL(value); } catch { return undefined; }
  if (!allowedOrigins.has(url.origin) || url.username !== "" || url.password !== "" || url.hash !== "" || hasCredentialQuery(url)) return undefined;
  return url;
}

function ownHeaderNames(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const names = [];
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      names.push(key.toLowerCase());
    }
    return names;
  } catch {
    return undefined;
  }
}

function createNetworkGuard(origins) {
  const allowedOrigins = safeOriginSet(origins);
  return Object.freeze({
    request(input) {
      const fields = ownData(input, ["method", "url", "resourceType"], ["uploadData", "redirected"]);
      if (fields === undefined) return block("INVALID_REQUEST");
      const method = fields.get("method");
      if (method !== "GET" && method !== "HEAD") return block("UNSAFE_METHOD");
      if (fields.has("uploadData")) return block("REQUEST_BODY");
      const resourceType = fields.get("resourceType");
      if (typeof resourceType !== "string" || FORBIDDEN_RESOURCE_TYPES.has(resourceType) || !SAFE_RESOURCE_TYPES.has(resourceType)) return block("UNSAFE_RESOURCE");
      if (fields.get("redirected") === true) return block("REDIRECT");
      if (fields.has("redirected") && fields.get("redirected") !== false) return block("INVALID_REQUEST");
      if (parseSafeRequestUrl(fields.get("url"), allowedOrigins) === undefined) return block("UNSAFE_URL");
      return Object.freeze({ kind: "allow", code: method === "GET" ? "SAFE_GET" : "SAFE_HEAD" });
    },
    headers(input) {
      const fields = ownData(input, ["requestHeaders"]);
      if (fields === undefined) return block("INVALID_HEADERS");
      const names = ownHeaderNames(fields.get("requestHeaders"));
      if (names === undefined) return block("INVALID_HEADERS");
      if (names.includes("authorization") || names.includes("cookie")) return block("CREDENTIAL_HEADER");
      return Object.freeze({ kind: "allow", code: "SAFE_HEADERS" });
    }
  });
}

export function createAnonymousProductionNetworkGuard() {
  return createNetworkGuard(PRODUCTION_ORIGINS);
}

export function createLoopbackNetworkGuard(origins) {
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 2) throw new Error("INVALID_ORIGINS");
  for (const value of origins) {
    let url;
    try { url = new URL(value); } catch { throw new Error("INVALID_ORIGINS"); }
    const port = Number(url.port);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_ORIGINS");
  }
  return createNetworkGuard(origins);
}

export function authorizeAnonymousBootstrapSequence(events) {
  if (!Array.isArray(events) || events.length !== EXPECTED_SEQUENCE.length) return block("UNSAFE_SEQUENCE");
  try {
    for (let index = 0; index < EXPECTED_SEQUENCE.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(events, String(index));
      if (descriptor === undefined || !("value" in descriptor) || descriptor.value !== EXPECTED_SEQUENCE[index]) return block("UNSAFE_SEQUENCE");
    }
  } catch {
    return block("UNSAFE_SEQUENCE");
  }
  return Object.freeze({ kind: "allow", code: "SAFE_SEQUENCE" });
}

export function createAnonymousMemoryPartition(entropy) {
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 16) throw new Error("INVALID_ENTROPY");
  let hexadecimal = "";
  for (const value of entropy) hexadecimal += value.toString(16).padStart(2, "0");
  return `civcom-anonymous-${hexadecimal}`;
}

export function decideElectronRequest(guard, details, redirected = false) {
  if (redirected !== true && redirected !== false) return block("INVALID_REQUEST");
  const fields = ownData(details, ["method", "url", "resourceType"], ["uploadData"]);
  if (fields === undefined) return block("INVALID_REQUEST");
  let request;
  try {
    const descriptor = guard !== null && typeof guard === "object" ? Object.getOwnPropertyDescriptor(guard, "request") : undefined;
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") return block("INVALID_REQUEST");
    request = {
      method: fields.get("method"),
      url: fields.get("url"),
      resourceType: fields.get("resourceType"),
      ...(fields.has("uploadData") ? { uploadData: fields.get("uploadData") } : {}),
      ...(redirected ? { redirected: true } : {})
    };
    return descriptor.value.call(guard, request);
  } catch {
    return block("INVALID_REQUEST");
  }
}
