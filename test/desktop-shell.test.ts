import { describe, expect, it } from "vitest";
import { PRODUCTION_CIVCOM_URL } from "../src/security/url-policy.js";
import {
  APP_START_HIDDEN_ARG,
  BoundsStore,
  normalizeBounds,
  createFirstRunState,
  createOfflinePageUrl,
  createPermissionGate,
  createRuntimeNavigationGate,
  createWebPreferences,
  isHiddenStart,
  makeLoginItemSettings,
  resolveLinuxAutostartExecutable,
  escapeDesktopExecPath,
  resolveDownloadDestination,
  resolveUnpackagedHarnessOptions,
  sanitizeDownloadBasename,
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

  it("reuses the exact secure preference factory for a bounded memory-only test partition", () => {
    const preferences = createWebPreferences("civcom-anonymous-000102030405060708090a0b0c0d0e0f");
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
      partition: "civcom-anonymous-000102030405060708090a0b0c0d0e0f"
    });
    expect("preload" in preferences).toBe(false);
    expect(() => createWebPreferences("persist:anonymous")).toThrowError("invalid-renderer-partition");
    expect(() => createWebPreferences("civcom-anonymous-short")).toThrowError("invalid-renderer-partition");
  });

  it("enables the local wiring seam only for the exact unpackaged marker and memory partition", () => {
    const partition = "civcom-local-000102030405060708090a0b0c0d0e0f";
    expect(resolveUnpackagedHarnessOptions({ isPackaged: false, marker: "local-v1", partition })).toEqual({ partition, deferInitialNavigation: true });
    for (const input of [
      { isPackaged: true, marker: "local-v1", partition },
      { isPackaged: false, marker: "local", partition },
      { isPackaged: false, marker: "local-v1", partition: "persist:civcom" },
      { isPackaged: false, marker: "local-v1", partition: "civcom-anonymous-000102030405060708090a0b0c0d0e0f" },
      new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } })
    ]) expect(resolveUnpackagedHarnessOptions(input)).toBeUndefined();
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
    expect(makeLoginItemSettings("darwin", true)).toEqual({ openAtLogin: true, type: "mainAppService" });
    expect(makeLoginItemSettings("win32", false, "C:\\CivCom.exe")).toEqual({ openAtLogin: false, path: "C:\\CivCom.exe", args: ["--hidden"] });
  });

  it("builds a quoted XDG Exec path without shell interpolation", () => {
    expect(escapeDesktopExecPath('/opt/Civ Com/$cash`tick\\quote"100%')).toBe('/opt/Civ Com/\\$cash\\`tick\\\\quote\\"100%%');
  });

  it("uses the verified persistent APPIMAGE path for Linux autostart and never the ephemeral mount", () => {
    const verified = (path: string): string | undefined => path === "/home/user/CivCom.AppImage" ? path : undefined;
    expect(resolveLinuxAutostartExecutable({ packageType: "appimage", executable: "/tmp/.mount_CivCom/civcom", appImagePath: "/home/user/CivCom.AppImage", resolveAppImage: verified })).toBe("/home/user/CivCom.AppImage");
    expect(resolveLinuxAutostartExecutable({ packageType: "deb", executable: "/opt/CivCom/civcom", appImagePath: "/home/user/CivCom.AppImage", resolveAppImage: verified })).toBe("/opt/CivCom/civcom");
    expect(resolveLinuxAutostartExecutable({ packageType: "appimage", executable: "/tmp/.mount_CivCom/civcom", appImagePath: "relative.AppImage", resolveAppImage: verified })).toBeUndefined();
    expect(resolveLinuxAutostartExecutable({ packageType: "appimage", executable: "/tmp/.mount_CivCom/civcom", appImagePath: "/home/user/link.AppImage", resolveAppImage: () => "/home/user/real.AppImage" })).toBeUndefined();
    expect(resolveLinuxAutostartExecutable({ packageType: "appimage", executable: "/tmp/.mount_CivCom/civcom", appImagePath: "/home/user/bad\n.AppImage", resolveAppImage: () => "/home/user/bad\n.AppImage" })).toBeUndefined();
    expect(resolveLinuxAutostartExecutable({ packageType: "appimage", executable: "/tmp/.mount_CivCom/civcom", appImagePath: "/home/user/CivCom.AppImage", resolveAppImage: () => { throw new Error("inspection failed"); } })).toBeUndefined();
    expect(resolveLinuxAutostartExecutable({ packageType: "unknown", executable: "/tmp/.mount_CivCom/civcom", resolveAppImage: verified })).toBeUndefined();
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
    expect(store.load([area])).toEqual({ x: 1600, y: 1, width: 320, height: 240 });
    store.save(valid, [area]);
    expect(writes).toEqual([JSON.stringify(valid)]);
    expect(writes[0]).not.toContain("url");
  });

  it("uses a self-contained data offline page and retries only the fixed resolved start URL", () => {
    const offlineUrl = createOfflinePageUrl("/Application/CivCom/offline.html");
    expect(offlineUrl.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    const html = decodeURIComponent(offlineUrl.slice("data:text/html;charset=utf-8,".length));
    expect(html).toContain('href="about:blank#retry"');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script|<link|<img|https?:|file:/i);
    expect(PRODUCTION_CIVCOM_URL).toBe("https://civcom.soia.info/");
    expect(createRuntimeNavigationGate(offlineUrl).navigate("civcom-local://picker/index.html")).toEqual({ allow: false });
  });

  it("rejects unsafe downloads and allocates collision-safe filenames without opening them", async () => {
    expect(sanitizeDownloadBasename("raport.pdf")).toBe("raport.pdf");
    expect(sanitizeDownloadBasename("../raport.pdf")).toBeUndefined();
    expect(sanitizeDownloadBasename("folder/raport.pdf")).toBeUndefined();
    expect(sanitizeDownloadBasename(" ")).toBeUndefined();
    expect(sanitizeDownloadBasename("CON")).toBeUndefined();
    const existing = new Set(["/Downloads/raport.pdf", "/Downloads/raport (1).pdf"]);
    await expect(resolveDownloadDestination("/Downloads", "raport.pdf", (path) => existing.has(path))).resolves.toBe("/Downloads/raport (2).pdf");
    await expect(resolveDownloadDestination("C:\\Downloads", "raport.pdf", () => false, { isAbsolute: (path) => /^[A-Z]:\\/i.test(path), join: (directory, filename) => `${directory}\\${filename}` })).resolves.toBe("C:\\Downloads\\raport.pdf");
    expect(sanitizeDownloadBasename("trailing. ")).toBeUndefined();
    expect(sanitizeDownloadBasename("x".repeat(241))).toBeUndefined();
  });

  it("clamps restored bounds to the display with the greatest intersection or a surviving display", () => {
    const left = { x: -1000, y: 0, width: 1000, height: 800 };
    const main = { x: 0, y: 0, width: 1200, height: 900 };
    expect(normalizeBounds({ x: -20, y: 10, width: 1000, height: 700 }, [left, main])).toEqual({ x: 0, y: 10, width: 1000, height: 700 });
    expect(normalizeBounds({ x: 99999, y: 9, width: 9000, height: 9000 }, [main])).toEqual({ x: 0, y: 0, width: 1200, height: 900 });
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

  it("never throws when log storage fails and rotates by UTF-8 byte length", () => {
    const logger = new RotatingSafeLogger({ maxBytes: 4, maxFiles: 2, now: () => new Date(), read: () => { throw new Error("disk"); }, write: () => { throw new Error("disk"); }, remove: () => { throw new Error("disk"); } });
    expect(() => logger.lifecycle("startup", "ż")).not.toThrow();
  });

  it("turns arbitrary lifecycle inputs into fixed safe records", () => {
    const files = new Map<string, string>();
    const logger = new RotatingSafeLogger({ maxBytes: 1000, maxFiles: 2, now: () => new Date("2026-08-19T12:00:00.000Z"), read: (name) => files.get(name), write: (name, value) => files.set(name, value), remove: (name) => files.delete(name) });
    logger.lifecycle("token=abc" as never, "token=abc");
    logger.lifecycle(new Proxy({}, { get: () => { throw new Error("trap"); } }) as never, { toString: () => "secret" } as never);
    const output = files.get("civcom.log") ?? "";
    expect(output).toContain('"event":"security-event"');
    expect(output).toContain('"code":"UNCLASSIFIED"');
    expect(output).not.toContain("token=abc");
    expect(output).not.toContain("secret");
  });
});
