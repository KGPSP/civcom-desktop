export const PRODUCTION_CIVCOM_URL = "https://civcom.soia.info/";

type TrustedService = "civcom" | "auth" | "matrix" | "call";

type StartUrlResult =
  | Readonly<{ kind: "allow"; url: string; source: "production" | "development" }>
  | Readonly<{ kind: "deny"; code: "invalid-development-url" }>;

type OriginResult =
  | Readonly<{ kind: "trusted"; service: TrustedService }>
  | Readonly<{ kind: "untrusted"; code: "invalid-url" | "untrusted-origin" }>;

type NavigationResult =
  | Readonly<{ kind: "allow"; service: "civcom" | "auth" }>
  | Readonly<{ kind: "deny"; code: "invalid-url" | "untrusted-origin" }>;

type ExternalProtocolResult =
  | Readonly<{ kind: "allow"; protocol: "https:" | "mailto:" }>
  | Readonly<{ kind: "deny"; code: "invalid-url" | "unsafe-protocol" }>;

type AllowedPermission = "media" | "notifications" | "fullscreen" | "clipboard-sanitized-write";

type PermissionDecision =
  | Readonly<{ kind: "allow"; permission: AllowedPermission }>
  | Readonly<{ kind: "deny"; code: "untrusted-origin" | "unknown-permission" }>;

type DisplayMediaDecision =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "deny"; code: "untrusted-origin" | "missing-user-gesture" }>;

const TRUSTED_ORIGINS: Readonly<Record<string, TrustedService>> = Object.freeze({
  "https://civcom.soia.info": "civcom",
  "https://auth.soia.info": "auth",
  "https://matrix.soia.info": "matrix",
  "https://call.soia.info": "call"
});

function hasUnsafeRawUrlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127 || value[index] === "\\") {
      return true;
    }
  }
  return false;
}

function readOwnDataRecord(
  input: unknown,
  requiredFields: readonly string[],
  optionalFields: readonly string[] = []
): ReadonlyMap<string, unknown> | undefined {
  if (input === null || typeof input !== "object") {
    return undefined;
  }
  try {
    const prototype = Object.getPrototypeOf(input);
    if ((prototype !== Object.prototype && prototype !== null) || Array.isArray(input)) {
      return undefined;
    }
    const values = new Map<string, unknown>();
    for (const field of requiredFields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (descriptor === undefined || !("value" in descriptor)) {
        return undefined;
      }
      values.set(field, descriptor.value);
    }
    for (const field of optionalFields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (descriptor === undefined) {
        continue;
      }
      if (!("value" in descriptor)) {
        return undefined;
      }
      values.set(field, descriptor.value);
    }
    return values;
  } catch {
    return undefined;
  }
}

function parseDirectHttpsUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || hasUnsafeRawUrlCharacters(value) || !/^https:\/\//i.test(value)) {
    return undefined;
  }

  const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/, 1)[0];
  if (authority === undefined || authority.includes("%") || authority.includes("\\")) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function isLoopbackDevelopmentUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || hasUnsafeRawUrlCharacters(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function isAllowedPermission(value: unknown): value is AllowedPermission {
  return value === "media" || value === "notifications" || value === "fullscreen" || value === "clipboard-sanitized-write";
}

function hasMalformedPercentEncoding(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") {
      continue;
    }
    const first = value[index + 1];
    const second = value[index + 2];
    if (first === undefined || second === undefined || !/^[0-9a-f]$/i.test(first) || !/^[0-9a-f]$/i.test(second)) {
      return true;
    }
  }
  return false;
}

function hasUnsafeMailtoEncoding(value: string): boolean {
  let candidate = value;
  for (let layer = 0; layer < 8; layer += 1) {
    if (hasUnsafeRawUrlCharacters(candidate) || hasMalformedPercentEncoding(candidate)) {
      return true;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return true;
    }
    if (hasUnsafeRawUrlCharacters(decoded) || hasMalformedPercentEncoding(decoded)) {
      return true;
    }
    if (decoded === candidate || !/%[0-9a-f]{2}/i.test(decoded)) {
      return false;
    }
    candidate = decoded;
  }
  return true;
}

export function resolveStartUrl(input: unknown): StartUrlResult {
  const fields = readOwnDataRecord(input, ["isPackaged"], ["developmentUrl"]);
  if (fields === undefined) {
    return Object.freeze({ kind: "deny", code: "invalid-development-url" });
  }
  const isPackaged = fields.get("isPackaged");
  if (isPackaged === true) {
    return Object.freeze({ kind: "allow", source: "production", url: PRODUCTION_CIVCOM_URL });
  }
  if (isPackaged !== false) {
    return Object.freeze({ kind: "deny", code: "invalid-development-url" });
  }
  const developmentUrlValue = fields.get("developmentUrl");
  if (developmentUrlValue === undefined) {
    return Object.freeze({ kind: "allow", source: "production", url: PRODUCTION_CIVCOM_URL });
  }
  const developmentUrl = isLoopbackDevelopmentUrl(developmentUrlValue);
  if (developmentUrl === undefined) {
    return Object.freeze({ kind: "deny", code: "invalid-development-url" });
  }
  return Object.freeze({ kind: "allow", source: "development", url: developmentUrl.href });
}

export function classifyTrustedOrigin(value: unknown): OriginResult {
  const url = parseDirectHttpsUrl(value);
  if (url === undefined) {
    return Object.freeze({ kind: "untrusted", code: "invalid-url" });
  }

  const service = TRUSTED_ORIGINS[url.origin];
  if (service === undefined) {
    return Object.freeze({ kind: "untrusted", code: "untrusted-origin" });
  }
  return Object.freeze({ kind: "trusted", service });
}

export function authorizeTopLevelNavigation(value: unknown): NavigationResult {
  const origin = classifyTrustedOrigin(value);
  if (origin.kind === "untrusted") {
    return Object.freeze({ kind: "deny", code: origin.code });
  }
  if (origin.service === "civcom" || origin.service === "auth") {
    return Object.freeze({ kind: "allow", service: origin.service });
  }
  return Object.freeze({ kind: "deny", code: "untrusted-origin" });
}

export function authorizeExternalProtocol(value: unknown): ExternalProtocolResult {
  if (typeof value !== "string") {
    return Object.freeze({ kind: "deny", code: "invalid-url" });
  }
  if (hasUnsafeRawUrlCharacters(value)) {
    return Object.freeze({ kind: "deny", code: "unsafe-protocol" });
  }
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.username === "" && url.password === "") {
      return Object.freeze({ kind: "allow", protocol: "https:" });
    }
    if (url.protocol === "mailto:" && !hasUnsafeMailtoEncoding(value)) {
      return Object.freeze({ kind: "allow", protocol: "mailto:" });
    }
    return Object.freeze({ kind: "deny", code: "unsafe-protocol" });
  } catch {
    return Object.freeze({ kind: "deny", code: "invalid-url" });
  }
}

export function authorizePermissionRequest(input: unknown): PermissionDecision {
  const fields = readOwnDataRecord(input, ["origin", "permission"]);
  if (fields === undefined) {
    return Object.freeze({ kind: "deny", code: "untrusted-origin" });
  }
  const origin = classifyTrustedOrigin(fields.get("origin"));
  if (origin.kind !== "trusted" || (origin.service !== "civcom" && origin.service !== "call")) {
    return Object.freeze({ kind: "deny", code: "untrusted-origin" });
  }
  const permission = fields.get("permission");
  if (!isAllowedPermission(permission)) {
    return Object.freeze({ kind: "deny", code: "unknown-permission" });
  }
  return Object.freeze({ kind: "allow", permission });
}

export function authorizeDisplayMediaRequest(input: unknown): DisplayMediaDecision {
  const fields = readOwnDataRecord(input, ["origin", "userGesture"]);
  if (fields === undefined) {
    return Object.freeze({ kind: "deny", code: "untrusted-origin" });
  }
  const origin = classifyTrustedOrigin(fields.get("origin"));
  if (origin.kind !== "trusted" || (origin.service !== "civcom" && origin.service !== "call")) {
    return Object.freeze({ kind: "deny", code: "untrusted-origin" });
  }
  if (fields.get("userGesture") !== true) {
    return Object.freeze({ kind: "deny", code: "missing-user-gesture" });
  }
  return Object.freeze({ kind: "allow" });
}
