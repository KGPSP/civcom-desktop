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
  const candidate = metadata as Partial<CredentialMetadata>;
  return (
    candidate.scope === "local" &&
    candidate.purpose === "interactive-manual-test" &&
    candidate.fileMode === 0o600
  );
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

class Route implements ValidatedRoute {
  readonly #url: string;

  public constructor(url: string) {
    this.#url = url;
  }

  public toString(): "[CivCom route]" {
    return "[CivCom route]";
  }

  public toJSON(): "[CivCom route]" {
    return "[CivCom route]";
  }

  public [INSPECT_CUSTOM](): "[CivCom route]" {
    return "[CivCom route]";
  }

  public resolve(): string {
    return this.#url;
  }
}

function rejected(code: Extract<ManualCredentialResult, { kind: "rejected" }>["code"]): ManualCredentialResult {
  return Object.freeze({ kind: "rejected", code });
}

function hasQuery(value: string): boolean {
  return value.slice(0, value.indexOf("#") === -1 ? value.length : value.indexOf("#")).includes("?");
}

function validateRoute(value: string): ValidatedRoute | undefined {
  if (hasQuery(value)) {
    return undefined;
  }
  const origin = classifyTrustedOrigin(value);
  if (origin.kind !== "trusted" || origin.service !== "civcom") {
    return undefined;
  }
  return Object.freeze(new Route(value));
}

export function parseManualCredentialText(text: string, metadata: unknown): ManualCredentialResult {
  if (!validateCredentialMetadata(metadata)) {
    return rejected("invalid-metadata");
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

export function resolveValidatedRoute(route: ValidatedRoute): string {
  return (route as Route).resolve();
}
