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

function trustedOrigin(value: unknown): string | undefined {
  const result = classifyTrustedOrigin(value);
  return result.kind === "trusted" ? `https://${result.service}.soia.info/` : undefined;
}

function frameOrigin(details: unknown): string | undefined {
  const values = [ownValue(details, "securityOrigin"), ownValue(details, "requestingUrl")]
    .filter((value): value is string => typeof value === "string");
  if (values.length === 0) return undefined;
  const origins = values.map(trustedOrigin);
  return origins.some((origin) => origin === undefined) || new Set(origins).size !== 1 ? undefined : origins[0];
}

function checkOrigin(requestingOrigin: unknown, details: unknown): string | undefined {
  const origin = trustedOrigin(requestingOrigin);
  if (origin === undefined) return undefined;
  const fromDetails = frameOrigin(details);
  const hasDetailOrigin = ownValue(details, "securityOrigin") !== undefined || ownValue(details, "requestingUrl") !== undefined;
  return !hasDetailOrigin || fromDetails === origin ? origin : undefined;
}

function mediaTypes(details: unknown, singular: boolean): readonly string[] | undefined {
  const value = ownValue(details, singular ? "mediaType" : "mediaTypes");
  if (singular) return value === "audio" || value === "video" ? [value] : undefined;
  return Array.isArray(value) && value.length > 0 && value.every((entry) => entry === "audio" || entry === "video") ? value : undefined;
}

export function createPermissionCallbacks(): Readonly<{
  check(permission: unknown, requestingOrigin: unknown, details: unknown): boolean;
  request(permission: unknown, details: unknown): boolean;
}> {
  const decide = (permission: unknown, origin: string | undefined, details: unknown, singular: boolean): boolean => {
    if (origin === undefined) return false;
    const decision = authorizePermissionRequest({ origin, permission });
    if (decision.kind !== "allow") return false;
    return decision.permission !== "media" || mediaTypes(details, singular) !== undefined;
  };
  return Object.freeze({ check: (permission, requestingOrigin, details) => decide(permission, checkOrigin(requestingOrigin, details), details, true), request: (permission, details) => decide(permission, frameOrigin(details), details, false) });
}

export type Preventable = Readonly<{ preventDefault(): void }>;
export function createTraySafely(create: () => void): boolean {
  try { create(); return true; } catch { return false; }
}
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
  hide: () => void;
  log: SafeLog;
}>): Readonly<{
  failedLoad(errorCode: number, isMainFrame: boolean, url: string): void;
  retry(url: string): void;
  pageTitle(event: Preventable): "CivCom";
  activate(): void;
  ready(hiddenStart: boolean, trayAvailable: boolean): void;
  close(event: Preventable, trayAvailable: boolean): "hide" | "close";
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
    ready(hiddenStart, trayAvailable): void { if (activationPending || !hiddenStart || !trayAvailable) dependencies.show(); activationPending = false; },
    close(event, trayAvailable): "hide" | "close" { if (!trayAvailable) return "close"; event.preventDefault(); dependencies.hide(); dependencies.log({ event: "security-event", code: "UNCLASSIFIED" }); return "hide"; }
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
