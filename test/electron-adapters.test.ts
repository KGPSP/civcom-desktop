import { describe, expect, it, vi } from "vitest";
import { authorizeDownloadRequest, createNavigationCallbacks, createPermissionCallbacks, createWindowCallbacks } from "../src/desktop/electron-adapters.js";

describe("Electron callback adapters", () => {
  it("uses frame origins for both permission callback forms and fails closed", () => {
    const handlers = createPermissionCallbacks();
    expect(handlers.check("media", { securityOrigin: "https://call.soia.info/", mediaType: "audio" })).toBe(true);
    expect(handlers.check("media", { securityOrigin: "https://civcom.soia.info/", mediaType: "display" })).toBe(false);
    expect(handlers.check("notifications", { requestingUrl: "https://matrix.soia.info/" })).toBe(false);
    expect(handlers.request("media", { requestingUrl: "https://call.soia.info/", mediaTypes: ["video"] })).toBe(true);
    expect(handlers.request("media", { mediaTypes: ["audio"] })).toBe(false);
  });

  it("keeps internal popup navigation in the existing window and opens only safe externals", async () => {
    const load = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const navigation = createNavigationCallbacks({ offlineUrl: "file:///tmp/offline.html", load, openExternal, log });
    expect(navigation.windowOpen("https://auth.soia.info/login")).toEqual({ action: "deny" });
    expect(load).toHaveBeenCalledWith("https://auth.soia.info/login");
    expect(navigation.windowOpen("https://example.org/path")).toEqual({ action: "deny" });
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledWith("https://example.org/path");
    const event = { preventDefault: vi.fn() };
    navigation.navigate(event, "https://example.org/path");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledTimes(2);
    navigation.navigate({ preventDefault: vi.fn() }, "javascript:alert(1)");
    expect(load).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ event: "navigation-denied", code: "UNCLASSIFIED" });
  });

  it("fuses offline failures, fixes title and flushes a pending activation", () => {
    const load = vi.fn();
    const show = vi.fn();
    const callbacks = createWindowCallbacks({ startUrl: "https://civcom.soia.info/", offlineUrl: "file:///tmp/offline.html", load, show, log: vi.fn() });
    callbacks.failedLoad(-2, true, "https://civcom.soia.info/");
    callbacks.failedLoad(-2, true, "file:///tmp/offline.html");
    expect(load).toHaveBeenCalledTimes(1);
    const titleEvent = { preventDefault: vi.fn() };
    expect(callbacks.pageTitle(titleEvent)).toBe("CivCom");
    expect(titleEvent.preventDefault).toHaveBeenCalledOnce();
    callbacks.activate();
    callbacks.ready(true);
    expect(show).toHaveBeenCalledOnce();
  });

  it("allows downloads only from the CivCom frame with an approved redirect chain", () => {
    expect(authorizeDownloadRequest("https://civcom.soia.info/#/room/a", ["https://civcom.soia.info/file", "https://matrix.soia.info/media/a", "blob:https://civcom.soia.info/id"], "report.pdf")).toBe(true);
    expect(authorizeDownloadRequest("https://auth.soia.info/", ["https://civcom.soia.info/file"], "report.pdf")).toBe(false);
    expect(authorizeDownloadRequest("https://civcom.soia.info/", ["https://auth.soia.info/file"], "report.pdf")).toBe(false);
    expect(authorizeDownloadRequest("https://civcom.soia.info/", ["https://civcom.soia.info/file"], "CON.txt")).toBe(false);
  });
});
