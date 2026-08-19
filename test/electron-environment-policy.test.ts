import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

type EnvironmentPolicy = Readonly<{
  copySafeElectronEnvironment(source: object): Record<string, string>;
  scrubSensitiveElectronEnvironment(environment: Record<string, string>): void;
}>;

function loadPolicy(): EnvironmentPolicy {
  return require("./support/electron-environment.cjs") as EnvironmentPolicy;
}

describe("Playwright Electron environment boundary", () => {
  it("preserves the X11 authentication path without copying auth, proxy, CI, or Node controls", () => {
    const policy = loadPolicy();
    const touched = vi.fn();
    const source = Object.defineProperties({}, {
      DISPLAY: { value: ":99", enumerable: true },
      XAUTHORITY: { value: "/tmp/xvfb-auth", enumerable: true },
      PATH: { value: "/usr/bin", enumerable: true },
      CI: { value: "true", enumerable: true },
      AUTH_TOKEN: { value: "forbidden", enumerable: true },
      HTTPS_PROXY: { value: "https://forbidden.invalid", enumerable: true },
      NODE_OPTIONS: { value: "--inspect", enumerable: true },
      HOME: { get: () => { touched(); return "/forbidden"; }, enumerable: true }
    });

    expect(policy.copySafeElectronEnvironment(source)).toEqual({
      PATH: "/usr/bin",
      DISPLAY: ":99",
      XAUTHORITY: "/tmp/xvfb-auth"
    });
    expect(touched).not.toHaveBeenCalled();
  });

  it("keeps XAUTHORITY available to Chromium while scrubbing all other auth-like bootstrap inputs", () => {
    const policy = loadPolicy();
    const environment = {
      PATH: "/usr/bin",
      DISPLAY: ":99",
      XAUTHORITY: "/tmp/xvfb-auth",
      CIVCOM_LOCAL_HARNESS_ORIGIN: "http://127.0.0.1:1234",
      AUTH_TOKEN: "forbidden",
      HTTPS_PROXY: "https://forbidden.invalid",
      NODE_OPTIONS: "--inspect",
      CI: "true"
    };

    policy.scrubSensitiveElectronEnvironment(environment);

    expect(environment).toEqual({
      PATH: "/usr/bin",
      DISPLAY: ":99",
      XAUTHORITY: "/tmp/xvfb-auth"
    });
  });

  it("wires the shared policy into every local, anonymous, and manual Electron boundary", () => {
    for (const path of [
      "./electron-local-smoke.electron.test.ts",
      "./live/anonymous-production.live.test.ts",
      "../scripts/manual-production-check.mjs"
    ]) {
      expect(readFileSync(new URL(path, import.meta.url), "utf8")).toContain("copySafeElectronEnvironment");
    }
    for (const path of [
      "./support/electron-local-bootstrap.cjs",
      "./support/electron-anonymous-bootstrap.cjs",
      "./support/electron-manual-bootstrap.cjs"
    ]) {
      expect(readFileSync(new URL(path, import.meta.url), "utf8")).toContain("scrubSensitiveElectronEnvironment(process.env)");
    }
  });
});
