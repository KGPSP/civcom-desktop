import { authorizeExternalProtocol, authorizePermissionRequest, authorizeTopLevelNavigation, classifyTrustedOrigin } from "../security/url-policy.js";
import { sanitizeDownloadBasename } from "./shell.js";

type SafeLog = (event: unknown) => void;

function ownValue(input: unknown, key: string): unknown {
  if (input === null || typeof input !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function frameOrigin(details: unknown): string | undefined {
  const values = [ownValue(details, "securityOrigin"), ownValue(details, "requestingUrl"), ownValue(details, "requestingOrigin")]
    .filter((value): value is string => typeof value === "string");
  if (values.length === 0 || new Set(values).size !== 1) return undefined;
  return values[0];
}

function mediaTypes(details: unknown, singular: boolean): readonly string[] | undefined {
  const value = ownValue(details, singular ? "mediaType" : "mediaTypes");
  if (singular) return value === "audio" || value === "video" ? [value] : undefined;
  return Array.isArray(value) && value.length > 0 && value.every((entry) => entry === "audio" || entry === "video") ? value : undefined;
}

export function createPermissionCallbacks(): Readonly<{
  check(permission: unknown, details: unknown): boolean;
  request(permission: unknown, details: unknown): boolean;
}> {
  const decide = (permission: unknown, details: unknown, singular: boolean): boolean => {
    const origin = frameOrigin(details);
    if (origin === undefined) return false;
    const decision = authorizePermissionRequest({ origin, permission });
    if (decision.kind !== "allow") return false;
    return decision.permission !== "media" || mediaTypes(details, singular) !== undefined;
  };
  return Object.freeze({ check: (permission, details) => decide(permission, details, true), request: (permission, details) => decide(permission, details, false) });
}

export type Preventable = Readonly<{ preventDefault(): void }>;
export function createNavigationCallbacks(dependencies: Readonly<{
  offlineUrl: string;
  load: (url: string) => void;
  openExternal: (url: string) => Promise<void>;
  log: SafeLog;
}>): Readonly<{
  windowOpen(url: string): { action: "deny" };
  navigate(event: Preventable, url: string): void;
}> {
  const external = (url: string): void => { void dependencies.openExternal(url).catch(() => dependencies.log({ event: "navigation-denied", code: "UNCLASSIFIED" })); };
  const internal = (url: string): boolean => url === dependencies.offlineUrl || authorizeTopLevelNavigation(url).kind === "allow";
  return Object.freeze({
    windowOpen(url: string): { action: "deny" } {
      if (internal(url)) dependencies.load(url);
      else if (authorizeExternalProtocol(url).kind === "allow") external(url);
      else dependencies.log({ event: "navigation-denied", code: "UNCLASSIFIED" });
      return { action: "deny" };
    },
    navigate(event: Preventable, url: string): void {
      if (internal(url)) return;
      event.preventDefault();
      if (authorizeExternalProtocol(url).kind === "allow") external(url);
      else dependencies.log({ event: "navigation-denied", code: "UNCLASSIFIED" });
    }
  });
}

export function createWindowCallbacks(dependencies: Readonly<{
  startUrl: string;
  offlineUrl: string;
  load: (url: string) => void;
  show: () => void;
  log: SafeLog;
}>): Readonly<{
  failedLoad(errorCode: number, isMainFrame: boolean, url: string): void;
  retry(url: string): void;
  pageTitle(event: Preventable): "CivCom";
  activate(): void;
  ready(hiddenStart: boolean): void;
}> {
  let offlineFailed = false;
  let activationPending = false;
  return Object.freeze({
    failedLoad(errorCode, isMainFrame, url): void {
      if (!isMainFrame || errorCode === -3 || url === dependencies.offlineUrl || offlineFailed) return;
      offlineFailed = true;
      dependencies.log({ event: "load-failed", code: "ERR_FAILED" });
      dependencies.load(dependencies.offlineUrl);
    },
    retry(url): void { if (url === `${dependencies.offlineUrl}#retry`) { offlineFailed = false; dependencies.load(dependencies.startUrl); } },
    pageTitle(event): "CivCom" { event.preventDefault(); return "CivCom"; },
    activate(): void { activationPending = true; },
    ready(hiddenStart): void { if (activationPending || !hiddenStart) dependencies.show(); activationPending = false; }
  });
}

export function authorizeDownloadRequest(initiatorUrl: unknown, urls: unknown, filename: unknown): boolean {
  const initiator = classifyTrustedOrigin(initiatorUrl);
  if (initiator.kind !== "trusted" || initiator.service !== "civcom" || sanitizeDownloadBasename(filename) === undefined || !Array.isArray(urls) || urls.length === 0) return false;
  return urls.every((url) => {
    if (typeof url !== "string") return false;
    if (url.startsWith("blob:https://civcom.soia.info/")) return true;
    const origin = classifyTrustedOrigin(url);
    return origin.kind === "trusted" && (origin.service === "civcom" || origin.service === "matrix" || origin.service === "call");
  });
}
