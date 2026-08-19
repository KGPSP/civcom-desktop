import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, protocol, screen, session, shell, Tray, webContents, type MenuItemConstructorOptions } from "electron";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, posix, win32 } from "node:path";
import { BoundsStore, createFirstRunState, createOfflinePageUrl, createWebPreferences, escapeDesktopExecPath, isHiddenStart, makeLoginItemSettings, OFFLINE_RETRY_URL, reserveDownloadDestination, resolveLinuxAutostartExecutable, resolveUnpackagedHarnessOptions, type UnpackagedHarnessOptions } from "./desktop/shell.js";
import { createUpdateController, detectPackageType, loadVerifiedUpdater, LATEST_RELEASE_PAGE, type PackageType, type UpdateController } from "./desktop/updater.js";
import { resolveVerifiedAppImageRuntime } from "./desktop/appimage-runtime.js";
import { createPackagedSmokeResult, isPackagedSmokeRequested, packagedSmokeResultPath } from "./desktop/packaged-smoke.js";
import { RotatingSafeLogger } from "./desktop/safe-logger.js";
import { resolveStartUrl } from "./security/url-policy.js";
import { installClientCertificateDenyHandler } from "./security/client-certificate.js";
import { authorizeDownloadRequest, createNavigationCallbacks, createPermissionCallbacks, createTraySafely, createWindowCallbacks } from "./desktop/electron-adapters.js";
import { DisplayMediaCoordinator } from "./screen-share/coordinator.js";
import { watchFrameLifetime } from "./screen-share/frame-lifetime.js";
import { installDisplayMediaRequestHandler } from "./screen-share/install.js";
import { createLocalPickerHost } from "./screen-share/local-picker-host.js";
import { installPickerProtocol, registerLocalScheme } from "./screen-share/local-protocol.js";
import type { CaptureSourceCandidate } from "./screen-share/source-catalog.js";

const SCREEN_SHARE_NATIVE_OPERATION_TIMEOUT_MS = 120_000;

registerLocalScheme(protocol);

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let updater: UpdateController | undefined;
let activationPending = false;
let trayAvailable = false;
const downloadReservations = new Set<string>();
let lifecycleLogger: RotatingSafeLogger | undefined;
let screenSharing: Readonly<{ shutdown(): void }> | undefined;

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try { writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" }); renameSync(temporary, path); } finally { try { rmSync(temporary); } catch { /* renamed or absent */ } }
}
function readOptional(path: string): string | undefined { try { return readFileSync(path, "utf8"); } catch { return undefined; } }
function createLogger(): RotatingSafeLogger {
  const directory = join(app.getPath("userData"), "logs");
  return new RotatingSafeLogger({ maxBytes: 256 * 1024, maxFiles: 3, now: () => new Date(), read: (name) => readOptional(join(directory, name)), write: (name, contents) => writeAtomic(join(directory, name), contents), remove: (name) => { try { rmSync(join(directory, name)); } catch { /* absent log */ } } });
}
function explicitDevelopmentUrl(): string | undefined {
  if (app.isPackaged) return undefined;
  const argument = process.argv.find((value) => value.startsWith("--civcom-dev-url="));
  return process.env.CIVCOM_DEV_URL ?? argument?.slice("--civcom-dev-url=".length);
}
function resolvedStartUrl(): string | undefined {
  const decision = resolveStartUrl({ isPackaged: app.isPackaged, developmentUrl: explicitDevelopmentUrl() });
  return decision.kind === "allow" ? decision.url : undefined;
}
function unpackagedHarnessOptions(): UnpackagedHarnessOptions | undefined {
  return resolveUnpackagedHarnessOptions({
    isPackaged: app.isPackaged,
    marker: process.env.CIVCOM_UNPACKAGED_HARNESS,
    partition: process.env.CIVCOM_UNPACKAGED_HARNESS_PARTITION
  });
}
function preferencesPath(): string { return join(app.getPath("userData"), "preferences.json"); }
function boundsPath(): string { return join(app.getPath("userData"), "window-bounds.json"); }
type Preferences = Readonly<{ autostartPrompted: boolean; autostartEnabled?: boolean }>;
function readPreferences(): Preferences | undefined {
  const raw = readOptional(preferencesPath());
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.autostartPrompted !== true || (record.autostartEnabled !== undefined && typeof record.autostartEnabled !== "boolean")) return undefined;
    return record.autostartEnabled === undefined ? Object.freeze({ autostartPrompted: true }) : Object.freeze({ autostartPrompted: true, autostartEnabled: record.autostartEnabled });
  } catch { return undefined; }
}
function writePreferences(preferences: Preferences): void { writeAtomic(preferencesPath(), JSON.stringify(preferences)); }
function resolveRuntimeAppImage(path: string): string | undefined {
  return resolveVerifiedAppImageRuntime({
    appImagePath: path,
    appDir: process.env.APPDIR,
    executablePath: process.execPath,
    resourcesPath: process.resourcesPath
  });
}
function applyLoginStartup(enabled: boolean, packageType: PackageType): void {
  if (process.platform === "linux") {
    const xdgConfig = process.env.XDG_CONFIG_HOME;
    const path = join(xdgConfig !== undefined && xdgConfig.startsWith("/") ? xdgConfig : join(app.getPath("home"), ".config"), "autostart", "civcom.desktop");
    if (!enabled) { try { rmSync(path); } catch { /* already disabled */ } return; }
    const selected = resolveLinuxAutostartExecutable({ packageType, executable: process.execPath, ...(process.env.APPIMAGE === undefined ? {} : { appImagePath: process.env.APPIMAGE }), resolveAppImage: resolveRuntimeAppImage });
    const executable = escapeDesktopExecPath(selected);
    if (executable === undefined) return;
    writeAtomic(path, `[Desktop Entry]\nType=Application\nName=CivCom\nExec="${executable}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  const settings = makeLoginItemSettings(process.platform, enabled, process.execPath);
  app.setLoginItemSettings("type" in settings
    ? { openAtLogin: settings.openAtLogin, type: settings.type }
    : { openAtLogin: settings.openAtLogin, path: settings.path, args: [...settings.args] });
}
async function promptForAutostart(packageType: PackageType): Promise<void> {
  if (!app.isPackaged) return;
  const state = createFirstRunState(readPreferences());
  if (!state.promptAutostart) return;
  const response = await dialog.showMessageBox({ type: "question", buttons: ["Włącz", "Nie włączaj"], defaultId: 0, cancelId: 1, title: "CivCom", message: "Czy włączać automatyczne uruchamianie CivCom po zalogowaniu do systemu?" });
  const enabled = response.response === 0;
  applyLoginStartup(enabled, packageType);
  writePreferences(Object.freeze({ autostartPrompted: true, autostartEnabled: enabled }));
}
function showMainWindow(): void { if (mainWindow === undefined || mainWindow.isDestroyed()) { activationPending = true; return; } mainWindow.show(); mainWindow.focus(); }
function quitApplication(): void { quitting = true; screenSharing?.shutdown(); updater?.stop(); lifecycleLogger?.lifecycle("stop"); app.quit(); }
function createMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { label: "CivCom", submenu: [{ label: "Pokaż CivCom", click: showMainWindow }, { label: "Ukryj CivCom", click: () => mainWindow?.hide() }, { type: "separator" }, { label: "Sprawdź aktualizacje", click: () => { void updater?.manual(); } }, { type: "separator" }, { label: "Zakończ CivCom", click: quitApplication }] },
    { label: "Edycja", submenu: [{ role: "undo", label: "Cofnij" }, { role: "redo", label: "Ponów" }, { type: "separator" }, { role: "cut", label: "Wytnij" }, { role: "copy", label: "Kopiuj" }, { role: "paste", label: "Wklej" }, { role: "selectAll", label: "Zaznacz wszystko" }] },
    { label: "Okno", submenu: [{ role: "minimize", label: "Minimalizuj" }, { role: "close", label: "Zamknij" }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function createTray(logger: RotatingSafeLogger): boolean {
  const available = createTraySafely(() => {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), "assets", "civcom-tray.png"));
    if (icon.isEmpty()) throw new Error("empty-icon");
    tray = new Tray(icon);
    tray.setToolTip("CivCom");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Pokaż CivCom", click: showMainWindow }, { label: "Ukryj CivCom", click: () => mainWindow?.hide() }, { type: "separator" }, { label: "Sprawdź aktualizacje", click: () => { void updater?.manual(); } }, { type: "separator" }, { label: "Zakończ CivCom", click: quitApplication }]));
    tray.on("click", showMainWindow);
  });
  if (!available) logger.write({ event: "security-event", code: "UNCLASSIFIED" });
  return available;
}
function configureSession(logger: RotatingSafeLogger, harness?: UnpackagedHarnessOptions): Electron.Session {
  const civcomSession = harness === undefined ? session.fromPartition("persist:civcom") : session.fromPartition(harness.partition);
  civcomSession.setSSLConfig({ minVersion: "tls1.2", maxVersion: "tls1.3" });
  if (harness !== undefined) {
    civcomSession.setPermissionCheckHandler(() => false);
    civcomSession.setPermissionRequestHandler((_contents, _name, callback) => callback(false));
    civcomSession.setDevicePermissionHandler(() => false);
    return civcomSession;
  }
  const permission = createPermissionCallbacks({
    confirmMedia: async ({ mediaTypes }, contents) => {
      const resource = mediaTypes.length === 2 ? "mikrofonu i kamery" : mediaTypes[0] === "audio" ? "mikrofonu" : "kamery";
      const options = {
        type: "question" as const,
        buttons: ["Zezwól", "Odmów"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: "CivCom — uprawnienia",
        message: `CivCom prosi o dostęp do ${resource}.`,
        detail: "Dostęp otrzyma tylko bieżące, zweryfikowane żądanie komunikatora."
      };
      const owner = BrowserWindow.fromWebContents(contents as Electron.WebContents);
      const result = owner === null ? await dialog.showMessageBox(options) : await dialog.showMessageBox(owner, options);
      return result.response === 0;
    }
  });
  civcomSession.setPermissionCheckHandler((contents, name, requestingOrigin, details) => permission.check(name, requestingOrigin, details, contents));
  civcomSession.setPermissionRequestHandler((contents, name, callback, details) => {
    void Promise.resolve(permission.request(name, details, contents)).then(callback, () => callback(false));
  });
  civcomSession.setDevicePermissionHandler(() => false);
  const environment = Object.freeze({
    platform: process.platform,
    systemVersion: process.getSystemVersion(),
    ...(process.platform === "linux" ? { sessionType: process.env.XDG_SESSION_TYPE } : {})
  });
  installPickerProtocol({ sessions: session, rootDirectory: join(app.getAppPath(), "dist", "screen-share") });
  const pickerHost = createLocalPickerHost({
    ipcMain,
    createWindow: (options) => new BrowserWindow(options),
    preloadPath: join(app.getAppPath(), "dist", "screen-share", "picker-preload.cjs")
  });
  const captureSources = async (): Promise<readonly CaptureSourceCandidate<Electron.DesktopCapturerSource>[]> => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } });
    return Object.freeze(sources.map((source) => {
      let id: unknown;
      let name: unknown;
      let thumbnailDataUrl: unknown;
      try { id = source.id; name = source.name; thumbnailDataUrl = source.thumbnail.toDataURL(); } catch { /* malformed native source is skipped by the catalog */ }
      return Object.freeze({ source, id, name, thumbnailDataUrl });
    }));
  };
  const frameUsable = (frame: object): boolean => {
    try {
      const requestFrame = frame as Electron.WebFrameMain;
      return !requestFrame.isDestroyed() && !requestFrame.detached && webContents.fromFrame(requestFrame)?.session === civcomSession;
    } catch { return false; }
  };
  const coordinator = new DisplayMediaCoordinator<Electron.DesktopCapturerSource>({
    environment,
    getSources: captureSources,
    refreshSource: async (selected) => {
      const selectedId = selected.id;
      if (typeof selectedId !== "string") return undefined;
      const matches = (await captureSources()).filter((candidate) => candidate.id === selectedId);
      return matches.length === 1 ? matches[0] : undefined;
    },
    presentPicker: (presentation, settle) => pickerHost.present(presentation, settle),
    watchFrame: (frame, onGone) => {
      const requestFrame = frame as Electron.WebFrameMain;
      const owner = webContents.fromFrame(requestFrame);
      if (owner === undefined) { onGone(); return () => undefined; }
      return watchFrameLifetime({
        listen: (event, listener) => {
          if (event === "destroyed") owner.once("destroyed", listener);
          else if (event === "render-process-gone") owner.once("render-process-gone", listener);
          else owner.once("did-start-navigation", listener);
        },
        unlisten: (event, listener) => {
          if (event === "destroyed") owner.removeListener("destroyed", listener);
          else if (event === "render-process-gone") owner.removeListener("render-process-gone", listener);
          else owner.removeListener("did-start-navigation", listener);
        },
        isUsable: () => frameUsable(requestFrame),
        every: (check) => {
          const timer = setInterval(check, 250);
          timer.unref();
          return timer;
        },
        clearEvery: (handle) => clearInterval(handle as NodeJS.Timeout)
      }, onGone);
    },
    watchOperationTimeout: (onTimeout) => {
      const timer = setTimeout(onTimeout, SCREEN_SHARE_NATIVE_OPERATION_TIMEOUT_MS);
      timer.unref();
      return () => clearTimeout(timer);
    },
    isFrameUsable: frameUsable,
    createToken: () => randomBytes(32).toString("base64url"),
    log: () => logger.write({ event: "security-event", code: "UNCLASSIFIED" })
  });
  installDisplayMediaRequestHandler({ session: civcomSession, environment, handle: (request, callback) => coordinator.handle(request, callback) });
  screenSharing = Object.freeze({ shutdown: () => { coordinator.shutdown(); pickerHost.shutdown(); } });
  return civcomSession;
}
function configureDownloads(contents: Electron.WebContents, logger: RotatingSafeLogger): void {
  contents.session.on("will-download", (_event, item) => {
    const urls = item.getURLChain();
    if (!authorizeDownloadRequest(contents.getURL(), urls, item.getFilename())) { item.cancel(); logger.write({ event: "download-denied", code: "UNCLASSIFIED" }); return; }
    item.pause();
    const pathApi = process.platform === "win32" ? win32 : posix;
    void reserveDownloadDestination(app.getPath("downloads"), item.getFilename(), (candidate) => {
      if (downloadReservations.has(candidate)) return false;
      try { const descriptor = openSync(candidate, "wx", 0o600); closeSync(descriptor); downloadReservations.add(candidate); return true; } catch { return false; }
    }, pathApi).then((destination) => {
      if (destination === undefined) { item.cancel(); logger.write({ event: "download-denied", code: "UNCLASSIFIED" }); return; }
      try {
        item.setSavePath(destination);
        let bucket = -1;
        item.on("updated", (_updateEvent, state) => { const total = item.getTotalBytes(); const next = total > 0 ? Math.min(10, Math.floor(item.getReceivedBytes() * 10 / total)) : 0; if (next !== bucket) { bucket = next; logger.lifecycle("download-progress", `${next}:${state}`); } });
        item.once("done", (_doneEvent, state) => { downloadReservations.delete(destination); if (state !== "completed") try { rmSync(destination); } catch { /* no reservation */ } logger.write({ event: "security-event", code: state === "completed" ? "UNCLASSIFIED" : "ERR_FAILED" }); });
        item.resume();
      } catch { downloadReservations.delete(destination); try { rmSync(destination); } catch { /* no reservation */ } item.cancel(); logger.write({ event: "download-denied", code: "UNCLASSIFIED" }); }
    }).catch(() => { item.cancel(); logger.write({ event: "download-denied", code: "UNCLASSIFIED" }); });
  });
}
function createWindow(startUrl: string, logger: RotatingSafeLogger, harness?: UnpackagedHarnessOptions): BrowserWindow {
  const bounds = new BoundsStore({ read: () => readOptional(boundsPath()), writeAtomic: (contents) => writeAtomic(boundsPath(), contents) });
  const displays = (): Electron.Rectangle[] => screen.getAllDisplays().map((display: Electron.Display) => display.workArea);
  const restored = bounds.load(displays());
  const window = new BrowserWindow({ title: "CivCom", show: false, icon: join(app.getAppPath(), "assets", "civcom.png"), ...(restored === undefined ? {} : restored), webPreferences: createWebPreferences(harness?.partition) });
  const offlineUrl = createOfflinePageUrl("embedded");
  const callbacks = createWindowCallbacks({ startUrl, offlineUrl, load: (url) => { void window.loadURL(url); }, show: showMainWindow, hide: () => window.hide(), log: (event) => logger.write(event) });
  const navigation = createNavigationCallbacks({ offlineUrl, load: (url) => { void window.loadURL(url); }, openExternal: shell.openExternal, log: (event) => logger.write(event) });
  const loadStart = (): void => { void window.loadURL(startUrl); };
  window.webContents.setWindowOpenHandler(({ url }) => navigation.windowOpen(url));
  const enforceNavigation = (event: Electron.Event, url: string): void => {
    if (url === OFFLINE_RETRY_URL) {
      event.preventDefault();
      callbacks.retry(url);
      return;
    }
    navigation.navigate(event, url);
  };
  window.webContents.on("will-navigate", enforceNavigation);
  window.webContents.on("will-redirect", enforceNavigation);
  window.webContents.on("did-fail-load", (_event, errorCode, _description, url, mainFrame) => callbacks.failedLoad(errorCode, mainFrame, url));
  window.webContents.on("did-navigate", (_event, url) => callbacks.retry(url));
  window.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => { if (isMainFrame) callbacks.retry(url); });
  window.webContents.on("page-title-updated", (event) => window.setTitle(callbacks.pageTitle(event)));
  window.on("close", (event) => {
    if (quitting) return;
    if (callbacks.close(event, trayAvailable) === "hide") { logger.lifecycle("hide"); return; }
    quitting = true; updater?.stop(); logger.lifecycle("stop"); app.quit();
  });
  window.on("close", () => bounds.save(window.getBounds(), displays()));
  configureDownloads(window.webContents, logger);
  window.once("ready-to-show", () => { logger.lifecycle("ready"); callbacks.ready(isHiddenStart(process.argv) || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin), trayAvailable); if (activationPending) { activationPending = false; showMainWindow(); } });
  if (harness?.deferInitialNavigation === true) void window.loadURL("about:blank");
  else loadStart();
  return window;
}
function createPackagedSmokeWindow(): BrowserWindow {
  const offlineUrl = createOfflinePageUrl("packaged-smoke");
  const window = new BrowserWindow({ title: "CivCom", show: false, width: 800, height: 600, webPreferences: createWebPreferences() });
  const timeout = setTimeout(() => app.exit(1), 20_000);
  window.webContents.once("did-fail-load", () => { clearTimeout(timeout); app.exit(1); });
  window.once("ready-to-show", () => {
    window.show();
    try {
      const result = createPackagedSmokeResult({ windowVisible: window.isVisible(), loadedUrl: window.webContents.getURL() });
      writeAtomic(packagedSmokeResultPath(app.getPath("userData")), `${JSON.stringify(result)}\n`);
    } catch {
      clearTimeout(timeout);
      app.exit(1);
      return;
    }
    clearTimeout(timeout);
    setTimeout(() => { window.destroy(); app.exit(0); }, 250);
  });
  void window.loadURL(offlineUrl);
  return window;
}
function currentPackageType(): PackageType {
  return detectPackageType({
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    ...(process.env.APPIMAGE === undefined ? {} : { appImagePath: process.env.APPIMAGE }),
    readMarker: readOptional,
    inspectAppImage: (path) => resolveRuntimeAppImage(path) === path
  });
}
async function configureUpdater(logger: RotatingSafeLogger, packageType: PackageType): Promise<UpdateController> {
  return await createUpdateController({
    packageType,
    loadUpdater: loadVerifiedUpdater,
    openManual: async () => {
      const response = await dialog.showMessageBox({ type: "info", buttons: ["Otwórz stronę wydań", "Anuluj"], defaultId: 1, cancelId: 1, title: "CivCom", message: "Ten pakiet jest aktualizowany ręcznie. Otworzyć najnowsze wydanie CivCom?" });
      if (response.response === 0) await shell.openExternal(LATEST_RELEASE_PAGE);
    },
    confirmRestart: async () => {
      const response = await dialog.showMessageBox({ type: "info", buttons: ["Uruchom ponownie", "Później"], defaultId: 1, cancelId: 1, title: "CivCom", message: "Aktualizacja jest gotowa. Uruchomić CivCom ponownie?" });
      return response.response === 0;
    },
    onError: () => logger.lifecycle("update-error", "ERR"),
    every: (callback, milliseconds) => setInterval(callback, milliseconds),
    clearEvery: (handle) => clearInterval(handle as NodeJS.Timeout),
    unref: (handle) => { (handle as NodeJS.Timeout).unref(); }
  });
}
if (process.platform === "win32") app.setAppUserModelId("info.soia.civcom.desktop");
if (!app.requestSingleInstanceLock()) app.quit(); else {
  installClientCertificateDenyHandler(app);
  app.on("second-instance", showMainWindow);
  app.on("activate", showMainWindow);
  app.on("certificate-error", (event, _contents, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
  app.on("before-quit", () => { quitting = true; screenSharing?.shutdown(); updater?.stop(); lifecycleLogger?.lifecycle("stop"); });
  void app.whenReady().then(async () => {
    if (isPackagedSmokeRequested({ isPackaged: app.isPackaged, argv: process.argv })) {
      mainWindow = createPackagedSmokeWindow();
      return;
    }
    const startUrl = resolvedStartUrl();
    if (startUrl === undefined) { app.quit(); return; }
    const harness = unpackagedHarnessOptions();
    const logger = createLogger();
    const packageType = currentPackageType();
    lifecycleLogger = logger;
    logger.lifecycle("startup"); logger.lifecycle("version", app.getVersion());
    configureSession(logger, harness); updater = await configureUpdater(logger, packageType);
    if (harness === undefined) { createMenu(); trayAvailable = createTray(logger); }
    else trayAvailable = false;
    mainWindow = createWindow(startUrl, logger, harness);
    if (harness === undefined) await promptForAutostart(packageType);
    await updater.start();
  });
}
