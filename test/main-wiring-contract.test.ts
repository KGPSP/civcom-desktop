import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

describe("Electron main-process integration contract", () => {
  it("uses one persistent partition, an explicit single-instance lock, and never defines a preload", () => {
    expect(main).toContain('session.fromPartition("persist:civcom")');
    expect(main).toContain("app.requestSingleInstanceLock()");
    expect(main).toContain('app.on("second-instance", showMainWindow)');
    expect(main).not.toMatch(/preload\s*:/);
    expect(main).not.toContain("setUserAgent(");
  });

  it("denies certificate errors, funnels links through policy, and reserves display capture for Task 4", () => {
    expect(main).toContain('app.on("certificate-error"');
    expect(main).toContain("callback(false)");
    expect(main).toContain("setWindowOpenHandler");
    expect(main).toContain("setPermissionCheckHandler");
    expect(main).toContain("setPermissionRequestHandler");
    expect(main).toContain("setDevicePermissionHandler(() => false)");
    expect(main).toContain("Task 4 installs setDisplayMediaRequestHandler");
    expect(main).not.toContain("setDisplayMediaRequestHandler(");
  });

  it("keeps lifecycle actions user-visible and the offline retry local", () => {
    expect(main).toContain('title: "CivCom", show: false');
    expect(main).toContain('label: "Zakończ CivCom"');
    expect(main).toContain("event.preventDefault(); window.hide()");
    expect(main).toContain("did-fail-load");
    expect(main).toContain("did-navigate-in-page");
    expect(main).toContain("offlineUrl");
  });
});
