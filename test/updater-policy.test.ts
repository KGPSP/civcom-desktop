import { describe, expect, it, vi } from "vitest";

const moduleUrl = new URL("../src/desktop/updater.ts", import.meta.url).href;

type UpdaterModule = Readonly<{
  LATEST_RELEASE_PAGE: string;
  detectPackageType(input: Readonly<{
    isPackaged: boolean;
    platform: string;
    resourcesPath: string;
    appImagePath?: string;
    readMarker(path: string): string | undefined;
    inspectAppImage(path: string): boolean;
  }>): string;
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

function fakeUpdater() {
  const listeners = new Map<string, (...args: any[]) => unknown>();
  const target: Record<string, any> = {
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
      return Reflect.set(object, property, value);
    }
  });
}

describe("packaged update policy", () => {
  it("detects exact resources/package-type markers and only a validated AppImage path fallback", async () => {
    const { detectPackageType } = await loadModule();
    const detect = (platform: string, marker: string | undefined, appImagePath?: string, valid = true) => detectPackageType({
      isPackaged: true,
      platform,
      resourcesPath: "/opt/CivCom/resources",
      ...(appImagePath === undefined ? {} : { appImagePath }),
      readMarker: (path) => path === "/opt/CivCom/resources/package-type" ? marker : undefined,
      inspectAppImage: () => valid
    });
    expect(detect("win32", "windows\n")).toBe("windows");
    expect(detect("darwin", "macos\n")).toBe("macos");
    expect(detect("linux", "deb\n")).toBe("deb");
    expect(detect("linux", "deb\n", "/tmp/CivCom.AppImage")).toBe("appimage");
    expect(detect("linux", "deb\n", "relative.AppImage")).toBe("unknown");
    expect(detect("linux", "deb\n", "/tmp/CivCom.AppImage", false)).toBe("deb");
    for (const [platform, marker] of [["linux", undefined], ["linux", "appimage\n"], ["linux", "deb\nextra"], ["win32", "macos\n"], ["darwin", "windows\n"], ["freebsd", "deb\n"]] as const) expect(detect(platform, marker)).toBe("unknown");
    expect(detectPackageType({ isPackaged: false, platform: "linux", resourcesPath: "/x", readMarker: vi.fn(), inspectAppImage: vi.fn() })).toBe("development");
  });

  it("keeps DEB and unknown Linux packages completely outside electron-updater", async () => {
    const { createUpdateController, LATEST_RELEASE_PAGE } = await loadModule();
    expect(LATEST_RELEASE_PAGE).toBe("https://github.com/KGPSP/civcom-desktop/releases/latest");
    for (const packageType of ["deb", "unknown"] ) {
      const loadUpdater = vi.fn(() => { throw new Error("must-not-import-electron-updater"); });
      const openManual = vi.fn().mockResolvedValue(undefined);
      const clock = timers();
      const controller = await createUpdateController({ packageType, loadUpdater, openManual, onError: vi.fn(), ...clock });
      await expect(controller.start()).resolves.toBeUndefined();
      await expect(controller.manual()).resolves.toBeUndefined();
      controller.stop();
      expect(loadUpdater).not.toHaveBeenCalled();
      expect(clock.every).not.toHaveBeenCalled();
      expect(openManual).toHaveBeenCalledOnce();
    }
  });

  it("sets safe updater flags, checks at startup and six-hour intervals, and prevents overlap", async () => {
    const { createUpdateController } = await loadModule();
    const updater = fakeUpdater();
    let resolveCheck: (() => void) | undefined;
    updater.checkForUpdates = vi.fn(() => new Promise<void>((resolve) => { resolveCheck = resolve; }));
    const clock = timers();
    const controller = await createUpdateController({ packageType: "macos", loadUpdater: vi.fn().mockResolvedValue(updater), openManual: vi.fn(), onError: vi.fn(), confirmRestart: vi.fn(), ...clock });
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.disableWebInstaller).toBe(true);
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
      const controller = await createUpdateController({ packageType: "windows", loadUpdater: vi.fn().mockResolvedValue(updater), openManual: vi.fn(), onError: vi.fn(), confirmRestart, ...timers() });
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
