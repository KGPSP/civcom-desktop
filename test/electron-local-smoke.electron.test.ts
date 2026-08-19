import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopbackFixture, createSelfSignedLoopbackFixture, type TrafficPath } from "./support/loopback-server.js";

const bootstrap = new URL("./support/electron-local-bootstrap.cjs", import.meta.url).pathname;

type LocalSnapshot = Readonly<{
  phase: "about" | "loopback" | "offline" | "other";
  externalOpenCount: number;
  blockedRequestCount: number;
  redirectCount: number;
  downloadsEmpty: boolean;
  downloadsEntryCount: number;
  productionMainWired: boolean;
  guardInstalledBeforeWindow: boolean;
  memoryPartition: boolean;
}>;

let runningApp: ElectronApplication | undefined;

async function launch(origin: string, tlsOrigin?: string): Promise<Readonly<{ app: ElectronApplication; page: Page }>> {
  const environment: Record<string, string> = { CIVCOM_LOCAL_HARNESS_ORIGIN: origin };
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (tlsOrigin !== undefined) environment.CIVCOM_LOCAL_HARNESS_TLS_ORIGIN = tlsOrigin;
  const app = await electron.launch({ args: [bootstrap], chromiumSandbox: true, acceptDownloads: false, ignoreHTTPSErrors: false, env: environment, timeout: 30_000 });
  runningApp = app;
  await expect.poll(async () => await app.evaluate(({ BrowserWindow }) => Object.freeze({
    ready: typeof (globalThis as unknown as { __civcomLocalStart?: unknown }).__civcomLocalStart === "function",
    windowCount: BrowserWindow.getAllWindows().length
  })), { timeout: 15_000 }).toEqual({ ready: true, windowCount: 1 });
  const page = await app.firstWindow();
  return Object.freeze({ app, page });
}

async function start(app: ElectronApplication): Promise<boolean> {
  return await app.evaluate(async () => await (globalThis as unknown as { __civcomLocalStart(): Promise<boolean> }).__civcomLocalStart());
}

async function snapshot(app: ElectronApplication): Promise<LocalSnapshot> {
  return await app.evaluate(async () => await (globalThis as unknown as { __civcomLocalSnapshot(): Promise<LocalSnapshot> }).__civcomLocalSnapshot());
}

function count(records: readonly Readonly<{ path: TrafficPath }>[], path: TrafficPath): number {
  return records.filter((record) => record.path === path).length;
}

afterEach(async () => {
  if (runningApp !== undefined) {
    await runningApp.close().catch(() => undefined);
    runningApp = undefined;
  }
});

describe.sequential("local loopback Electron shell", () => {
  it("uses the secure unpackaged shell and blocks mutation, credentials, OS side effects, and unsafe navigation", async () => {
    const fixture = await createLoopbackFixture();
    const tls = await createSelfSignedLoopbackFixture();
    try {
      const { app, page } = await launch(fixture.origin, tls.origin);
      expect((await snapshot(app)).phase).toBe("about");
      expect(await start(app)).toBe(true);
      const localHeading = page.getByRole("heading", { name: "CivCom local harness" });
      await localHeading.waitFor({ state: "visible", timeout: 15_000 });
      expect(await localHeading.count()).toBe(1);

      await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === "activated", undefined, { timeout: 15_000 });
      const capabilities = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return Object.freeze({
          node: typeof (globalThis as unknown as { process?: unknown }).process === "undefined"
            && typeof (globalThis as unknown as { require?: unknown }).require === "undefined"
            && typeof (globalThis as unknown as { module?: unknown }).module === "undefined"
            && typeof (globalThis as unknown as { Buffer?: unknown }).Buffer === "undefined",
          bridges: !("electron" in window) && !("civcomScreenPicker" in window) && !("ipcRenderer" in window),
          serviceWorker: registration.active?.state === "activated" && registration.scope === `${location.origin}/`
        });
      });
      expect(capabilities).toEqual({ node: true, bridges: true, serviceWorker: true });

      const permissionDenied = await page.evaluate(async () => {
        const fixtureApi = (window as unknown as { civcomFixture: Readonly<{ post(): Promise<unknown>; websocket(): void; serviceWorkerPost(): Promise<void>; subresource(): void; redirect(): Promise<unknown>; popup(url: string): void; permission(): Promise<unknown> }> }).civcomFixture;
        const [, , , permission] = await Promise.allSettled([fixtureApi.post(), fixtureApi.serviceWorkerPost(), fixtureApi.redirect(), fixtureApi.permission()]);
        fixtureApi.websocket();
        fixtureApi.subresource();
        for (const url of ["file:///tmp/blocked", "javascript:void(0)", "data:text/html,blocked", "https://civcom.soia.info.evil.invalid/", "unknown:blocked"]) fixtureApi.popup(url);
        return permission.status === "fulfilled" && permission.value === "denied";
      });
      expect(permissionDenied).toBe(true);
      await page.waitForTimeout(500);
      const records = fixture.records();
      for (const forbidden of ["forbidden-post", "forbidden-websocket", "forbidden-service-worker", "forbidden-subresource", "redirect-target"] as const) expect(count(records, forbidden)).toBe(0);
      expect(count(records, "redirect-source")).toBe(1);

      const beforeExternal = await snapshot(app);
      expect(beforeExternal.externalOpenCount).toBe(0);
      await page.evaluate(() => (window as unknown as { civcomFixture: { popup(url: string): void } }).civcomFixture.popup("https://example.org/safe"));
      await expect.poll(async () => (await snapshot(app)).externalOpenCount).toBe(beforeExternal.externalOpenCount + 1);

      await page.getByRole("link", { name: "Download fixture" }).click();
      await expect.poll(() => count(fixture.records(), "download")).toBe(1);
      await expect.poll(async () => (await snapshot(app)).downloadsEntryCount, { timeout: 5_000 }).toBe(0);

      await fixture.stop();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
      await expect.poll(async () => (await snapshot(app)).phase).toBe("offline");
      const rootBeforeRetry = count(fixture.records(), "root");
      await fixture.restart();
      await page.getByRole("link", { name: "Spróbuj ponownie" }).click();
      await expect.poll(async () => (await snapshot(app)).phase, { timeout: 15_000 }).toBe("loopback");
      await localHeading.waitFor({ state: "visible", timeout: 15_000 });
      expect(count(fixture.records(), "root")).toBe(rootBeforeRetry + 1);

      const tlsRequestsBefore = tls.requests();
      expect(await app.evaluate(async () => await (globalThis as unknown as { __civcomLocalProbeCertificate(): Promise<boolean> }).__civcomLocalProbeCertificate())).toBe(false);
      expect(tls.requests()).toBe(tlsRequestsBefore);

      const final = await snapshot(app);
      expect(final).toMatchObject({
        phase: "loopback",
        productionMainWired: true,
        guardInstalledBeforeWindow: true,
        memoryPartition: true,
        downloadsEmpty: true
      });
      expect(final.blockedRequestCount).toBeGreaterThanOrEqual(5);
      expect(final.redirectCount).toBe(1);
    } finally {
      await fixture.stop();
      await tls.stopAndRemove();
    }
  }, 60_000);
});
