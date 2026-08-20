import { describe, expect, it, vi } from "vitest";
import { posix, win32 } from "node:path";

const moduleUrl = new URL("../src/desktop/updater.ts", import.meta.url).href;

type UpdaterModule = Readonly<{
  LATEST_RELEASE_PAGE: string;
  PILOT_UPDATE_NOTICE: Readonly<{ title: string; message: string; detail: string }>;
  detectPackagedUpdatePolicy(input: Readonly<{
    isPackaged: boolean;
    appPath: string;
    readMetadata(path: string): string | undefined;
  }>): string;
  detectPackageType(input: Readonly<{
    isPackaged: boolean;
    platform: string;
    resourcesPath: string;
    appImagePath?: string;
    readMarker(path: string): string | undefined;
    inspectAppImage(path: string): boolean;
  }>): string;
  loadVerifiedUpdater?: (packageType: string, importer: (specifier: string) => Promise<Record<string, unknown>> | Record<string, unknown>) => Promise<unknown>;
  createUpdateController(input: Readonly<Record<string, unknown>>): Promise<Readonly<{ enabled: boolean; start(): Promise<void>; manual(): Promise<void>; stop(): void }>>;
}>;

async function loadModule(): Promise<UpdaterModule> {
  return await import(moduleUrl) as UpdaterModule;
}

function timers() {
  return {
    every: vi.fn((_callback: () => void, _milliseconds: number) => ({ timer: true })),
    clearEvery: vi.fn(),
    unref: vi.fn()
  };
}

function fakeUpdater(policyWrites: string[] = []) {
  const listeners = new Map<string, (...args: any[]) => unknown>();
  const target: Record<string, any> = {
    logger: console,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    disableWebInstaller: false,
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: any[]) => unknown) => { listeners.set(event, listener); }),
    listeners
  };
  return new Proxy(target, {
    set(object, property, value) {
      if (property === "channel") throw new Error("channel-must-not-be-set");
      if (["logger", "autoDownload", "autoInstallOnAppQuit", "allowPrerelease", "allowDowngrade", "disableWebInstaller"].includes(String(property))) policyWrites.push(String(property));
      return Reflect.set(object, property, value);
    }
  });
}

describe("packaged update policy", () => {
  it("provides the Polish manual notice used when pilot updates are disabled", async () => {
    const { PILOT_UPDATE_NOTICE } = await loadModule();
    expect(PILOT_UPDATE_NOTICE).toEqual({
      title: "CivCom — wersja pilotażowa",
      message: "Aktualizacje automatyczne są wyłączone w tej niepodpisanej wersji pilotażowej CivCom.",
      detail: "Nową wersję przekaże opiekun pilota."
    });
  });

  it("recognises only exact ASAR package metadata and otherwise disables updates", async () => {
    const { detectPackagedUpdatePolicy } = await loadModule();
    const pathApi = process.platform === "win32" ? win32 : posix;
    const appPath = process.platform === "win32"
      ? "C:\\Program Files\\CivCom\\resources\\app.asar"
      : "/opt/CivCom/resources/app.asar";
    const metadataPath = pathApi.join(appPath, "package.json");
    const detect = (metadata: unknown, isPackaged = true) => detectPackagedUpdatePolicy({
      isPackaged,
      appPath,
      readMetadata: (path) => path === metadataPath ? JSON.stringify(metadata) : undefined
    });
    expect(detect({ civcomUpdatePolicy: "pilot-disabled-v1" })).toBe("pilot");
    expect(detect({ civcomUpdatePolicy: "production-enabled-v1" })).toBe("production");
    for (const metadata of [
      {},
      { civcomUpdatePolicy: "pilot" },
      { civcomUpdatePolicy: "production" },
      { civcomUpdatePolicy: "production-enabled-v1\npilot-disabled-v1" },
      null,
      []
    ]) expect(detect(metadata)).toBe("disabled");
    expect(detect({ civcomUpdatePolicy: "production-enabled-v1" }, false)).toBe("disabled");
    expect(detectPackagedUpdatePolicy({ isPackaged: true, appPath: "relative.asar", readMetadata: vi.fn() })).toBe("disabled");
    expect(detectPackagedUpdatePolicy({ isPackaged: true, appPath: "/opt/app.asar", readMetadata: () => "{" })).toBe("disabled");
  });

  it("instantiates AppImageUpdater for a verified AppImage runtime even though the packaged marker is deb", async () => {
    const { detectPackageType, loadVerifiedUpdater } = await loadModule();
    expect(loadVerifiedUpdater).toBeTypeOf("function");
    if (typeof loadVerifiedUpdater !== "function") return;
    const constructed: string[] = [];
    class AppImageUpdater { public constructor() { constructed.push("appimage"); } }
    const packageType = detectPackageType({
      isPackaged: true,
      platform: "linux",
      resourcesPath: "/tmp/.mount_CivCom/resources",
      appImagePath: "/home/user/CivCom.AppImage",
      readMarker: () => "deb\n",
      inspectAppImage: () => true
    });
    const importer = vi.fn(async (specifier: string) => {
      if (/DebUpdater|dpkg|apt/i.test(specifier)) throw new Error("Deb updater implementation must never be imported");
      if (specifier !== "electron-updater/out/AppImageUpdater.js") throw new Error(`unexpected updater import: ${specifier}`);
      return { AppImageUpdater };
    });
    const updater = await loadVerifiedUpdater(packageType, importer);
    expect(updater).toBeInstanceOf(AppImageUpdater);
    expect(constructed).toEqual(["appimage"]);
    expect(importer).toHaveBeenCalledExactlyOnceWith("electron-updater/out/AppImageUpdater.js");
  });

  it("does not import any updater implementation for deb, unknown, or development packages", async () => {
    const { loadVerifiedUpdater } = await loadModule();
    expect(loadVerifiedUpdater).toBeTypeOf("function");
    if (typeof loadVerifiedUpdater !== "function") return;
    for (const packageType of ["deb", "unknown", "development"]) {
      const importer = vi.fn((_specifier: string) => { throw new Error("updater module must not be imported"); });
      await expect(loadVerifiedUpdater(packageType, importer)).rejects.toThrow();
      expect(importer).not.toHaveBeenCalled();
    }
  });

  it("detects exact resources/package-type markers and only a validated AppImage path fallback", async () => {
    const { detectPackageType } = await loadModule();
    const detect = (platform: string, marker: string | undefined, appImagePath?: string, valid = true) => detectPackageType({
      isPackaged: true,
      platform,
      resourcesPath: platform === "win32" ? "C:\\Program Files\\CivCom\\resources" : "/opt/CivCom/resources",
      ...(appImagePath === undefined ? {} : { appImagePath }),
      readMarker: (path) => path === (platform === "win32" ? "C:\\Program Files\\CivCom\\resources\\package-type" : "/opt/CivCom/resources/package-type") ? marker : undefined,
      inspectAppImage: () => valid
    });
    expect(detect("win32", "windows\n")).toBe("windows");
    expect(detect("darwin", "macos\n")).toBe("macos");
    expect(detect("linux", "deb")).toBe("deb");
    expect(detect("linux", "deb", "/tmp/CivCom.AppImage")).toBe("appimage");
    expect(detect("linux", "deb", "relative.AppImage")).toBe("unknown");
    expect(detect("linux", "deb", "/tmp/CivCom.AppImage", false)).toBe("deb");
    for (const [platform, marker] of [["linux", undefined], ["linux", "appimage\n"], ["linux", "deb\n"], ["linux", "deb\nextra"], ["win32", "macos\n"], ["darwin", "windows\n"], ["freebsd", "deb"]] as const) expect(detect(platform, marker)).toBe("unknown");
    expect(detectPackageType({ isPackaged: false, platform: "linux", resourcesPath: "/x", readMarker: vi.fn(), inspectAppImage: vi.fn() })).toBe("development");

    const windowsMarker = vi.fn((path: string) => path === "D:\\Program Files\\CivCom\\resources\\package-type" ? "windows\n" : undefined);
    expect(detectPackageType({
      isPackaged: true,
      platform: "win32",
      resourcesPath: "D:\\Program Files\\CivCom\\resources",
      readMarker: windowsMarker,
      inspectAppImage: vi.fn()
    })).toBe("windows");
    expect(windowsMarker).toHaveBeenCalledExactlyOnceWith("D:\\Program Files\\CivCom\\resources\\package-type");
  });

  it("keeps DEB and unknown Linux packages completely outside electron-updater", async () => {
    const { createUpdateController, LATEST_RELEASE_PAGE } = await loadModule();
    expect(LATEST_RELEASE_PAGE).toBe("https://github.com/KGPSP/civcom-desktop/releases/latest");
    for (const packageType of ["deb", "unknown"] ) {
      const loadUpdater = vi.fn(() => { throw new Error("must-not-import-electron-updater"); });
      const openManual = vi.fn().mockResolvedValue(undefined);
      const clock = timers();
      const controller = await createUpdateController({ updatePolicy: "production", packageType, loadUpdater, openManual, onError: vi.fn(), ...clock });
      await expect(controller.start()).resolves.toBeUndefined();
      await expect(controller.manual()).resolves.toBeUndefined();
      controller.stop();
      expect(loadUpdater).not.toHaveBeenCalled();
      expect(clock.every).not.toHaveBeenCalled();
      expect(openManual).toHaveBeenCalledOnce();
    }
  });

  it("keeps every pilot package outside electron-updater and shows only the pilot notice manually", async () => {
    const { createUpdateController } = await loadModule();
    for (const packageType of ["windows", "macos", "appimage", "deb"] as const) {
      const loadUpdater = vi.fn(() => { throw new Error("pilot-must-not-import-electron-updater"); });
      const openManual = vi.fn(() => { throw new Error("pilot-must-not-open-release-page"); });
      const showPilotNotice = vi.fn().mockResolvedValue(undefined);
      const clock = timers();
      const controller = await createUpdateController({ updatePolicy: "pilot", packageType, loadUpdater, openManual, showPilotNotice, onError: vi.fn(), ...clock });
      expect(controller.enabled).toBe(true);
      await expect(controller.start()).resolves.toBeUndefined();
      await expect(controller.manual()).resolves.toBeUndefined();
      controller.stop();
      expect(loadUpdater).not.toHaveBeenCalled();
      expect(openManual).not.toHaveBeenCalled();
      expect(showPilotNotice).toHaveBeenCalledOnce();
      expect(clock.every).not.toHaveBeenCalled();
      expect(clock.clearEvery).not.toHaveBeenCalled();
    }
  });

  it("fails closed without an exact production or pilot policy", async () => {
    const { createUpdateController } = await loadModule();
    for (const updatePolicy of [undefined, "disabled", "hostile"] ) {
      const loadUpdater = vi.fn(() => { throw new Error("unknown-policy-must-not-import"); });
      const openManual = vi.fn();
      const showPilotNotice = vi.fn();
      const clock = timers();
      const controller = await createUpdateController({ updatePolicy, packageType: "windows", loadUpdater, openManual, showPilotNotice, onError: vi.fn(), ...clock });
      expect(controller.enabled).toBe(false);
      await controller.start();
      await controller.manual();
      expect(loadUpdater).not.toHaveBeenCalled();
      expect(openManual).not.toHaveBeenCalled();
      expect(showPilotNotice).not.toHaveBeenCalled();
      expect(clock.every).not.toHaveBeenCalled();
    }
  });

  it("sets safe updater flags, checks at startup and six-hour intervals, and prevents overlap", async () => {
    const { createUpdateController } = await loadModule();
    const policyWrites: string[] = [];
    const updater = fakeUpdater(policyWrites);
    let resolveCheck: (() => void) | undefined;
    updater.checkForUpdates = vi.fn(() => new Promise<void>((resolve) => { resolveCheck = resolve; }));
    const clock = timers();
    const controller = await createUpdateController({ updatePolicy: "production", packageType: "macos", loadUpdater: vi.fn().mockResolvedValue(updater), openManual: vi.fn(), onError: vi.fn(), confirmRestart: vi.fn(), ...clock });
    expect(policyWrites).toEqual(["logger", "autoDownload", "autoInstallOnAppQuit", "allowPrerelease", "allowDowngrade", "disableWebInstaller"]);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.disableWebInstaller).toBe(true);
    expect(updater.logger).toBeNull();
    expect("channel" in updater).toBe(false);
    const starting = controller.start();
    await Promise.resolve();
    const concurrent = controller.manual();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    resolveCheck?.();
    await Promise.all([starting, concurrent]);
    expect(clock.every).toHaveBeenCalledWith(expect.any(Function), 6 * 60 * 60 * 1000);
    expect(clock.unref).toHaveBeenCalledOnce();
    controller.stop();
    expect(clock.clearEvery).toHaveBeenCalledOnce();
  });

  it("installs only after the explicit Polish restart confirmation and never on ordinary quit", async () => {
    const { createUpdateController } = await loadModule();
    for (const confirmed of [false, true]) {
      const updater = fakeUpdater();
      const confirmRestart = vi.fn().mockResolvedValue(confirmed);
      const controller = await createUpdateController({ updatePolicy: "production", packageType: "windows", loadUpdater: vi.fn().mockResolvedValue(updater), openManual: vi.fn(), onError: vi.fn(), confirmRestart, ...timers() });
      const downloaded = updater.listeners.get("update-downloaded");
      expect(downloaded).toBeTypeOf("function");
      await downloaded?.();
      expect(confirmRestart).toHaveBeenCalledOnce();
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      controller.stop();
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    }
  });

  it("contains hostile adapters and failed dynamic imports without throwing or installing", async () => {
    const { createUpdateController } = await loadModule();
    const onError = vi.fn(() => { throw new Error("hostile-error-reporter"); });
    const controller = await createUpdateController({
      updatePolicy: "production",
      packageType: "appimage",
      loadUpdater: vi.fn().mockRejectedValue(new Error("load failed")),
      openManual: vi.fn(() => { throw new Error("open failed"); }),
      onError,
      every: vi.fn(() => { throw new Error("timer failed"); }),
      clearEvery: vi.fn(() => { throw new Error("clear failed"); }),
      unref: vi.fn(() => { throw new Error("unref failed"); }),
      confirmRestart: vi.fn(() => { throw new Error("prompt failed"); })
    });
    await expect(controller.start()).resolves.toBeUndefined();
    await expect(controller.manual()).resolves.toBeUndefined();
    expect(() => controller.stop()).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});
