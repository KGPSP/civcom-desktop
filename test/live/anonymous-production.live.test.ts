import { _electron as electron, type ElectronApplication } from "playwright";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { runAnonymousEndpointProbe } from "../support/anonymous-endpoint-probe.mjs";

const require = createRequire(import.meta.url);
const { copySafeElectronEnvironment } = require("../support/electron-environment.cjs") as Readonly<{
  copySafeElectronEnvironment(source: object): Record<string, string>;
}>;
const bootstrap = new URL("../support/electron-anonymous-bootstrap.cjs", import.meta.url).pathname;

type AnonymousSnapshot = Readonly<{
  phase: "about" | "civcom" | "login" | "other";
  blockedRequestCount: number;
  mutationBlockCount: number;
  credentialHeaderBlockCount: number;
  redirectBlockCount: number;
  deniedPermissionCount: number;
  deniedDownloadCount: number;
  rendererConsoleErrorCount: number;
  rendererCrashCount: number;
  clientCertificateDenyCount: number;
  guardInstalledBeforeWindow: boolean;
  memoryPartition: boolean;
  securePreferences: boolean;
  sequenceAccepted: boolean;
}>;

let runningApp: ElectronApplication | undefined;

function safeEnvironment(): Record<string, string> {
  const environment = copySafeElectronEnvironment(process.env);
  environment.CIVCOM_ALLOW_ANONYMOUS_PRODUCTION_SMOKE = process.env.CIVCOM_ALLOW_ANONYMOUS_PRODUCTION_SMOKE ?? "";
  return environment;
}

async function snapshot(app: ElectronApplication): Promise<AnonymousSnapshot> {
  return await app.evaluate(() => (globalThis as unknown as { __civcomAnonymousSnapshot(): AnonymousSnapshot }).__civcomAnonymousSnapshot());
}

afterEach(async () => {
  if (runningApp !== undefined) {
    await runningApp.close().catch(() => undefined);
    runningApp = undefined;
  }
});

describe.sequential("explicit anonymous CivCom production smoke", () => {
  it("validates the six fixed HTTPS endpoint contracts without a session or mutation", async () => {
    const result = await runAnonymousEndpointProbe();
    expect(result).toEqual({
      kind: "accepted",
      code: "ANONYMOUS_ENDPOINTS_OK",
      checks: ["ROOT_OK", "VERSION_OK", "CONFIG_OK", "MANIFEST_OK", "SERVICE_WORKER_OK", "HEAD_OK"],
      warnings: ["MANIFEST_BRAND_PENDING"]
    });
  });

  it("loads only the anonymous welcome and login views in a guarded memory session", async () => {
    try {
      expect(process.env.CIVCOM_ALLOW_ANONYMOUS_PRODUCTION_SMOKE).toBe("confirmed");
      const app = await electron.launch({ args: [bootstrap], chromiumSandbox: true, acceptDownloads: false, ignoreHTTPSErrors: false, env: safeEnvironment(), timeout: 30_000 });
      runningApp = app;
      await expect.poll(async () => await app.evaluate(({ BrowserWindow }) => Object.freeze({
        ready: typeof (globalThis as unknown as { __civcomAnonymousArm?: unknown }).__civcomAnonymousArm === "function",
        windowCount: BrowserWindow.getAllWindows().length
      })), { timeout: 15_000 }).toEqual({ ready: true, windowCount: 1 });
      const page = await app.firstWindow();
      let pageErrorCount = 0;
      let fatalConsoleCount = 0;
      let pageCrashCount = 0;
      page.on("pageerror", () => { pageErrorCount += 1; });
      page.on("console", (message) => { if (message.type() === "error") fatalConsoleCount += 1; });
      page.on("crash", () => { pageCrashCount += 1; });

      expect(await app.evaluate(() => (globalThis as unknown as { __civcomAnonymousArm(): boolean }).__civcomAnonymousArm())).toBe(true);
      expect(await app.evaluate(async () => await (globalThis as unknown as { __civcomAnonymousStart(): Promise<boolean> }).__civcomAnonymousStart())).toBe(true);
      await page.getByRole("heading", { name: "Witaj w CivCom", exact: false }).waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === "activated", undefined, { timeout: 30_000 });

      const capabilities = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        const active = registration.active;
        let exactServiceWorker: boolean;
        try {
          const script = new URL(active?.scriptURL ?? "about:blank");
          const scope = new URL(registration.scope);
          exactServiceWorker = active?.state === "activated" && script.origin === "https://civcom.soia.info" && script.pathname === "/sw.js" && script.search === "" && script.hash === "" && scope.href === "https://civcom.soia.info/";
        } catch { exactServiceWorker = false; }
        return Object.freeze({
          noNode: typeof (globalThis as unknown as { process?: unknown }).process === "undefined" && typeof (globalThis as unknown as { require?: unknown }).require === "undefined" && typeof (globalThis as unknown as { module?: unknown }).module === "undefined" && typeof (globalThis as unknown as { Buffer?: unknown }).Buffer === "undefined",
          noBridge: !("ipcRenderer" in window) && !("electron" in window) && !("civcomScreenPicker" in window),
          exactServiceWorker,
          electronIdentity: navigator.userAgent.includes("Electron/43.4.1") && navigator.userAgent.includes("Chrome/")
        });
      });
      expect(capabilities).toEqual({ noNode: true, noBridge: true, exactServiceWorker: true, electronIdentity: true });

      expect(await app.evaluate(async () => await (globalThis as unknown as { __civcomAnonymousLoginRoute(): Promise<boolean> }).__civcomAnonymousLoginRoute())).toBe(true);
      await page.getByText("Zaloguj się", { exact: false }).first().waitFor({ state: "visible", timeout: 30_000 });
      await expect.poll(async () => (await snapshot(app)).phase, { timeout: 15_000 }).toBe("login");

      const state = await snapshot(app);
      expect(state).toMatchObject({
        phase: "login",
        mutationBlockCount: 0,
        credentialHeaderBlockCount: 0,
        redirectBlockCount: 0,
        deniedPermissionCount: 0,
        deniedDownloadCount: 0,
        rendererConsoleErrorCount: 0,
        rendererCrashCount: 0,
        clientCertificateDenyCount: 0,
        guardInstalledBeforeWindow: true,
        memoryPartition: true,
        securePreferences: true,
        sequenceAccepted: true
      });
      expect(pageErrorCount).toBe(0);
      expect(fatalConsoleCount).toBe(0);
      expect(pageCrashCount).toBe(0);
    } catch {
      throw new Error("ANONYMOUS_RENDERER_REJECTED");
    }
  });
});
