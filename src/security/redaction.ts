type SafeEventName =
  | "navigation-denied"
  | "permission-denied"
  | "load-failed"
  | "download-denied"
  | "security-event";

type SafeErrorCode =
  | "ERR_FAILED"
  | "ERR_CONNECTION_REFUSED"
  | "ERR_INTERNET_DISCONNECTED"
  | "ERR_ABORTED"
  | "UNCLASSIFIED";

export type RedactedValue = Readonly<{ kind: "redacted"; value: string }>;

export type SafeLogEvent = Readonly<{
  event: SafeEventName;
  code: SafeErrorCode;
  url?: string;
}>;

const SAFE_EVENT_NAMES: ReadonlySet<SafeEventName> = new Set([
  "navigation-denied",
  "permission-denied",
  "load-failed",
  "download-denied",
  "security-event"
]);

const SAFE_ERROR_CODES: ReadonlySet<SafeErrorCode> = new Set([
  "ERR_FAILED",
  "ERR_CONNECTION_REFUSED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_ABORTED",
  "UNCLASSIFIED"
]);

function safeStringProperty(value: unknown, property: string): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    return `${url.origin}/`;
  } catch {
    return undefined;
  }
}

function redacted(value: string): RedactedValue {
  return Object.freeze({ kind: "redacted", value });
}

export function redactForLog(input: unknown): RedactedValue {
  if (typeof input !== "string") {
    return redacted("[redacted]");
  }
  return redacted(safeOrigin(input) ?? "[redacted-text]");
}

export function createSafeLogEvent(input: unknown): SafeLogEvent {
  const suppliedEvent = safeStringProperty(input, "event");
  const suppliedCode = safeStringProperty(input, "code");
  const suppliedUrl = safeStringProperty(input, "url");
  const event = SAFE_EVENT_NAMES.has(suppliedEvent as SafeEventName)
    ? (suppliedEvent as SafeEventName)
    : "security-event";
  const code = SAFE_ERROR_CODES.has(suppliedCode as SafeErrorCode)
    ? (suppliedCode as SafeErrorCode)
    : "UNCLASSIFIED";
  const url = suppliedUrl === undefined ? undefined : safeOrigin(suppliedUrl);

  return url === undefined
    ? Object.freeze({ event, code })
    : Object.freeze({ event, code, url });
}
