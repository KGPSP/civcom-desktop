import {
  authorizeExternalProtocol,
  authorizePermissionRequest,
  authorizeTopLevelNavigation
} from "../security/url-policy.js";
import { isAbsolute } from "node:path";

export const APP_START_HIDDEN_ARG = "--hidden";
export const CIVCOM_PARTITION = "persist:civcom";

export type WebPreferences = Readonly<{
  nodeIntegration: false;
  contextIsolation: true;
  sandbox: true;
  webSecurity: true;
  webviewTag: false;
  backgroundThrottling: false;
  partition: typeof CIVCOM_PARTITION;
}>;

/** Deliberately contains neither `preload` nor a user-agent override. */
export function createWebPreferences(): WebPreferences {
  return Object.freeze({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    backgroundThrottling: false,
    partition: CIVCOM_PARTITION
  });
}

export type NavigationResult = Readonly<{ allow: boolean }>;
export type WindowOpenResult = Readonly<{ action: "external" | "deny" }>;

export function createOfflinePageUrl(filePath: string): string {
  if (typeof filePath !== "string") throw new Error("invalid-offline-page-request");
  const html = "<!doctype html><html lang=\"pl\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'none'; script-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; manifest-src 'none'; frame-ancestors 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>CivCom — brak połączenia</title></head><body><main><h1>Brak połączenia z CivCom</h1><p>Nie udało się wczytać usługi. Sprawdź połączenie z internetem i spróbuj ponownie.</p><a id=\"retry\" href=\"#retry\">Spróbuj ponownie</a></main></body></html>";
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function createRuntimeNavigationGate(offlineUrl: string): Readonly<{
  navigate(url: unknown): NavigationResult;
  windowOpen(url: unknown): WindowOpenResult;
}> {
  return Object.freeze({
    navigate(url: unknown): NavigationResult {
      if (url === offlineUrl) {
        return Object.freeze({ allow: true });
      }
      return Object.freeze({ allow: authorizeTopLevelNavigation(url).kind === "allow" });
    },
    windowOpen(url: unknown): WindowOpenResult {
      return Object.freeze({ action: authorizeExternalProtocol(url).kind === "allow" ? "external" : "deny" });
    }
  });
}

function onlyCameraOrMicrophone(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every((entry) => entry === "audio" || entry === "video");
}

export function createPermissionGate(): (request: unknown) => boolean {
  return (request: unknown): boolean => {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      return false;
    }
    const origin = Object.getOwnPropertyDescriptor(request, "origin");
    const permission = Object.getOwnPropertyDescriptor(request, "permission");
    const mediaTypes = Object.getOwnPropertyDescriptor(request, "mediaTypes");
    if (origin === undefined || permission === undefined || !("value" in origin) || !("value" in permission)) {
      return false;
    }
    const decision = authorizePermissionRequest({ origin: origin.value, permission: permission.value });
    if (decision.kind !== "allow") {
      return false;
    }
    if (decision.permission !== "media") {
      return true;
    }
    return mediaTypes !== undefined && "value" in mediaTypes && onlyCameraOrMicrophone(mediaTypes.value);
  };
}

export type DisplayArea = Readonly<{ x: number; y: number; width: number; height: number }>;
export type BoundsFile = Readonly<{ x: number; y: number; width: number; height: number }>;

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

export function normalizeBounds(value: unknown, displays: readonly DisplayArea[]): BoundsFile | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (![candidate.x, candidate.y, candidate.width, candidate.height].every(isFiniteInteger)) {
    return undefined;
  }
  const bounds = candidate as BoundsFile;
  if (displays.length === 0 || bounds.width <= 0 || bounds.height <= 0) return undefined;
  const intersection = (display: DisplayArea): number => Math.max(0, Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x)) * Math.max(0, Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y));
  const target = displays.reduce((best, display) => intersection(display) > intersection(best) ? display : best, displays[0]!);
  const width = Math.min(target.width, Math.max(Math.min(320, target.width), bounds.width));
  const height = Math.min(target.height, Math.max(Math.min(240, target.height), bounds.height));
  return Object.freeze({ x: Math.min(Math.max(bounds.x, target.x), target.x + target.width - width), y: Math.min(Math.max(bounds.y, target.y), target.y + target.height - height), width, height });
}

export type BoundsStorage = Readonly<{ read(): string | undefined; writeAtomic(value: string): void }>;

export class BoundsStore {
  public constructor(private readonly storage: BoundsStorage) {}

  public load(displays: readonly DisplayArea[]): BoundsFile | undefined {
    const raw = this.storage.read();
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return normalizeBounds(parsed, displays);
    } catch {
      return undefined;
    }
  }

  public save(bounds: BoundsFile, displays: readonly DisplayArea[]): void {
    const normalized = normalizeBounds(bounds, displays);
    if (normalized !== undefined) this.storage.writeAtomic(JSON.stringify(normalized));
  }
}

export type Preferences = Readonly<{ autostartPrompted: boolean; autostartEnabled?: boolean }>;

export function createFirstRunState(stored: Preferences | undefined): Readonly<{ promptAutostart: boolean; preferences: Preferences }> {
  if (stored?.autostartPrompted === true) {
    return Object.freeze({ promptAutostart: false, preferences: stored });
  }
  return Object.freeze({ promptAutostart: true, preferences: Object.freeze({ autostartPrompted: true }) });
}

export function isHiddenStart(args: readonly string[]): boolean {
  return args.includes(APP_START_HIDDEN_ARG);
}

export type LoginItemSettings =
  | Readonly<{ openAtLogin: boolean; type: "mainAppService" }>
  | Readonly<{ openAtLogin: boolean; path: string; args: readonly string[] }>;

export function makeLoginItemSettings(platform: NodeJS.Platform, enabled: boolean, executable = process.execPath): LoginItemSettings {
  return platform === "darwin"
    ? Object.freeze({ openAtLogin: enabled, type: "mainAppService" })
    : Object.freeze({ openAtLogin: enabled, path: executable, args: Object.freeze([APP_START_HIDDEN_ARG]) });
}

function safeAbsoluteExecutable(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 4096 && isAbsolute(value) && ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function resolveLinuxAutostartExecutable(input: Readonly<{
  packageType: string;
  executable: unknown;
  appImagePath?: unknown;
  resolveAppImage(path: string): string | undefined;
}>): string | undefined {
  if (input.packageType === "deb") return safeAbsoluteExecutable(input.executable) ? input.executable : undefined;
  if (input.packageType !== "appimage" || !safeAbsoluteExecutable(input.appImagePath)) return undefined;
  try {
    const resolved = input.resolveAppImage(input.appImagePath);
    return resolved === input.appImagePath && safeAbsoluteExecutable(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** XDG desktop-entry quoted Exec token, never a shell command. */
export function escapeDesktopExecPath(value: unknown): string | undefined {
  const hasControl = typeof value === "string" && [...value].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; });
  if (typeof value !== "string" || value === "" || hasControl) return undefined;
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`").replaceAll("%", "%%");
}

const RESERVED_WINDOWS_BASENAMES = new Set(["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"]);

export function sanitizeDownloadBasename(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.normalize("NFC");
  const unsafeCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || '<>:"|?*'.includes(character);
  });
  if (name === "" || name === "." || name === ".." || name.endsWith(".") || name.endsWith(" ") || Buffer.byteLength(name, "utf8") > 240 || name.includes("/") || name.includes("\\") || unsafeCharacter) {
    return undefined;
  }
  const stem = name.split(".", 1)[0]?.toUpperCase();
  if (stem === undefined || RESERVED_WINDOWS_BASENAMES.has(stem)) return undefined;
  return name;
}

export async function resolveDownloadDestination(
  downloadsDirectory: string,
  filename: string,
  exists: (path: string) => boolean | Promise<boolean>,
  pathApi: Readonly<{ isAbsolute(path: string): boolean; join(directory: string, filename: string): string }> = { isAbsolute: (path) => path.startsWith("/"), join: (directory, filename) => `${directory.replace(/[\\/]$/, "")}/${filename}` }
): Promise<string | undefined> {
  const safeName = sanitizeDownloadBasename(filename);
  if (safeName === undefined || downloadsDirectory === "" || !pathApi.isAbsolute(downloadsDirectory)) return undefined;
  const dot = safeName.lastIndexOf(".");
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
  const extension = dot > 0 ? safeName.slice(dot) : "";
  for (let index = 0; index < 10000; index += 1) {
    const candidate = pathApi.join(downloadsDirectory, index === 0 ? safeName : `${stem} (${index})${extension}`);
    if (!(await exists(candidate))) return candidate;
  }
  return undefined;
}

export async function reserveDownloadDestination(
  downloadsDirectory: string,
  filename: string,
  reserve: (path: string) => boolean | Promise<boolean>,
  pathApi: Readonly<{ isAbsolute(path: string): boolean; join(directory: string, filename: string): string }>
): Promise<string | undefined> {
  const safeName = sanitizeDownloadBasename(filename);
  if (safeName === undefined || !pathApi.isAbsolute(downloadsDirectory)) return undefined;
  const dot = safeName.lastIndexOf("."); const stem = dot > 0 ? safeName.slice(0, dot) : safeName; const extension = dot > 0 ? safeName.slice(dot) : "";
  for (let index = 0; index < 10000; index += 1) {
    const candidate = pathApi.join(downloadsDirectory, index === 0 ? safeName : `${stem} (${index})${extension}`);
    if (await reserve(candidate)) return candidate;
  }
  return undefined;
}
