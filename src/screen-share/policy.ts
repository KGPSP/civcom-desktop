export type DisplayMediaRoute = "system-picker" | "wayland-portal" | "local-picker" | "deny";

export type DisplayMediaRequestSnapshot =
  | Readonly<{ kind: "allow"; frame: object; audioRequested: boolean }>
  | Readonly<{ kind: "deny" }>;

type OwnRecord = ReadonlyMap<string, unknown>;

function readOwnRecord(input: unknown, fields: readonly string[]): OwnRecord | undefined {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const result = new Map<string, unknown>();
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

export function authorizeDisplayMediaRequestSnapshot(input: unknown): DisplayMediaRequestSnapshot {
  const values = readOwnRecord(input, ["frame", "securityOrigin", "userGesture", "videoRequested", "audioRequested"]);
  if (values === undefined) return Object.freeze({ kind: "deny" });
  const frame = values.get("frame");
  const securityOrigin = values.get("securityOrigin");
  const userGesture = values.get("userGesture");
  const videoRequested = values.get("videoRequested");
  const audioRequested = values.get("audioRequested");
  const validFrame = (() => {
    try { return frame !== null && typeof frame === "object" && !Array.isArray(frame); } catch { return false; }
  })();
  if (
    !validFrame ||
    (securityOrigin !== "https://civcom.soia.info" && securityOrigin !== "https://call.soia.info") ||
    userGesture !== true || videoRequested !== true || typeof audioRequested !== "boolean"
  ) {
    return Object.freeze({ kind: "deny" });
  }
  return Object.freeze({ kind: "allow", frame: frame as object, audioRequested });
}

function readOptionalOwnValue(input: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, field);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

export function selectDisplayMediaRoute(input: unknown): DisplayMediaRoute {
  const values = readOwnRecord(input, ["platform"]);
  if (values === undefined) return "deny";
  try {
    const platform = values.get("platform");
    if (platform === "win32") return "local-picker";
    if (platform === "darwin") {
      const systemVersion = readOptionalOwnValue(input as object, "systemVersion");
      if (typeof systemVersion !== "string" || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/.test(systemVersion)) return "deny";
      const majorText = systemVersion.split(".", 1)[0];
      const major = majorText === undefined ? Number.NaN : Number(majorText);
      if (!Number.isSafeInteger(major) || major < 13) return "deny";
      return major >= 15 ? "system-picker" : "local-picker";
    }
    if (platform === "linux") {
      const sessionType = readOptionalOwnValue(input as object, "sessionType");
      if (sessionType === "wayland") return "wayland-portal";
      if (sessionType === "x11") return "local-picker";
    }
    return "deny";
  } catch {
    return "deny";
  }
}
