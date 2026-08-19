import { request as httpsRequest } from "node:https";

const ORIGIN = "https://civcom.soia.info";
const PLAN = Object.freeze([
  Object.freeze({ method: "GET", origin: ORIGIN, path: "/", maxBytes: 256 * 1024 }),
  Object.freeze({ method: "GET", origin: ORIGIN, path: "/version", maxBytes: 256 * 1024 }),
  Object.freeze({ method: "GET", origin: ORIGIN, path: "/config.json", maxBytes: 256 * 1024 }),
  Object.freeze({ method: "GET", origin: ORIGIN, path: "/manifest.json", maxBytes: 256 * 1024 }),
  Object.freeze({ method: "GET", origin: ORIGIN, path: "/sw.js", maxBytes: 1024 * 1024 }),
  Object.freeze({ method: "HEAD", origin: ORIGIN, path: "/", maxBytes: 0 })
]);
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

function ownData(input, fields) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const result = new Map();
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      result.set(field, descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

function rejected(code) {
  return Object.freeze({ kind: "rejected", code });
}

function accepted(code, warning) {
  return warning === undefined
    ? Object.freeze({ kind: "accepted", code })
    : Object.freeze({ kind: "accepted", code, warning });
}

export function createAnonymousEndpointPlan(optIn) {
  if (optIn !== "confirmed") throw new Error("OPT_IN_REQUIRED");
  return PLAN;
}

export function validateAnonymousTls(input) {
  const fields = ownData(input, ["authorized", "authorizationError", "protocol", "validTo", "now"]);
  if (fields === undefined || fields.get("authorized") !== true || (fields.get("authorizationError") !== null && fields.get("authorizationError") !== undefined) || !["TLSv1.2", "TLSv1.3"].includes(fields.get("protocol"))) return rejected("TLS_REJECTED");
  const now = fields.get("now");
  const validTo = fields.get("validTo");
  const expiry = typeof validTo === "string" ? Date.parse(validTo) : Number.NaN;
  if (typeof now !== "number" || !Number.isFinite(now) || !Number.isFinite(expiry) || expiry - now < FOURTEEN_DAYS_MS) return rejected("TLS_REJECTED");
  return accepted("TLS_OK");
}

function parseJson(body) {
  try { return JSON.parse(body); } catch { return undefined; }
}

function hasSecretField(value, depth = 0) {
  if (depth > 32 || value === null || typeof value !== "object") return depth > 32;
  if (Array.isArray(value)) return value.some((entry) => hasSecretField(entry, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return true;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[-_.]/g, "");
    if (["accesstoken", "logintoken", "idtoken", "authorization", "password", "passwd", "clientsecret", "credential"].includes(normalized)) return true;
    if (hasSecretField(nested, depth + 1)) return true;
  }
  return false;
}

function exactString(object, path) {
  let value = object;
  for (const key of path) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = value[key];
  }
  return typeof value === "string" ? value : undefined;
}

function safeManifestResource(value) {
  if (typeof value !== "string" || value === "" || hasUnsafeUrlCharacter(value) || value.startsWith("//")) return false;
  try {
    const url = new URL(value, `${ORIGIN}/`);
    return url.origin === ORIGIN && url.username === "" && url.password === "" && url.protocol === "https:";
  } catch {
    return false;
  }
}

function hasUnsafeUrlCharacter(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\\" || /\s/u.test(character) || code <= 31 || code === 127) return true;
  }
  return false;
}

function validateRoot(body, contentType) {
  const lower = body.toLowerCase();
  return contentType.toLowerCase().includes("text/html") && lower.includes("matrix") && lower.includes("content-security-policy") && lower.includes("referrer")
    ? accepted("ROOT_OK")
    : rejected("ROOT_REJECTED");
}

function validateVersion(body) {
  return body.trim() === "1.12.25" && /^\d+\.\d+\.\d+$/.test(body.trim()) ? accepted("VERSION_OK") : rejected("VERSION_REJECTED");
}

function validateConfig(body) {
  const config = parseJson(body);
  if (config === undefined || hasSecretField(config)) return rejected("CONFIG_REJECTED");
  const brand = exactString(config, ["brand"]);
  const homeserver = exactString(config, ["default_server_config", "m.homeserver", "base_url"]);
  const serverName = exactString(config, ["default_server_config", "m.homeserver", "server_name"]);
  const call = exactString(config, ["element_call", "url"]);
  const permalink = exactString(config, ["permalink_prefix"]);
  return brand === "CivCom" && homeserver === "https://matrix.soia.info" && serverName === "soia.info" && call === "https://call.soia.info" && permalink === ORIGIN
    ? accepted("CONFIG_OK")
    : rejected("CONFIG_REJECTED");
}

function validateManifest(body) {
  const manifest = parseJson(body);
  if (manifest === undefined || manifest === null || typeof manifest !== "object" || Array.isArray(manifest) || hasSecretField(manifest)) return rejected("MANIFEST_REJECTED");
  const resources = [];
  if (Object.hasOwn(manifest, "start_url")) resources.push(manifest.start_url);
  if (Object.hasOwn(manifest, "scope")) resources.push(manifest.scope);
  if (Array.isArray(manifest.icons)) for (const icon of manifest.icons) resources.push(icon?.src);
  if (resources.length === 0 || !resources.every(safeManifestResource)) return rejected("MANIFEST_REJECTED");
  return accepted("MANIFEST_OK", manifest.name === "Element" ? "MANIFEST_BRAND_PENDING" : undefined);
}

function validateServiceWorker(body, contentType) {
  const lower = body.toLowerCase();
  return (contentType.toLowerCase().includes("javascript") || contentType.toLowerCase().includes("text/plain")) && ["install", "activate", "fetch"].every((event) => lower.includes(event))
    ? accepted("SERVICE_WORKER_OK")
    : rejected("SERVICE_WORKER_REJECTED");
}

export function validateAnonymousEndpointResponse(input) {
  const fields = ownData(input, ["path", "method", "statusCode", "contentType", "body"]);
  if (fields === undefined || fields.get("statusCode") !== 200 || typeof fields.get("body") !== "string" || typeof fields.get("contentType") !== "string") return rejected("RESPONSE_REJECTED");
  const path = fields.get("path");
  const method = fields.get("method");
  const body = fields.get("body");
  if (method === "HEAD" && path === "/") return body === "" ? accepted("HEAD_OK") : rejected("RESPONSE_REJECTED");
  if (method !== "GET") return rejected("RESPONSE_REJECTED");
  const max = path === "/sw.js" ? 1024 * 1024 : 256 * 1024;
  if (Buffer.byteLength(body, "utf8") > max) return rejected("BODY_LIMIT");
  if (path === "/") return validateRoot(body, fields.get("contentType"));
  if (path === "/version") return validateVersion(body);
  if (path === "/config.json") return validateConfig(body);
  if (path === "/manifest.json") return validateManifest(body);
  if (path === "/sw.js") return validateServiceWorker(body, fields.get("contentType"));
  return rejected("RESPONSE_REJECTED");
}

function contentType(response) {
  try {
    const headers = response.headers;
    if (headers === null || typeof headers !== "object") return undefined;
    const type = headers["content-type"];
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}

function tlsSnapshot(socket, now) {
  try {
    const certificate = socket.getPeerCertificate();
    return Object.freeze({
      authorized: socket.authorized,
      authorizationError: socket.authorizationError,
      protocol: socket.getProtocol(),
      validTo: certificate?.valid_to,
      now
    });
  } catch {
    return undefined;
  }
}

function performRequest(entry, request, now) {
  return new Promise((resolvePromise) => {
    let outgoing;
    let settled = false;
    let tlsAccepted = false;
    let wallClockTimer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (wallClockTimer !== undefined) clearTimeout(wallClockTimer);
      resolvePromise(result);
    };
    const fail = (code) => {
      if (settled) return;
      try { outgoing?.destroy(); } catch { /* transport error is mapped to a constant */ }
      settle(rejected(code));
    };
    try {
      wallClockTimer = setTimeout(() => fail("REQUEST_TIMEOUT"), REQUEST_TIMEOUT_MS);
      outgoing = request(Object.freeze({
        protocol: "https:",
        hostname: "civcom.soia.info",
        port: 443,
        method: entry.method,
        path: entry.path,
        agent: false,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.3",
        timeout: REQUEST_TIMEOUT_MS
      }), (response) => {
        if (settled) { try { response.resume(); } catch { /* already closed */ } return; }
        const statusCode = response.statusCode;
        if (typeof statusCode === "number" && statusCode >= 300 && statusCode <= 399) {
          try { response.resume(); } catch { /* request will be destroyed */ }
          fail("REDIRECT_REJECTED");
          return;
        }
        const type = contentType(response);
        if (type === undefined) { fail("RESPONSE_REJECTED"); return; }
        let bytes = 0;
        const chunks = [];
        try { response.setTimeout(REQUEST_TIMEOUT_MS, () => fail("REQUEST_TIMEOUT")); } catch { fail("REQUEST_FAILED"); return; }
        response.on("data", (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk) : undefined;
          if (buffer === undefined) { fail("RESPONSE_REJECTED"); return; }
          bytes += buffer.byteLength;
          if (bytes > entry.maxBytes) { fail("BODY_LIMIT"); return; }
          chunks.push(buffer);
        });
        response.once("aborted", () => fail("REQUEST_FAILED"));
        response.once("error", () => fail("REQUEST_FAILED"));
        response.once("end", () => {
          if (settled) return;
          if (!tlsAccepted) { fail("TLS_REJECTED"); return; }
          const body = Buffer.concat(chunks).toString("utf8");
          settle(validateAnonymousEndpointResponse({ path: entry.path, method: entry.method, statusCode, contentType: type, body }));
        });
      });
      outgoing.once("socket", (socket) => {
        socket.once("secureConnect", () => {
          const snapshot = tlsSnapshot(socket, now());
          const decision = snapshot === undefined ? rejected("TLS_REJECTED") : validateAnonymousTls(snapshot);
          if (decision.kind === "accepted") tlsAccepted = true;
          else fail("TLS_REJECTED");
        });
      });
      outgoing.once("timeout", () => fail("REQUEST_TIMEOUT"));
      outgoing.once("error", () => fail("REQUEST_FAILED"));
      outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => fail("REQUEST_TIMEOUT"));
      outgoing.end();
    } catch {
      fail("REQUEST_FAILED");
    }
  });
}

export async function executeAnonymousEndpointProbe(dependencies) {
  const fields = ownData(dependencies, ["optIn", "request", "now"]);
  if (fields === undefined || typeof fields.get("request") !== "function" || typeof fields.get("now") !== "function") return rejected("INVALID_PROBE_DEPENDENCIES");
  let plan;
  try { plan = createAnonymousEndpointPlan(fields.get("optIn")); } catch { return rejected("OPT_IN_REQUIRED"); }
  const checks = [];
  const warnings = [];
  for (const entry of plan) {
    const result = await performRequest(entry, fields.get("request"), fields.get("now"));
    if (result.kind !== "accepted") return result;
    checks.push(result.code);
    if (result.warning !== undefined) warnings.push(result.warning);
  }
  return Object.freeze({ kind: "accepted", code: "ANONYMOUS_ENDPOINTS_OK", checks: Object.freeze(checks), warnings: Object.freeze(warnings) });
}

export async function runAnonymousEndpointProbe() {
  return await executeAnonymousEndpointProbe({
    optIn: process.env.CIVCOM_ALLOW_ANONYMOUS_PRODUCTION_SMOKE,
    request: httpsRequest,
    now: Date.now
  });
}
