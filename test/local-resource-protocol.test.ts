import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const moduleUrl = new URL("../src/screen-share/local-protocol.ts", import.meta.url).href;

type LocalProtocol = Readonly<{
  PICKER_DOCUMENT_URL: string;
  registerLocalScheme(registrar: Readonly<{ registerSchemesAsPrivileged(schemes: readonly unknown[]): void }>): void;
  createPickerProtocolHandler(input: Readonly<{ rootDirectory: string; readFile?: typeof readFile }>): (request: Readonly<{ url: string; method: string }>) => Promise<Response>;
  installPickerProtocol(input: Readonly<{
    sessions: Readonly<{ fromPartition(partition: string): Readonly<{ protocol: Readonly<{
      isProtocolHandled(scheme: string): boolean;
      handle(scheme: string, handler: (request: any) => Promise<Response>): void;
    }> }> }>;
    rootDirectory: string;
    readFile?: typeof readFile;
  }>): unknown;
}>;

async function loadModule(): Promise<LocalProtocol> {
  return await import(moduleUrl) as LocalProtocol;
}

async function pickerRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "civcom-picker-protocol-"));
  await Promise.all([
    writeFile(join(root, "picker.html"), "<!doctype html><title>picker</title>"),
    writeFile(join(root, "picker.css"), "body{}"),
    writeFile(join(root, "picker-renderer.js"), "export {};"),
  ]);
  return root;
}

describe("isolated civcom-local picker protocol", () => {
  it("registers only standard, secure, fetch privileges before ready", async () => {
    const { registerLocalScheme } = await loadModule();
    const registerSchemesAsPrivileged = vi.fn();
    registerLocalScheme({ registerSchemesAsPrivileged });
    expect(registerSchemesAsPrivileged).toHaveBeenCalledOnce();
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([{ scheme: "civcom-local", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  });

  it("serves only the three closed GET/HEAD resources with defensive headers", async () => {
    const { createPickerProtocolHandler } = await loadModule();
    const handler = createPickerProtocolHandler({ rootDirectory: await pickerRoot() });
    const expected = [
      ["civcom-local://picker/index.html", "text/html; charset=utf-8"],
      ["civcom-local://picker/picker.css", "text/css; charset=utf-8"],
      ["civcom-local://picker/picker-renderer.js", "text/javascript; charset=utf-8"]
    ] as const;
    for (const [url, contentType] of expected) {
      const response = await handler({ url, method: "GET" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const csp = response.headers.get("content-security-policy") ?? "";
      for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src data:", "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "manifest-src 'none'", "frame-ancestors 'none'", "object-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(csp).toContain(directive);
      expect(response.headers.get("permissions-policy")).toContain("display-capture=()");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      const head = await handler({ url, method: "HEAD" });
      expect(head.status).toBe(200);
      expect((await head.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it("denies the full traversal, encoding, authority, method, and unknown-resource matrix", async () => {
    const { createPickerProtocolHandler } = await loadModule();
    const handler = createPickerProtocolHandler({ rootDirectory: await pickerRoot() });
    const hostileUrls = [
      "https://picker/index.html",
      "civcom-local://evil/index.html",
      "civcom-local://user@picker/index.html",
      "civcom-local://picker:443/index.html",
      "civcom-local://picker/index.html?x=1",
      "civcom-local://picker/index.html#x",
      "civcom-local://picker/%2e%2e/.cred.env",
      "civcom-local://picker/../.cred.env",
      "civcom-local://picker/%70icker.css",
      "civcom-local://picker//picker.css",
      "civcom-local://picker\\index.html",
      "civcom-local://pіcker/index.html",
      "civcom-local://picker/.cred.env",
      "civcom-local://picker/unknown.js",
      "civcom-local://picker/index.html\u0000"
    ];
    for (const url of hostileUrls) {
      const response = await handler({ url, method: "GET" });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
    for (const method of ["POST", "OPTIONS", "get", "GET\nHEAD", ""] ) {
      const response = await handler({ url: "civcom-local://picker/index.html", method });
      expect(response.status).toBe(405);
    }
    const trapped = new Proxy({}, { get: () => { throw new Error("hostile accessor"); } });
    await expect(handler(trapped as never)).resolves.toMatchObject({ status: 404 });
  });

  it("installs a handler only on the non-persistent picker session", async () => {
    const { installPickerProtocol } = await loadModule();
    const pickerHandle = vi.fn();
    const remoteHandle = vi.fn();
    const defaultHandle = vi.fn();
    const pickerIsProtocolHandled = vi.fn(() => false);
    const partitions: string[] = [];
    const sessions = {
      defaultSession: { protocol: { isProtocolHandled: vi.fn(() => false), handle: defaultHandle } },
      fromPartition: (partition: string) => {
        partitions.push(partition);
        return { protocol: { isProtocolHandled: pickerIsProtocolHandled, handle: partition === "civcom-picker" ? pickerHandle : remoteHandle } };
      }
    };
    installPickerProtocol({ sessions, rootDirectory: await pickerRoot() });
    expect(partitions).toEqual(["civcom-picker"]);
    expect(pickerIsProtocolHandled).toHaveBeenCalledExactlyOnceWith("civcom-local");
    expect(pickerHandle).toHaveBeenCalledOnce();
    expect(pickerHandle.mock.calls[0]?.[0]).toBe("civcom-local");
    expect(remoteHandle).not.toHaveBeenCalled();
    expect(defaultHandle).not.toHaveBeenCalled();
  });

  it("fails closed instead of replacing an existing picker-session handler", async () => {
    const { installPickerProtocol } = await loadModule();
    const handle = vi.fn();
    const isProtocolHandled = vi.fn(() => true);
    const sessions = { fromPartition: vi.fn(() => ({ protocol: { isProtocolHandled, handle } })) };
    const rootDirectory = await pickerRoot();
    expect(() => installPickerProtocol({ sessions, rootDirectory })).toThrow("picker-protocol-already-installed");
    expect(isProtocolHandled).toHaveBeenCalledExactlyOnceWith("civcom-local");
    expect(handle).not.toHaveBeenCalled();
  });
});
