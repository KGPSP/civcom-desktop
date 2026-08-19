import {
  authorizeExternalProtocol,
  authorizePermissionRequest,
  authorizeTopLevelNavigation
} from "../security/url-policy.js";

export const APP_START_HIDDEN_ARG = "--hidden";
export const CIVCOM_PARTITION = "persist:civcom";
export const APPROVED_DOWNLOAD_PAGE = "https://github.com/KGPSP/civcom-desktop/releases";

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
  return new URL(`file://${filePath}`).href;
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

function isVisibleOnAnyDisplay(bounds: BoundsFile, displays: readonly DisplayArea[]): boolean {
  return displays.some((display) =>
    bounds.x + bounds.width > display.x && bounds.x < display.x + display.width &&
    bounds.y + bounds.height > display.y && bounds.y < display.y + display.height
  );
}

function validBounds(value: unknown, displays: readonly DisplayArea[]): value is BoundsFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (![candidate.x, candidate.y, candidate.width, candidate.height].every(isFiniteInteger)) {
    return false;
  }
  const bounds = candidate as BoundsFile;
  if (bounds.width < 320 || bounds.height < 240 || bounds.width > 10000 || bounds.height > 10000) {
    return false;
  }
  return isVisibleOnAnyDisplay(bounds, displays);
}

export type BoundsStorage = Readonly<{ read(): string | undefined; writeAtomic(value: string): void }>;

export class BoundsStore {
  public constructor(private readonly storage: BoundsStorage) {}

  public load(displays: readonly DisplayArea[]): BoundsFile | undefined {
    const raw = this.storage.read();
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return validBounds(parsed, displays) ? Object.freeze({ ...parsed }) : undefined;
    } catch {
      return undefined;
    }
  }

  public save(bounds: BoundsFile, displays: readonly DisplayArea[]): void {
    if (validBounds(bounds, displays)) {
      this.storage.writeAtomic(JSON.stringify(bounds));
    }
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

export function makeLoginItemSettings(platform: NodeJS.Platform, enabled: boolean): Readonly<{ openAtLogin: boolean; openAsHidden?: boolean; args: readonly string[] }> {
  return Object.freeze(platform === "darwin"
    ? { openAtLogin: enabled, openAsHidden: enabled, args: Object.freeze([APP_START_HIDDEN_ARG]) }
    : { openAtLogin: enabled, args: Object.freeze([APP_START_HIDDEN_ARG]) });
}

const RESERVED_WINDOWS_BASENAMES = new Set(["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"]);

export function sanitizeDownloadBasename(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.normalize("NFC").trim();
  const unsafeCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || '<>:"|?*'.includes(character);
  });
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || unsafeCharacter) {
    return undefined;
  }
  const stem = name.split(".", 1)[0]?.toUpperCase();
  if (stem === undefined || RESERVED_WINDOWS_BASENAMES.has(stem)) return undefined;
  return name;
}

export async function resolveDownloadDestination(
  downloadsDirectory: string,
  filename: string,
  exists: (path: string) => boolean | Promise<boolean>
): Promise<string | undefined> {
  const safeName = sanitizeDownloadBasename(filename);
  if (safeName === undefined || downloadsDirectory === "" || !downloadsDirectory.startsWith("/")) return undefined;
  const dot = safeName.lastIndexOf(".");
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
  const extension = dot > 0 ? safeName.slice(dot) : "";
  for (let index = 0; index < 10000; index += 1) {
    const candidate = `${downloadsDirectory.replace(/\/$/, "")}/${index === 0 ? safeName : `${stem} (${index})${extension}`}`;
    if (!(await exists(candidate))) return candidate;
  }
  return undefined;
}

export type UpdateSchedulerDependencies = Readonly<{
  isPackaged: boolean;
  platform: NodeJS.Platform;
  isDeb?: boolean;
  check: () => Promise<void>;
  openManual?: () => void;
  every: (callback: () => void, milliseconds: number) => unknown;
  clearEvery: (handle: unknown) => void;
  unref: (handle: unknown) => void;
}>;

export class UpdateScheduler {
  #running = false;
  #timer: unknown;
  public readonly enabled: boolean;

  public constructor(private readonly dependencies: UpdateSchedulerDependencies) {
    this.enabled = dependencies.isPackaged;
  }

  public async start(): Promise<void> {
    if (!this.enabled || this.dependencies.isDeb === true) return;
    if (this.#timer === undefined) {
      this.#timer = this.dependencies.every(() => { void this.check(); }, 6 * 60 * 60 * 1000);
      this.dependencies.unref(this.#timer);
    }
    await this.check();
  }

  public async manual(): Promise<void> {
    if (!this.enabled) return;
    if (this.dependencies.isDeb === true) {
      this.dependencies.openManual?.();
      return;
    }
    await this.check();
  }

  public stop(): void {
    if (this.#timer !== undefined) {
      this.dependencies.clearEvery(this.#timer);
      this.#timer = undefined;
    }
  }

  private async check(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.dependencies.check();
    } catch {
      // Updater errors are intentionally reduced to a safe local code by the caller.
    } finally {
      this.#running = false;
    }
  }
}
