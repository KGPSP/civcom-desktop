import { authorizeExternalProtocol, authorizePermissionRequest, authorizeTopLevelNavigation, classifyTrustedOrigin } from "../security/url-policy.js";
import { OFFLINE_RETRY_URL, sanitizeDownloadBasename } from "./shell.js";

type SafeLog = (event: unknown) => void;

type DetailSnapshot = Readonly<{ kind: "ok"; isMainFrame?: unknown; securityOrigin?: unknown; requestingUrl?: unknown; mediaType?: unknown; mediaTypes?: unknown }> | Readonly<{ kind: "error" }>;

function snapshotDetails(input: unknown): DetailSnapshot {
  if (input === null || typeof input !== "object") return Object.freeze({ kind: "error" });
  try {
    const values: Record<string, unknown> = {};
    for (const key of ["isMainFrame", "securityOrigin", "requestingUrl", "mediaType", "mediaTypes"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor)) return Object.freeze({ kind: "error" });
      values[key] = descriptor.value;
    }
    return Object.freeze({ kind: "ok", ...values });
  } catch { return Object.freeze({ kind: "error" }); }
}

function trustedOrigin(value: unknown): string | undefined {
  const result = classifyTrustedOrigin(value);
  return result.kind === "trusted" ? `https://${result.service}.soia.info/` : undefined;
}

function serializedTrustedOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (value !== parsed.origin && value !== `${parsed.origin}/`) return undefined;
    return trustedOrigin(parsed.origin);
  } catch { return undefined; }
}

function frameOrigin(details: Extract<DetailSnapshot, { kind: "ok" }>): string | undefined {
  const values = [details.securityOrigin, details.requestingUrl]
    .filter((value): value is string => typeof value === "string");
  if (values.length === 0) return undefined;
  const origins = values.map(trustedOrigin);
  return origins.some((origin) => origin === undefined) || new Set(origins).size !== 1 ? undefined : origins[0];
}

function checkOrigin(requestingOrigin: unknown, details: Extract<DetailSnapshot, { kind: "ok" }>): string | undefined {
  const origin = trustedOrigin(requestingOrigin);
  if (origin === undefined) return undefined;
  const fromDetails = frameOrigin(details);
  const hasDetailOrigin = details.securityOrigin !== undefined || details.requestingUrl !== undefined;
  return !hasDetailOrigin || fromDetails === origin ? origin : undefined;
}

function safeMediaArray(value: unknown): readonly string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (length === undefined || !("value" in length) || !Number.isInteger(length.value) || length.value < 1 || length.value > 2) return undefined;
    const types: string[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || (descriptor.value !== "audio" && descriptor.value !== "video")) return undefined;
      types.push(descriptor.value);
    }
    return Object.freeze(types);
  } catch { return undefined; }
}

function mediaTypes(details: Extract<DetailSnapshot, { kind: "ok" }>, singular: boolean): readonly string[] | undefined {
  const value = singular ? details.mediaType : details.mediaTypes;
  if (singular) return value === "audio" || value === "video" ? [value] : undefined;
  return safeMediaArray(value);
}

type PermissionFrame = Readonly<{
  detached: boolean;
  frameTreeNodeId: number;
  framesInSubtree: readonly PermissionFrame[];
  origin: string;
  processId: number;
  routingId: number;
  url: string;
  isDestroyed(): boolean;
}>;

type PermissionContents = Readonly<{ mainFrame: PermissionFrame }>;
type MediaKind = "audio" | "video";
type MediaPermissionPrompt = (request: Readonly<{ mediaTypes: readonly MediaKind[] }>, contents: PermissionContents) => Promise<boolean>;
type FrameSnapshot = Readonly<{
  frame: PermissionFrame;
  frameTreeNodeId: number;
  origin: string;
  processId: number;
  routingId: number;
  url: string;
}>;

function snapshotFrame(frame: PermissionFrame): FrameSnapshot | undefined {
  try {
    if (frame.isDestroyed() || frame.detached) return undefined;
    const { frameTreeNodeId, origin, processId, routingId, url } = frame;
    if (![frameTreeNodeId, processId, routingId].every(Number.isInteger) || typeof origin !== "string" || typeof url !== "string") return undefined;
    return Object.freeze({ frame, frameTreeNodeId, origin, processId, routingId, url });
  } catch { return undefined; }
}

function sameFrame(left: FrameSnapshot, right: FrameSnapshot): boolean {
  return left.frameTreeNodeId === right.frameTreeNodeId
    && left.processId === right.processId
    && left.routingId === right.routingId
    && left.origin === right.origin
    && left.url === right.url;
}

function resolveMediaRequestFrame(contents: PermissionContents, details: Extract<DetailSnapshot, { kind: "ok" }>): FrameSnapshot | undefined {
  const requestOrigin = frameOrigin(details);
  const requestUrl = details.requestingUrl;
  const securityOrigin = serializedTrustedOrigin(details.securityOrigin);
  if (requestOrigin === undefined || securityOrigin !== requestOrigin || typeof requestUrl !== "string" || typeof details.isMainFrame !== "boolean") return undefined;
  let frames: readonly PermissionFrame[];
  try {
    frames = details.isMainFrame ? [contents.mainFrame] : contents.mainFrame.framesInSubtree;
    if (!Array.isArray(frames) || frames.length > 128) return undefined;
  } catch { return undefined; }
  const matches: FrameSnapshot[] = [];
  for (const frame of frames) {
    const candidate = snapshotFrame(frame);
    if (candidate !== undefined && candidate.url === requestUrl && trustedOrigin(candidate.origin) === requestOrigin) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function createPermissionCallbacks(dependencies?: Readonly<{ confirmMedia: MediaPermissionPrompt }>): Readonly<{
  check(permission: unknown, requestingOrigin: unknown, details: unknown, contents?: PermissionContents | null): boolean;
  request(permission: unknown, details: unknown, contents?: PermissionContents): boolean | Promise<boolean>;
}> {
  const decide = (permission: unknown, origin: string | undefined, details: DetailSnapshot, singular: boolean): boolean => {
    if (details.kind === "error") return false;
    if (origin === undefined) return false;
    const decision = authorizePermissionRequest({ origin, permission });
    if (decision.kind !== "allow") return false;
    return decision.permission !== "media" || mediaTypes(details, singular) !== undefined;
  };
  return Object.freeze({
    check: (permission, requestingOrigin, details) => {
      const snapshot = snapshotDetails(details);
      if (permission === "media") return false;
      return decide(permission, snapshot.kind === "ok" ? checkOrigin(requestingOrigin, snapshot) : undefined, snapshot, true);
    },
    request: (permission, details, contents) => {
      const snapshot = snapshotDetails(details);
      if (permission !== "media") return decide(permission, snapshot.kind === "ok" ? frameOrigin(snapshot) : undefined, snapshot, false);
      if (dependencies === undefined || contents === undefined || snapshot.kind === "error") return false;
      const requestedTypes = mediaTypes(snapshot, false);
      const requestingFrame = resolveMediaRequestFrame(contents, snapshot);
      if (requestedTypes === undefined || requestingFrame === undefined) return false;
      const typedMedia = requestedTypes as readonly MediaKind[];
      return dependencies.confirmMedia(Object.freeze({ mediaTypes: typedMedia }), contents).then((approved) => {
        if (!approved) return false;
        const currentFrame = resolveMediaRequestFrame(contents, snapshot);
        return currentFrame !== undefined && sameFrame(requestingFrame, currentFrame);
      }).catch(() => false);
    }
  });
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
    retry(url): void {
      if (offlineFailed && url === OFFLINE_RETRY_URL) {
        offlineFailed = false;
        dependencies.load(dependencies.startUrl);
      }
    },
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
