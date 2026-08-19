import { app, BrowserWindow, dialog, Menu, nativeImage, screen, session, shell, Tray, type MenuItemConstructorOptions } from "electron";
import electronUpdater from "electron-updater";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, posix, win32 } from "node:path";
import { APPROVED_DOWNLOAD_PAGE, BoundsStore, createFirstRunState, createOfflinePageUrl, createWebPreferences, isHiddenStart, makeLoginItemSettings, reserveDownloadDestination, UpdateScheduler } from "./desktop/shell.js";
import { RotatingSafeLogger } from "./desktop/safe-logger.js";
import { resolveStartUrl } from "./security/url-policy.js";
import { authorizeDownloadRequest, createNavigationCallbacks, createPermissionCallbacks, createTraySafely, createWindowCallbacks } from "./desktop/electron-adapters.js";

const { autoUpdater } = electronUpdater;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let updater: UpdateScheduler | undefined;
let activationPending = false;
let trayAvailable = false;
const downloadReservations = new Set<string>();
let lifecycleLogger: RotatingSafeLogger | undefined;

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
function applyLoginStartup(enabled: boolean): void {
  if (process.platform === "linux") {
    const xdgConfig = process.env.XDG_CONFIG_HOME;
    const path = join(xdgConfig !== undefined && xdgConfig.startsWith("/") ? xdgConfig : join(app.getPath("home"), ".config"), "autostart", "civcom.desktop");
    if (!enabled) { try { rmSync(path); } catch { /* already disabled */ } return; }
    const executable = process.execPath.replaceAll("%", "%%").replaceAll("$", "\\$").replaceAll("`", "\\`").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    writeAtomic(path, `[Desktop Entry]\nType=Application\nName=CivCom\nExec="${executable}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  const settings = makeLoginItemSettings(process.platform, enabled, process.execPath);
  app.setLoginItemSettings("type" in settings
    ? { openAtLogin: settings.openAtLogin, type: settings.type }
    : { openAtLogin: settings.openAtLogin, path: settings.path, args: [...settings.args] });
}
async function promptForAutostart(): Promise<void> {
  if (!app.isPackaged) return;
  const state = createFirstRunState(readPreferences());
  if (!state.promptAutostart) return;
  const response = await dialog.showMessageBox({ type: "question", buttons: ["Włącz", "Nie włączaj"], defaultId: 0, cancelId: 1, title: "CivCom", message: "Czy włączać automatyczne uruchamianie CivCom po zalogowaniu do systemu?" });
  const enabled = response.response === 0;
  applyLoginStartup(enabled);
  writePreferences(Object.freeze({ autostartPrompted: true, autostartEnabled: enabled }));
}
function showMainWindow(): void { if (mainWindow === undefined || mainWindow.isDestroyed()) { activationPending = true; return; } mainWindow.show(); mainWindow.focus(); }
function quitApplication(): void { quitting = true; updater?.stop(); lifecycleLogger?.lifecycle("stop"); app.quit(); }
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
function configureSession(): Electron.Session {
  const civcomSession = session.fromPartition("persist:civcom");
  const permission = createPermissionCallbacks();
  civcomSession.setPermissionCheckHandler((_contents, name, _origin, details) => permission.check(name, details));
  civcomSession.setPermissionRequestHandler((_contents, name, callback, details) => callback(permission.request(name, details)));
  civcomSession.setDevicePermissionHandler(() => false);
  // Task 4 installs setDisplayMediaRequestHandler; this shell never selects a capture source.
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
function createWindow(startUrl: string, logger: RotatingSafeLogger): BrowserWindow {
  const bounds = new BoundsStore({ read: () => readOptional(boundsPath()), writeAtomic: (contents) => writeAtomic(boundsPath(), contents) });
  const displays = (): Electron.Rectangle[] => screen.getAllDisplays().map((display: Electron.Display) => display.workArea);
  const restored = bounds.load(displays());
  const window = new BrowserWindow({ title: "CivCom", show: false, icon: join(app.getAppPath(), "assets", "civcom.svg"), ...(restored === undefined ? {} : restored), webPreferences: createWebPreferences() });
  const offlineUrl = createOfflinePageUrl(join(app.getAppPath(), "dist", "offline.html"));
  const callbacks = createWindowCallbacks({ startUrl, offlineUrl, load: (url) => { void window.loadURL(url); }, show: showMainWindow, hide: () => window.hide(), log: (event) => logger.write(event) });
  const navigation = createNavigationCallbacks({ offlineUrl, load: (url) => { void window.loadURL(url); }, openExternal: shell.openExternal, log: (event) => logger.write(event) });
  const loadStart = (): void => { void window.loadURL(startUrl); };
  window.webContents.setWindowOpenHandler(({ url }) => navigation.windowOpen(url));
  const enforceNavigation = (event: Electron.Event, url: string): void => navigation.navigate(event, url);
  window.webContents.on("will-navigate", enforceNavigation);
  window.webContents.on("will-redirect", enforceNavigation);
  window.webContents.on("did-fail-load", (_event, errorCode, _description, url, mainFrame) => callbacks.failedLoad(errorCode, mainFrame, url));
  window.webContents.on("did-navigate-in-page", (_event, url) => callbacks.retry(url));
  window.webContents.on("page-title-updated", (event) => window.setTitle(callbacks.pageTitle(event)));
  window.on("close", (event) => {
    if (quitting) return;
    if (callbacks.close(event, trayAvailable) === "hide") { logger.lifecycle("hide"); return; }
    quitting = true; updater?.stop(); logger.lifecycle("stop"); app.quit();
  });
  window.on("close", () => bounds.save(window.getBounds(), displays()));
  configureDownloads(window.webContents, logger);
  window.once("ready-to-show", () => { logger.lifecycle("ready"); callbacks.ready(isHiddenStart(process.argv) || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin), trayAvailable); if (activationPending) { activationPending = false; showMainWindow(); } });
  loadStart();
  return window;
}
function configureUpdater(logger: RotatingSafeLogger): UpdateScheduler {
  const isDeb = process.platform === "linux" && process.env.APPIMAGE === undefined;
  autoUpdater.on("error", () => logger.write({ event: "security-event", code: "UNCLASSIFIED" }));
  autoUpdater.on("update-downloaded", async () => { const response = await dialog.showMessageBox({ type: "info", buttons: ["Uruchom ponownie", "Później"], defaultId: 0, cancelId: 1, title: "CivCom", message: "Aktualizacja jest gotowa. Uruchomić CivCom ponownie?" }); if (response.response === 0) autoUpdater.quitAndInstall(); });
  return new UpdateScheduler({ isPackaged: app.isPackaged, platform: process.platform, isDeb, check: async () => { await autoUpdater.checkForUpdates(); }, openManual: () => shell.openExternal(APPROVED_DOWNLOAD_PAGE), onError: () => logger.lifecycle("update-error", "ERR"), every: (callback, milliseconds) => setInterval(callback, milliseconds), clearEvery: (handle) => clearInterval(handle as NodeJS.Timeout), unref: (handle) => { (handle as NodeJS.Timeout).unref(); } });
}
if (!app.requestSingleInstanceLock()) app.quit(); else {
  app.on("second-instance", showMainWindow);
  app.on("activate", showMainWindow);
  app.on("certificate-error", (event, _contents, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
  app.on("before-quit", () => { quitting = true; updater?.stop(); lifecycleLogger?.lifecycle("stop"); });
  void app.whenReady().then(async () => {
    const startUrl = resolvedStartUrl();
    if (startUrl === undefined) { app.quit(); return; }
    const logger = createLogger();
    lifecycleLogger = logger;
    logger.lifecycle("startup"); logger.lifecycle("version", app.getVersion());
    configureSession(); createMenu(); updater = configureUpdater(logger); trayAvailable = createTray(logger); mainWindow = createWindow(startUrl, logger);
    await promptForAutostart();
    await updater.start();
  });
}
