import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bootstrapUrl = new URL("./support/electron-anonymous-bootstrap.cjs", import.meta.url);

describe("anonymous renderer bootstrap trust boundary", () => {
  it("uses only the fixed production target and installs the closed guard before its window", () => {
    const source = readFileSync(bootstrapUrl, "utf8");
    expect(source).toContain('const PRODUCTION_URL = "https://civcom.soia.info/"');
    expect(source).toContain("createAnonymousProductionNetworkGuard()");
    expect(source).toContain('CIVCOM_ALLOW_ANONYMOUS_PRODUCTION_SMOKE === "confirmed"');
    const sslConfig = source.indexOf('setSSLConfig({ minVersion: "tls1.2", maxVersion: "tls1.3" })');
    expect(sslConfig).toBeGreaterThanOrEqual(0);
    expect(source.indexOf("onBeforeRequest")).toBeGreaterThanOrEqual(0);
    expect(sslConfig).toBeLessThan(source.indexOf("onBeforeRequest"));
    expect(source.indexOf("onBeforeRequest")).toBeLessThan(source.indexOf("new BrowserWindow"));
    const clientCertificateHandler = source.indexOf('app.on("select-client-certificate"');
    expect(clientCertificateHandler).toBeGreaterThanOrEqual(0);
    expect(clientCertificateHandler).toBeLessThan(source.indexOf("app.whenReady()"));
    expect(source.slice(clientCertificateHandler, source.indexOf("app.whenReady()"))).toContain("event.preventDefault(); callback();");
    expect(source).toContain("createWebPreferences(partition)");
    expect(source).toContain("guardInstalledBeforeWindow");
    expect(source).toContain("requestHeaders = details.requestHeaders");
    expect(source).not.toContain('getOwnPropertyDescriptor(details, "requestHeaders")');
    expect(source).not.toMatch(/persist:civcom|defaultSession|context\.route|--no-sandbox|ignoreHTTPSErrors:\s*true/);
  });

  it("keeps the bootstrap and all test support outside packaged files", () => {
    const builder = readFileSync(new URL("../electron-builder.config.cjs", import.meta.url), "utf8");
    expect(builder).toContain('{ from: "dist", to: "dist"');
    expect(builder).not.toMatch(/from:\s*"test"|test\/support|electron-anonymous-bootstrap/);
  });
});
