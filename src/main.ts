import { app, BrowserWindow, dialog, Menu, nativeImage, screen, session, shell, Tray, type MenuItemConstructorOptions } from "electron";
import electronUpdater from "electron-updater";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APPROVED_DOWNLOAD_PAGE, BoundsStore, createFirstRunState, createOfflinePageUrl, createPermissionGate, createRuntimeNavigationGate, createWebPreferences, isHiddenStart, makeLoginItemSettings, resolveDownloadDestination, UpdateScheduler } from "./desktop/shell.js";
import { RotatingSafeLogger } from "./desktop/safe-logger.js";
import { resolveStartUrl } from "./security/url-policy.js";

const { autoUpdater } = electronUpdater;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let updater: UpdateScheduler | undefined;

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
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
    const executable = process.execPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    writeAtomic(path, `[Desktop Entry]\nType=Application\nName=CivCom\nExec="${executable}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  const settings = makeLoginItemSettings(process.platform, enabled);
  app.setLoginItemSettings(settings.openAsHidden === undefined
    ? { openAtLogin: settings.openAtLogin, args: [...settings.args] }
    : { openAtLogin: settings.openAtLogin, openAsHidden: settings.openAsHidden, args: [...settings.args] });
}
async function promptForAutostart(): Promise<void> {
  const state = createFirstRunState(readPreferences());
  if (!state.promptAutostart) return;
  const response = await dialog.showMessageBox({ type: "question", buttons: ["Włącz", "Nie włączaj"], defaultId: 0, cancelId: 1, title: "CivCom", message: "Czy włączać automatyczne uruchamianie CivCom po zalogowaniu do systemu?" });
  const enabled = response.response === 0;
  applyLoginStartup(enabled);
  writePreferences(Object.freeze({ autostartPrompted: true, autostartEnabled: enabled }));
}
function showMainWindow(): void { if (mainWindow !== undefined && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } }
function quitApplication(): void { quitting = true; updater?.stop(); app.quit(); }
function createMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { label: "CivCom", submenu: [{ label: "Pokaż CivCom", click: showMainWindow }, { label: "Ukryj CivCom", click: () => mainWindow?.hide() }, { type: "separator" }, { label: "Sprawdź aktualizacje", click: () => { void updater?.manual(); } }, { type: "separator" }, { label: "Zakończ CivCom", click: quitApplication }] },
    { label: "Edycja", submenu: [{ role: "undo", label: "Cofnij" }, { role: "redo", label: "Ponów" }, { type: "separator" }, { role: "cut", label: "Wytnij" }, { role: "copy", label: "Kopiuj" }, { role: "paste", label: "Wklej" }, { role: "selectAll", label: "Zaznacz wszystko" }] },
    { label: "Okno", submenu: [{ role: "minimize", label: "Minimalizuj" }, { role: "close", label: "Zamknij" }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(), "assets", "civcom.svg")));
  tray.setToolTip("CivCom");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "Pokaż CivCom", click: showMainWindow }, { label: "Ukryj CivCom", click: () => mainWindow?.hide() }, { type: "separator" }, { label: "Sprawdź aktualizacje", click: () => { void updater?.manual(); } }, { type: "separator" }, { label: "Zakończ CivCom", click: quitApplication }]));
  tray.on("click", showMainWindow);
}
function mediaTypesFrom(details: unknown): unknown {
  if (details === null || typeof details !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(details, "mediaTypes");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}
function configureSession(): Electron.Session {
  const civcomSession = session.fromPartition("persist:civcom");
  const permission = createPermissionGate();
  civcomSession.setPermissionCheckHandler((_contents, name, origin, details) => permission({ origin, permission: name, mediaTypes: mediaTypesFrom(details) }));
  civcomSession.setPermissionRequestHandler((contents, name, callback, details) => callback(permission({ origin: contents.getURL(), permission: name, mediaTypes: mediaTypesFrom(details) })));
  civcomSession.setDevicePermissionHandler(() => false);
  // Task 4 installs setDisplayMediaRequestHandler; this shell never selects a capture source.
  return civcomSession;
}
function configureDownloads(contents: Electron.WebContents, logger: RotatingSafeLogger): void {
  contents.session.on("will-download", (_event, item) => {
    item.pause();
    void resolveDownloadDestination(app.getPath("downloads"), item.getFilename(), existsSync).then((destination) => {
      if (destination === undefined) { item.cancel(); logger.write({ event: "download-denied", code: "UNCLASSIFIED" }); return; }
      item.setSavePath(destination);
      let bucket = -1;
      item.on("updated", (_updateEvent, state) => { const total = item.getTotalBytes(); const next = total > 0 ? Math.min(10, Math.floor(item.getReceivedBytes() * 10 / total)) : 0; if (next !== bucket) { bucket = next; void state; } });
      item.once("done", (_doneEvent, state) => logger.write({ event: "security-event", code: state === "completed" ? "UNCLASSIFIED" : "ERR_FAILED" }));
      item.resume();
    }).catch(() => { item.cancel(); logger.write({ event: "download-denied", code: "UNCLASSIFIED" }); });
  });
}
function createWindow(startUrl: string, logger: RotatingSafeLogger): BrowserWindow {
  const bounds = new BoundsStore({ read: () => readOptional(boundsPath()), writeAtomic: (contents) => writeAtomic(boundsPath(), contents) });
  const displays = (): Electron.Rectangle[] => screen.getAllDisplays().map((display: Electron.Display) => display.workArea);
  const restored = bounds.load(displays());
  const window = new BrowserWindow({ title: "CivCom", show: false, icon: join(app.getAppPath(), "assets", "civcom.svg"), ...(restored === undefined ? {} : restored), webPreferences: createWebPreferences() });
  const offlineUrl = createOfflinePageUrl(join(app.getAppPath(), "dist", "offline.html"));
  const navigation = createRuntimeNavigationGate(offlineUrl);
  const loadStart = (): void => { void window.loadURL(startUrl); };
  window.webContents.setWindowOpenHandler(({ url }) => { if (navigation.windowOpen(url).action === "external") void shell.openExternal(url).catch(() => logger.write({ event: "navigation-denied", code: "UNCLASSIFIED" })); return { action: "deny" }; });
  const enforceNavigation = (event: Electron.Event, url: string): void => { if (!navigation.navigate(url).allow) { event.preventDefault(); logger.write({ event: "navigation-denied", code: "UNCLASSIFIED" }); } };
  window.webContents.on("will-navigate", enforceNavigation);
  window.webContents.on("will-redirect", enforceNavigation);
  window.webContents.on("did-fail-load", (_event, errorCode, _description, _url, mainFrame) => { if (mainFrame && errorCode !== -3) { logger.write({ event: "load-failed", code: "ERR_FAILED" }); void window.loadURL(offlineUrl); } });
  window.webContents.on("did-navigate-in-page", (_event, url) => { if (url === `${offlineUrl}#retry`) loadStart(); });
  window.on("close", (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.on("close", () => bounds.save(window.getBounds(), displays()));
  configureDownloads(window.webContents, logger);
  window.once("ready-to-show", () => { if (!isHiddenStart(process.argv)) showMainWindow(); });
  loadStart();
  return window;
}
function configureUpdater(logger: RotatingSafeLogger): UpdateScheduler {
  const isDeb = process.platform === "linux" && process.env.APPIMAGE === undefined;
  autoUpdater.on("error", () => logger.write({ event: "security-event", code: "UNCLASSIFIED" }));
  autoUpdater.on("update-downloaded", async () => { const response = await dialog.showMessageBox({ type: "info", buttons: ["Uruchom ponownie", "Później"], defaultId: 0, cancelId: 1, title: "CivCom", message: "Aktualizacja jest gotowa. Uruchomić CivCom ponownie?" }); if (response.response === 0) autoUpdater.quitAndInstall(); });
  return new UpdateScheduler({ isPackaged: app.isPackaged, platform: process.platform, isDeb, check: async () => { await autoUpdater.checkForUpdates(); }, openManual: () => { void shell.openExternal(APPROVED_DOWNLOAD_PAGE); }, every: (callback, milliseconds) => setInterval(callback, milliseconds), clearEvery: (handle) => clearInterval(handle as NodeJS.Timeout), unref: (handle) => { (handle as NodeJS.Timeout).unref(); } });
}
if (!app.requestSingleInstanceLock()) app.quit(); else {
  app.on("second-instance", showMainWindow);
  app.on("activate", showMainWindow);
  app.on("certificate-error", (event, _contents, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
  app.on("before-quit", () => { quitting = true; updater?.stop(); });
  void app.whenReady().then(async () => {
    const startUrl = resolvedStartUrl();
    if (startUrl === undefined) { app.quit(); return; }
    const logger = createLogger();
    configureSession(); createMenu(); updater = configureUpdater(logger); mainWindow = createWindow(startUrl, logger); createTray();
    await promptForAutostart();
    await updater.start();
  });
}
