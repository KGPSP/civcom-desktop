import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

type HelperModule = Readonly<{
  validateManualInvocation?: (input: unknown) => Readonly<{ kind: "accepted" | "rejected"; code: string }>;
  runManualProductionFlow?: (dependencies: Readonly<{
    invocation: unknown;
    readCredentials(): Readonly<{ kind: "accepted"; route: object }> | Readonly<{ kind: "rejected"; code: string }>;
    createProfile(): string;
    launchBrowser(profile: string): Promise<Readonly<{ isAuthenticated(): Promise<boolean>; navigate(url: string): Promise<void>; close(): Promise<void> }>>;
    confirmInteractiveLogin(): Promise<boolean>;
    waitForManualCompletion(): Promise<boolean>;
    removeProfile(profile: string): void;
    status(code: string): void;
  }>) => Promise<Readonly<{ kind: "accepted" | "rejected"; code: string }>>;
}>;

async function loadModule(): Promise<HelperModule> {
  return await import(new URL("../scripts/manual-production-check.mjs", import.meta.url).href).catch(() => Object.freeze({})) as HelperModule;
}

function invocation(overrides: Record<string, unknown> = {}): object {
  return Object.freeze({ argv: Object.freeze([]), ci: false, stdinIsTTY: true, stdoutIsTTY: true, platform: "darwin", ...overrides });
}

describe("manual production helper boundary", () => {
  it("rejects argv, CI, and non-TTY states before opening the credential file", async () => {
    const module = await loadModule();
    expect(typeof module.runManualProductionFlow).toBe("function");
    for (const unsafe of [invocation({ argv: ["--target=x"] }), invocation({ ci: true }), invocation({ stdinIsTTY: false }), invocation({ stdoutIsTTY: false })]) {
      const readCredentials = vi.fn();
      const result = await module.runManualProductionFlow!({
        invocation: unsafe,
        readCredentials,
        createProfile: vi.fn(),
        launchBrowser: vi.fn(),
        confirmInteractiveLogin: vi.fn(),
        waitForManualCompletion: vi.fn(),
        removeProfile: vi.fn(),
        status: vi.fn()
      });
      expect(result.kind).toBe("rejected");
      expect(readCredentials).not.toHaveBeenCalled();
    }
  });

  it("never accesses automated-login methods and gives the browser no login or pass value", async () => {
    const module = await loadModule();
    expect(typeof module.runManualProductionFlow).toBe("function");
    const parsedModule = await import(new URL("../scripts/manual/credential-file.mjs", import.meta.url).href) as Readonly<{ parseManualCredentialText(text: string): { kind: string; route?: object } }>;
    const parsed = parsedModule.parseManualCredentialText("adres_test=https://civcom.soia.info/#/room/!FAKE-PLACEHOLDER:soia.info\nlogin=FAKE_LOGIN\npass=FAKE_PASS\n");
    expect(parsed.kind).toBe("accepted");
    const touched: string[] = [];
    const browser = new Proxy({
      isAuthenticated: async () => true,
      navigate: async (_url: string) => { touched.push("navigate"); },
      close: async () => { touched.push("close"); }
    }, {
      get(target, property, receiver) {
        touched.push(String(property));
        if (["fill", "type", "press", "paste", "click", "submit", "login", "pass", "clipboard"].includes(String(property))) throw new Error("AUTOMATION_FORBIDDEN");
        return Reflect.get(target, property, receiver);
      }
    });
    const launchBrowser = vi.fn(async (profile: string) => {
      expect(profile).toBe("/verified/temp/profile");
      return browser;
    });
    const result = await module.runManualProductionFlow!({
      invocation: invocation(),
      readCredentials: () => ({ kind: "accepted", route: parsed.route! }),
      createProfile: () => "/verified/temp/profile",
      launchBrowser,
      confirmInteractiveLogin: async () => true,
      waitForManualCompletion: async () => { touched.push("manual"); return true; },
      removeProfile: (profile) => { expect(profile).toBe("/verified/temp/profile"); touched.push("remove"); },
      status: (code) => { expect(code).not.toContain("FAKE_"); }
    });
    expect(result).toEqual({ kind: "accepted", code: "MANUAL_ROUTE_READY" });
    expect(launchBrowser).toHaveBeenCalledWith("/verified/temp/profile");
    expect(touched).not.toEqual(expect.arrayContaining(["fill", "type", "press", "paste", "click", "submit", "login", "pass", "clipboard"]));
    expect(touched.filter((value) => value === "navigate")).toHaveLength(1);
    expect(touched).toContain("manual");
    expect(touched.at(-1)).toBe("remove");
  });

  it("does not navigate until the human confirms and the safe authenticated boolean is true", async () => {
    const module = await loadModule();
    expect(typeof module.runManualProductionFlow).toBe("function");
    const browser = Object.freeze({ isAuthenticated: async () => false, navigate: vi.fn(async () => undefined), close: vi.fn(async () => undefined) });
    const route = Object.freeze({});
    const result = await module.runManualProductionFlow!({
      invocation: invocation(),
      readCredentials: () => ({ kind: "accepted", route }),
      createProfile: () => "/verified/temp/profile",
      launchBrowser: async () => browser,
      confirmInteractiveLogin: async () => true,
      waitForManualCompletion: vi.fn(),
      removeProfile: vi.fn(),
      status: vi.fn()
    });
    expect(result).toEqual({ kind: "rejected", code: "LOGIN_NOT_CONFIRMED" });
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("fails closed when browser or verified-profile cleanup fails and still attempts both", async () => {
    const module = await loadModule();
    const parsedModule = await import(new URL("../scripts/manual/credential-file.mjs", import.meta.url).href) as Readonly<{ parseManualCredentialText(text: string): { kind: string; route?: object } }>;
    expect(typeof module.runManualProductionFlow).toBe("function");
    for (const failedStep of ["browser", "profile"] as const) {
      const parsed = parsedModule.parseManualCredentialText("adres_test=https://civcom.soia.info/#/room/!FAKE-CLEANUP:soia.info\nlogin=FAKE_LOGIN\npass=FAKE_PASS\n");
      expect(parsed.kind).toBe("accepted");
      const close = vi.fn(async () => { if (failedStep === "browser") throw new Error("FAKE_BROWSER_CLOSE_ERROR"); });
      const removeProfile = vi.fn(() => { if (failedStep === "profile") throw new Error("FAKE_PROFILE_REMOVE_ERROR"); });
      const result = await module.runManualProductionFlow!({
        invocation: invocation(),
        readCredentials: () => ({ kind: "accepted", route: parsed.route! }),
        createProfile: () => "/verified/temp/profile",
        launchBrowser: async () => Object.freeze({ isAuthenticated: async () => true, navigate: async () => undefined, close }),
        confirmInteractiveLogin: async () => true,
        waitForManualCompletion: async () => true,
        removeProfile,
        status: vi.fn()
      });
      expect(result).toEqual({ kind: "rejected", code: "MANUAL_CLEANUP_REJECTED" });
      expect(JSON.stringify(result)).not.toContain("FAKE_");
      expect(close).toHaveBeenCalledOnce();
      expect(removeProfile).toHaveBeenCalledOnce();
    }
  });

  it("uses one fixed credential path and a real-main manual bootstrap without automated login APIs", () => {
    const helper = readFileSync(new URL("../scripts/manual-production-check.mjs", import.meta.url), "utf8");
    const bootstrap = readFileSync(new URL("./support/electron-manual-bootstrap.cjs", import.meta.url), "utf8");
    expect(helper).toContain('new URL("../.cred.env", import.meta.url)');
    expect(helper).toContain("readFixedManualCredentialFile(FIXED_CREDENTIAL_PATH)");
    expect(helper).toContain("chromiumSandbox: true");
    expect(helper).toContain("ignoreHTTPSErrors: false");
    expect(helper).toContain("lstatSync(profile)");
    expect(helper).toContain("resolved !== profile");
    expect(helper).toMatch(/firstWindow[\s\S]+app\.close/);
    expect(helper).not.toMatch(/\.fill\(|\.type\(|\.press\(|\.paste\(|\.click\(|submit\(|clipboard|storageState|screenshot|trace|video|har/i);
    expect(bootstrap).toContain('dist", "main.js"');
    expect(bootstrap).not.toMatch(/CIVCOM_DEV_URL|persist:anonymous|window\.electron|ipcRenderer/);
  });
});
