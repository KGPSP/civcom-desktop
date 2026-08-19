import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

describe("Electron main-process integration contract", () => {
  it("uses one persistent remote partition, an explicit single-instance lock, and keeps the remote window preload-free", () => {
    expect(main).toContain('session.fromPartition("persist:civcom")');
    expect(main).toContain("app.requestSingleInstanceLock()");
    expect(main).toContain('app.on("second-instance", showMainWindow)');
    expect(main).toContain("webPreferences: createWebPreferences()");
    expect(main).not.toContain("setUserAgent(");
  });

  it("denies certificate errors, funnels links through policy, and installs the display handler on the CivCom session", () => {
    expect(main).toContain('app.on("certificate-error"');
    expect(main).toContain("callback(false)");
    expect(main).toContain("setWindowOpenHandler");
    expect(main).toContain("setPermissionCheckHandler");
    expect(main).toContain("setPermissionRequestHandler");
    expect(main).toContain("setDevicePermissionHandler(() => false)");
    expect(main).toContain("installDisplayMediaRequestHandler");
    expect(main).toContain("watchFrameLifetime");
    expect(main).toContain("SCREEN_SHARE_NATIVE_OPERATION_TIMEOUT_MS");
    expect(main.match(/process\.getSystemVersion\(\)/g)).toHaveLength(1);
  });

  it("keeps lifecycle actions user-visible and the offline retry local", () => {
    expect(main).toContain('title: "CivCom", show: false');
    expect(main).toContain('label: "Zakończ CivCom"');
    expect(main).toContain("callbacks.close(event, trayAvailable)");
    expect(main).toContain("did-fail-load");
    expect(main).toContain("did-navigate-in-page");
    expect(main).toContain("offlineUrl");
  });
});
