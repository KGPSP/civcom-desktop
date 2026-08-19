import { classifyTrustedOrigin } from "./url-policy.js";

export type CredentialMetadata = Readonly<{
  scope: string;
  purpose: string;
  fileMode: number;
}>;

export function validateCredentialMetadata(metadata: unknown): metadata is CredentialMetadata {
  if (metadata === null || typeof metadata !== "object") {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(metadata);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    const scope = Object.getOwnPropertyDescriptor(metadata, "scope");
    const purpose = Object.getOwnPropertyDescriptor(metadata, "purpose");
    const fileMode = Object.getOwnPropertyDescriptor(metadata, "fileMode");
    return (
      scope !== undefined &&
      purpose !== undefined &&
      fileMode !== undefined &&
      "value" in scope &&
      "value" in purpose &&
      "value" in fileMode &&
      scope.value === "local" &&
      purpose.value === "interactive-manual-test" &&
      fileMode.value === 0o600
    );
  } catch {
    return false;
  }
}

const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

export type OpaqueSecret = Readonly<{
  toString(): "[REDACTED]";
  toJSON(): "[REDACTED]";
  [INSPECT_CUSTOM](): "[REDACTED]";
}>;

export type ValidatedRoute = Readonly<{
  toString(): "[CivCom route]";
  toJSON(): "[CivCom route]";
  [INSPECT_CUSTOM](): "[CivCom route]";
}>;

export type ManualCredentialResult =
  | Readonly<{
      kind: "accepted";
      credential: Readonly<{ adresTest: ValidatedRoute; login: OpaqueSecret; pass: OpaqueSecret }>;
    }>
  | Readonly<{
      kind: "rejected";
      code: "invalid-metadata" | "invalid-format" | "duplicate-key" | "unexpected-key" | "empty-secret" | "invalid-route";
    }>;

class Secret implements OpaqueSecret {
  readonly #value: string;

  public constructor(value: string) {
    this.#value = value;
  }

  public toString(): "[REDACTED]" {
    void this.#value;
    return "[REDACTED]";
  }

  public toJSON(): "[REDACTED]" {
    return "[REDACTED]";
  }

  public [INSPECT_CUSTOM](): "[REDACTED]" {
    return "[REDACTED]";
  }
}

const validatedRouteValues = new WeakMap<object, string>();

class Route implements ValidatedRoute {

  public toString(): "[CivCom route]" {
    return "[CivCom route]";
  }

  public toJSON(): "[CivCom route]" {
    return "[CivCom route]";
  }

  public [INSPECT_CUSTOM](): "[CivCom route]" {
    return "[CivCom route]";
  }

}

function rejected(code: Extract<ManualCredentialResult, { kind: "rejected" }>["code"]): ManualCredentialResult {
  return Object.freeze({ kind: "rejected", code });
}

function hasQuery(value: string): boolean {
  return value.includes("?");
}

function hasInvalidCredentialControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 9 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
    if (code === 13 && value.charCodeAt(index + 1) !== 10) {
      return true;
    }
  }
  return false;
}

function validateRoute(value: string): ValidatedRoute | undefined {
  if (hasQuery(value) || /\s/.test(value)) {
    return undefined;
  }
  const origin = classifyTrustedOrigin(value);
  if (origin.kind !== "trusted" || origin.service !== "civcom") {
    return undefined;
  }
  const route = Object.freeze(new Route());
  validatedRouteValues.set(route, value);
  return route;
}

export function parseManualCredentialText(text: string, metadata: unknown): ManualCredentialResult {
  if (!validateCredentialMetadata(metadata)) {
    return rejected("invalid-metadata");
  }
  if (typeof text !== "string" || hasInvalidCredentialControl(text)) {
    return rejected("invalid-format");
  }

  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const values = new Map<string, string>();
  const expectedKeys = new Set(["adres_test", "login", "pass"]);

  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return rejected("invalid-format");
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!expectedKeys.has(key)) {
      return rejected("unexpected-key");
    }
    if (values.has(key)) {
      return rejected("duplicate-key");
    }
    values.set(key, value);
  }

  const adresTest = values.get("adres_test");
  const login = values.get("login");
  const pass = values.get("pass");
  if (adresTest === undefined || login === undefined || pass === undefined) {
    return rejected("invalid-format");
  }
  if (login === "" || pass === "") {
    return rejected("empty-secret");
  }
  const route = validateRoute(adresTest);
  if (route === undefined) {
    return rejected("invalid-route");
  }

  return Object.freeze({
    kind: "accepted",
    credential: Object.freeze({
      adresTest: route,
      login: Object.freeze(new Secret(login)),
      pass: Object.freeze(new Secret(pass))
    })
  });
}

export type RouteResolution =
  | Readonly<{ kind: "resolved"; url: string }>
  | Readonly<{ kind: "rejected"; code: "invalid-route" }>;

export function resolveValidatedRoute(route: unknown): RouteResolution {
  if (route === null || (typeof route !== "object" && typeof route !== "function")) {
    return Object.freeze({ kind: "rejected", code: "invalid-route" });
  }
  const url = validatedRouteValues.get(route);
  return url === undefined
    ? Object.freeze({ kind: "rejected", code: "invalid-route" })
    : Object.freeze({ kind: "resolved", url });
}
