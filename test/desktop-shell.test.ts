import { describe, expect, it, vi } from "vitest";
import { PRODUCTION_CIVCOM_URL } from "../src/security/url-policy.js";
import {
  APP_START_HIDDEN_ARG,
  BoundsStore,
  createFirstRunState,
  createOfflinePageUrl,
  createPermissionGate,
  createRuntimeNavigationGate,
  createWebPreferences,
  isHiddenStart,
  makeLoginItemSettings,
  resolveDownloadDestination,
  sanitizeDownloadBasename,
  UpdateScheduler,
  type BoundsFile,
  type DisplayArea
} from "../src/desktop/shell.js";
import { RotatingSafeLogger } from "../src/desktop/safe-logger.js";

describe("desktop shell policy", () => {
  it("uses an isolated persistent web renderer with no preload or custom user agent", () => {
    const preferences = createWebPreferences();
    expect(preferences).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
      partition: "persist:civcom"
    });
    expect("preload" in preferences).toBe(false);
    expect("userAgent" in preferences).toBe(false);
  });

  it("only permits CivCom/Auth navigation and safe external window targets", () => {
    const gate = createRuntimeNavigationGate("file:///opt/CivCom/offline.html");
    expect(gate.navigate("https://civcom.soia.info/#/room/a")).toEqual({ allow: true });
    expect(gate.navigate("https://auth.soia.info/login")).toEqual({ allow: true });
    expect(gate.navigate("https://matrix.soia.info/")).toEqual({ allow: false });
    expect(gate.navigate("file:///tmp/a")).toEqual({ allow: false });
    expect(gate.navigate("file:///opt/CivCom/offline.html")).toEqual({ allow: true });
    expect(gate.windowOpen("https://example.org/path")).toEqual({ action: "external" });
    expect(gate.windowOpen("mailto:help@example.org")).toEqual({ action: "external" });
    expect(gate.windowOpen("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(gate.windowOpen("matrix:u/alice")).toEqual({ action: "deny" });
  });

  it("fails closed for permissions and allows media only for microphone/camera", () => {
    const gate = createPermissionGate();
    expect(gate({ origin: "https://civcom.soia.info/", permission: "notifications" })).toBe(true);
    expect(gate({ origin: "https://civcom.soia.info/", permission: "media", mediaTypes: ["audio", "video"] })).toBe(true);
    expect(gate({ origin: "https://civcom.soia.info/", permission: "media", mediaTypes: ["display"] })).toBe(false);
    expect(gate({ origin: "https://auth.soia.info/", permission: "media", mediaTypes: ["audio"] })).toBe(false);
    expect(gate({ origin: "https://matrix.soia.info/", permission: "notifications" })).toBe(false);
    expect(gate({ origin: "https://civcom.soia.info/", permission: "usb" })).toBe(false);
  });

  it("recognizes only the explicit hidden-start argument", () => {
    expect(APP_START_HIDDEN_ARG).toBe("--hidden");
    expect(isHiddenStart(["CivCom", "--hidden"])).toBe(true);
    expect(isHiddenStart(["CivCom", "--hidden=true"])).toBe(false);
  });

  it("prompts for autostart only once and has reversible platform settings", () => {
    expect(createFirstRunState(undefined)).toEqual({ promptAutostart: true, preferences: { autostartPrompted: true } });
    expect(createFirstRunState({ autostartPrompted: true, autostartEnabled: true })).toEqual({
      promptAutostart: false,
      preferences: { autostartPrompted: true, autostartEnabled: true }
    });
    expect(makeLoginItemSettings("darwin", true)).toEqual({ openAtLogin: true, openAsHidden: true, args: ["--hidden"] });
    expect(makeLoginItemSettings("win32", false)).toEqual({ openAtLogin: false, args: ["--hidden"] });
  });

  it("accepts only sensible on-screen persisted bounds and writes atomically", () => {
    const area: DisplayArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const storage = new Map<string, string>();
    const writes: string[] = [];
    const store = new BoundsStore({
      read: () => storage.get("bounds"),
      writeAtomic: (value) => writes.push(value)
    });
    expect(store.load([area])).toBeUndefined();
    const valid: BoundsFile = { x: 20, y: 20, width: 1100, height: 800 };
    storage.set("bounds", JSON.stringify(valid));
    expect(store.load([area])).toEqual(valid);
    storage.set("bounds", JSON.stringify({ x: 99999, y: 1, width: 100, height: 100 }));
    expect(store.load([area])).toBeUndefined();
    store.save(valid, [area]);
    expect(writes).toEqual([JSON.stringify(valid)]);
    expect(writes[0]).not.toContain("url");
  });

  it("uses a local offline page and retries only the fixed resolved start URL", () => {
    expect(createOfflinePageUrl("/Application/CivCom/offline.html")).toBe("file:///Application/CivCom/offline.html");
    expect(PRODUCTION_CIVCOM_URL).toBe("https://civcom.soia.info/");
  });

  it("rejects unsafe downloads and allocates collision-safe filenames without opening them", async () => {
    expect(sanitizeDownloadBasename("raport.pdf")).toBe("raport.pdf");
    expect(sanitizeDownloadBasename("../raport.pdf")).toBeUndefined();
    expect(sanitizeDownloadBasename("folder/raport.pdf")).toBeUndefined();
    expect(sanitizeDownloadBasename(" ")).toBeUndefined();
    expect(sanitizeDownloadBasename("CON")).toBeUndefined();
    const existing = new Set(["/Downloads/raport.pdf", "/Downloads/raport (1).pdf"]);
    await expect(resolveDownloadDestination("/Downloads", "raport.pdf", (path) => existing.has(path))).resolves.toBe("/Downloads/raport (2).pdf");
  });
});

describe("safe local logging", () => {
  it("writes only allowlisted structure, rotates, and never persists sensitive content", () => {
    const files = new Map<string, string>([["civcom.log", "x".repeat(20)]]);
    const logger = new RotatingSafeLogger({
      maxBytes: 20,
      maxFiles: 2,
      now: () => new Date("2026-08-19T12:00:00.000Z"),
      read: (name) => files.get(name),
      write: (name, value) => files.set(name, value),
      remove: (name) => files.delete(name)
    });
    logger.write({ event: "load-failed", code: "ERR_FAILED", url: "https://civcom.soia.info/room/secret?token=abc" });
    expect(files.get("civcom.1.log")).toContain("x");
    const output = files.get("civcom.log") ?? "";
    expect(output).toContain('"event":"load-failed"');
    expect(output).not.toContain("secret");
    expect(output).not.toContain("token");
    expect(output).not.toContain("abc");
  });
});

describe("update scheduler", () => {
  it("checks packaged apps on start, every six hours, serializes calls, and never runs in dev", async () => {
    const intervals: Array<() => void> = [];
    let checks = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new UpdateScheduler({
      isPackaged: true,
      platform: "darwin",
      check: async () => { checks += 1; await pending; },
      every: (callback, ms) => { expect(ms).toBe(6 * 60 * 60 * 1000); intervals.push(callback); return 9; },
      clearEvery: vi.fn(),
      unref: vi.fn()
    });
    const first = scheduler.start();
    await Promise.resolve();
    intervals[0]?.();
    expect(checks).toBe(1);
    release();
    await first;
    await scheduler.manual();
    expect(checks).toBe(2);
    scheduler.stop();

    const dev = new UpdateScheduler({ isPackaged: false, platform: "darwin", check: vi.fn(), every: vi.fn(), clearEvery: vi.fn(), unref: vi.fn() });
    await dev.start();
    expect(dev.enabled).toBe(false);
  });

  it("uses a manual approved path for DEB instead of downloading an update", async () => {
    const openManual = vi.fn();
    const scheduler = new UpdateScheduler({ isPackaged: true, platform: "linux", isDeb: true, check: vi.fn(), openManual, every: vi.fn(), clearEvery: vi.fn(), unref: vi.fn() });
    await scheduler.manual();
    expect(openManual).toHaveBeenCalledOnce();
  });
});
