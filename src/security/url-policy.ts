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

const ALLOWED_PERMISSIONS: ReadonlySet<AllowedPermission> = new Set([
  "media",
  "notifications",
  "fullscreen",
  "clipboard-sanitized-write"
]);

function hasUnsafeRawUrlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127 || value[index] === "\\") {
      return true;
    }
  }
  return false;
}

function parseDirectHttpsUrl(value: string): URL | undefined {
  if (hasUnsafeRawUrlCharacters(value) || !/^https:\/\//i.test(value)) {
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

function isLoopbackDevelopmentUrl(value: string): URL | undefined {
  if (hasUnsafeRawUrlCharacters(value)) {
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

export function resolveStartUrl(input: Readonly<{ isPackaged: boolean; developmentUrl?: string }>): StartUrlResult {
  if (input.isPackaged) {
    return Object.freeze({ kind: "allow", source: "production", url: PRODUCTION_CIVCOM_URL });
  }

  if (input.developmentUrl === undefined) {
    return Object.freeze({ kind: "allow", source: "production", url: PRODUCTION_CIVCOM_URL });
  }

  const developmentUrl = isLoopbackDevelopmentUrl(input.developmentUrl);
  if (developmentUrl === undefined) {
    return Object.freeze({ kind: "deny", code: "invalid-development-url" });
  }
  return Object.freeze({ kind: "allow", source: "development", url: developmentUrl.href });
}

export function classifyTrustedOrigin(value: string): OriginResult {
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

export function authorizeTopLevelNavigation(value: string): NavigationResult {
  const origin = classifyTrustedOrigin(value);
  if (origin.kind === "untrusted") {
    return Object.freeze({ kind: "deny", code: origin.code });
  }
  if (origin.service === "civcom" || origin.service === "auth") {
    return Object.freeze({ kind: "allow", service: origin.service });
  }
  return Object.freeze({ kind: "deny", code: "untrusted-origin" });
}

export function authorizeExternalProtocol(value: string): ExternalProtocolResult {
  if (hasUnsafeRawUrlCharacters(value)) {
    return Object.freeze({ kind: "deny", code: "unsafe-protocol" });
  }
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.username === "" && url.password === "") {
      return Object.freeze({ kind: "allow", protocol: "https:" });
    }
    if (url.protocol === "mailto:" && !/%(?:0d|0a|00)/i.test(value)) {
      return Object.freeze({ kind: "allow", protocol: "mailto:" });
    }
    return Object.freeze({ kind: "deny", code: "unsafe-protocol" });
  } catch {
    return Object.freeze({ kind: "deny", code: "invalid-url" });
  }
}

export function authorizePermissionRequest(input: Readonly<{ origin: string; permission: string }>): PermissionDecision {
  const origin = classifyTrustedOrigin(input.origin);
  if (origin.kind !== "trusted" || (origin.service !== "civcom" && origin.service !== "call")) {
    return Object.freeze({ kind: "deny", code: "untrusted-origin" });
  }
  if (!ALLOWED_PERMISSIONS.has(input.permission as AllowedPermission)) {
    return Object.freeze({ kind: "deny", code: "unknown-permission" });
  }
  return Object.freeze({ kind: "allow", permission: input.permission as AllowedPermission });
}

export function authorizeDisplayMediaRequest(
  input: Readonly<{ origin: string; userGesture: unknown }>
): DisplayMediaDecision {
  const origin = classifyTrustedOrigin(input.origin);
  if (origin.kind !== "trusted" || (origin.service !== "civcom" && origin.service !== "call")) {
    return Object.freeze({ kind: "deny", code: "untrusted-origin" });
  }
  if (input.userGesture !== true) {
    return Object.freeze({ kind: "deny", code: "missing-user-gesture" });
  }
  return Object.freeze({ kind: "allow" });
}
