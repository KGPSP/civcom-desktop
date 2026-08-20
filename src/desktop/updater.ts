import { posix, win32 } from "node:path";

export const LATEST_RELEASE_PAGE = "https://github.com/KGPSP/civcom-desktop/releases/latest";
export const PILOT_UPDATE_NOTICE = Object.freeze({
  title: "CivCom — wersja pilotażowa",
  message: "Aktualizacje automatyczne są wyłączone w tej niepodpisanej wersji pilotażowej CivCom.",
  detail: "Nową wersję przekaże opiekun pilota."
});
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type PackageType = "development" | "windows" | "macos" | "appimage" | "deb" | "unknown";
export type PackagedUpdatePolicy = "pilot" | "production" | "disabled";

export type UpdateController = Readonly<{
  enabled: boolean;
  start(): Promise<void>;
  manual(): Promise<void>;
  stop(): void;
}>;

type AutoUpdater = {
  logger: unknown | null;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableWebInstaller: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: "error" | "update-downloaded", listener: () => unknown): unknown;
};

type UpdaterConstructor = new () => AutoUpdater;
type UpdaterModule = Readonly<Record<string, unknown>>;
type UpdaterImport = Readonly<{ specifier: string; exportName: string }>;

const UPDATER_IMPORTS = Object.freeze({
  windows: Object.freeze({ specifier: "electron-updater/out/NsisUpdater.js", exportName: "NsisUpdater" }),
  macos: Object.freeze({ specifier: "electron-updater/out/MacUpdater.js", exportName: "MacUpdater" }),
  appimage: Object.freeze({ specifier: "electron-updater/out/AppImageUpdater.js", exportName: "AppImageUpdater" })
} satisfies Record<"windows" | "macos" | "appimage", UpdaterImport>);

async function importUpdaterModule(specifier: string): Promise<UpdaterModule> {
  if (specifier === UPDATER_IMPORTS.windows.specifier) return await import("electron-updater/out/NsisUpdater.js");
  if (specifier === UPDATER_IMPORTS.macos.specifier) return await import("electron-updater/out/MacUpdater.js");
  if (specifier === UPDATER_IMPORTS.appimage.specifier) return await import("electron-updater/out/AppImageUpdater.js");
  throw new Error("updater-import-not-allowed");
}

export async function loadVerifiedUpdater(
  packageType: PackageType,
  importer: (specifier: string) => Promise<UpdaterModule> | UpdaterModule = importUpdaterModule
): Promise<AutoUpdater> {
  if (packageType !== "windows" && packageType !== "macos" && packageType !== "appimage") throw new Error("updater-disabled-for-package-type");
  const selected = UPDATER_IMPORTS[packageType];
  const module = await importer(selected.specifier);
  const Updater = module[selected.exportName];
  if (typeof Updater !== "function") throw new Error("updater-class-unavailable");
  return new (Updater as UpdaterConstructor)();
}

function safeNotify(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* a reporter cannot weaken the policy */ }
}

function safeString(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 4096 && ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function detectPackagedUpdatePolicy(input: Readonly<{
  isPackaged: boolean;
  appPath: string;
  readMetadata(path: string): string | undefined;
}>): PackagedUpdatePolicy {
  if (input.isPackaged !== true || !safeString(input.appPath)) return "disabled";
  const pathApi = process.platform === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(input.appPath)) return "disabled";
  try {
    const serialized = input.readMetadata(pathApi.join(input.appPath, "package.json"));
    if (typeof serialized !== "string" || serialized.length === 0 || serialized.length > 64 * 1024) return "disabled";
    const metadata: unknown = JSON.parse(serialized);
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return "disabled";
    const descriptor = Object.getOwnPropertyDescriptor(metadata, "civcomUpdatePolicy");
    if (descriptor === undefined || !("value" in descriptor)) return "disabled";
    if (descriptor.value === "pilot-disabled-v1") return "pilot";
    if (descriptor.value === "production-enabled-v1") return "production";
  } catch { /* malformed or inaccessible packaged metadata disables updates */ }
  return "disabled";
}

export function detectPackageType(input: Readonly<{
  isPackaged: boolean;
  platform: string;
  resourcesPath: string;
  appImagePath?: string;
  readMarker(path: string): string | undefined;
  inspectAppImage(path: string): boolean;
}>): PackageType {
  if (!input.isPackaged) return "development";
  try {
    if (!safeString(input.resourcesPath)) return "unknown";
    const pathApi = input.platform === "win32" ? win32 : input.platform === "darwin" || input.platform === "linux" ? posix : undefined;
    if (pathApi === undefined || !pathApi.isAbsolute(input.resourcesPath)) return "unknown";
    let marker: string | undefined;
    try { marker = input.readMarker(pathApi.join(input.resourcesPath, "package-type")); } catch { return "unknown"; }
    if (input.platform === "linux" && input.appImagePath !== undefined) {
      if (!safeString(input.appImagePath) || !posix.isAbsolute(input.appImagePath)) return "unknown";
      try { if (input.inspectAppImage(input.appImagePath)) return "appimage"; } catch { /* exact marker may still identify DEB */ }
    }
    if (input.platform === "win32" && marker === "windows\n") return "windows";
    if (input.platform === "darwin" && marker === "macos\n") return "macos";
    if (input.platform === "linux" && marker === "deb") return "deb";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function manualController(input: Readonly<{ enabled: boolean; openManual?: () => void | Promise<void>; onError?: () => void }>): UpdateController {
  return Object.freeze({
    enabled: input.enabled,
    async start(): Promise<void> { /* manual packages never schedule checks */ },
    async manual(): Promise<void> {
      if (!input.enabled) return;
      try { await input.openManual?.(); } catch { safeNotify(input.onError); }
    },
    stop(): void { /* no updater resources exist */ }
  });
}

function manualInput(input: Readonly<{ openManual?: () => void | Promise<void>; onError?: () => void }>, enabled: boolean): Readonly<{ enabled: boolean; openManual?: () => void | Promise<void>; onError?: () => void }> {
  return Object.freeze({ enabled, ...(input.openManual === undefined ? {} : { openManual: input.openManual }), ...(input.onError === undefined ? {} : { onError: input.onError }) });
}

export async function createUpdateController(input: Readonly<{
  updatePolicy: PackagedUpdatePolicy;
  packageType: PackageType;
  loadUpdater(packageType: "windows" | "macos" | "appimage"): Promise<AutoUpdater> | AutoUpdater;
  openManual?: () => void | Promise<void>;
  showPilotNotice?: () => void | Promise<void>;
  onError?: () => void;
  confirmRestart?: () => boolean | Promise<boolean>;
  every(callback: () => void, milliseconds: number): unknown;
  clearEvery(handle: unknown): void;
  unref(handle: unknown): void;
}>): Promise<UpdateController> {
  if (input.updatePolicy === "pilot") return manualController(manualInput({
    ...(input.showPilotNotice === undefined ? {} : { openManual: input.showPilotNotice }),
    ...(input.onError === undefined ? {} : { onError: input.onError })
  }, true));
  if (input.updatePolicy !== "production") return manualController(manualInput(input, false));
  if (input.packageType === "development") return manualController(manualInput(input, false));
  if (input.packageType === "deb" || input.packageType === "unknown") return manualController(manualInput(input, true));
  if (input.packageType !== "windows" && input.packageType !== "macos" && input.packageType !== "appimage") return manualController(manualInput(input, true));

  let autoUpdater: AutoUpdater;
  try {
    autoUpdater = await input.loadUpdater(input.packageType);
    autoUpdater.logger = null;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableWebInstaller = true;
  } catch {
    safeNotify(input.onError);
    return manualController(manualInput(input, true));
  }

  let running = false;
  let timer: unknown;
  const check = async (): Promise<void> => {
    if (running) return;
    running = true;
    try { await autoUpdater.checkForUpdates(); } catch { safeNotify(input.onError); } finally { running = false; }
  };
  const downloaded = async (): Promise<void> => {
    let confirmed = false;
    try { confirmed = (await input.confirmRestart?.()) === true; } catch { safeNotify(input.onError); }
    if (!confirmed) return;
    try { autoUpdater.quitAndInstall(); } catch { safeNotify(input.onError); }
  };
  try {
    autoUpdater.on("error", () => safeNotify(input.onError));
    autoUpdater.on("update-downloaded", () => downloaded());
  } catch {
    safeNotify(input.onError);
  }

  return Object.freeze({
    enabled: true,
    async start(): Promise<void> {
      if (timer === undefined) {
        try {
          timer = input.every(() => { void check(); }, UPDATE_INTERVAL_MS);
          try { input.unref(timer); } catch { safeNotify(input.onError); }
        } catch { safeNotify(input.onError); }
      }
      await check();
    },
    async manual(): Promise<void> { await check(); },
    stop(): void {
      if (timer === undefined) return;
      const current = timer;
      timer = undefined;
      try { input.clearEvery(current); } catch { safeNotify(input.onError); }
    }
  });
}
