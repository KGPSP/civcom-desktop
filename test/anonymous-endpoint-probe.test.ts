import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

type ProbeModule = Readonly<{
  createAnonymousEndpointPlan?: (optIn: unknown) => readonly Readonly<{ method: string; origin: string; path: string; maxBytes: number }>[];
  validateAnonymousEndpointResponse?: (input: unknown) => Readonly<{ kind: "accepted" | "rejected"; code: string; warning?: string }>;
  validateAnonymousTls?: (input: unknown) => Readonly<{ kind: "accepted" | "rejected"; code: string }>;
  executeAnonymousEndpointProbe?: (dependencies: unknown) => Promise<Readonly<{ kind: "accepted" | "rejected"; code: string; checks?: readonly string[]; warnings?: readonly string[] }>>;
  runAnonymousEndpointProbe?: () => Promise<Readonly<{ kind: "accepted" | "rejected"; code: string }>>;
}>;

async function loadProbe(): Promise<ProbeModule> {
  return await import(new URL("./support/anonymous-endpoint-probe.mjs", import.meta.url).href).catch(() => Object.freeze({})) as ProbeModule;
}

const FIXTURES: Readonly<Record<string, Readonly<{ contentType: string; body: string }>>> = Object.freeze({
  "/": Object.freeze({ contentType: "text/html", body: "<!doctype html><meta name=referrer content=no-referrer><meta http-equiv=Content-Security-Policy content=default-src><div id=matrixchat></div>" }),
  "/version": Object.freeze({ contentType: "text/plain", body: "1.12.25\n" }),
  "/config.json": Object.freeze({ contentType: "application/json", body: JSON.stringify({ brand: "CivCom", default_server_config: { "m.homeserver": { base_url: "https://matrix.soia.info", server_name: "soia.info" } }, element_call: { url: "https://call.soia.info" }, permalink_prefix: "https://civcom.soia.info" }) }),
  "/manifest.json": Object.freeze({ contentType: "application/manifest+json", body: JSON.stringify({ name: "Element", start_url: "/", icons: [{ src: "/icon.png" }] }) }),
  "/sw.js": Object.freeze({ contentType: "application/javascript", body: "self.addEventListener('install',()=>{});self.addEventListener('activate',()=>{});self.addEventListener('fetch',()=>{});" })
});

function fakeHttpsTransport(statusCode = 200): Readonly<{ request: (...args: any[]) => any; options: readonly Record<string, unknown>[]; writes(): number; maxActive(): number }> {
  const options: Record<string, unknown>[] = [];
  let writes = 0;
  let active = 0;
  let maximum = 0;
  const request = (requestOptions: Record<string, unknown>, callback: (response: Readable & { statusCode?: number; headers: Record<string, string>; setTimeout(milliseconds: number, callback: () => void): unknown }) => void): any => {
    options.push(requestOptions);
    const outgoing = new EventEmitter() as EventEmitter & { end(): void; write(): void; destroy(): void; setTimeout(milliseconds: number, callback: () => void): unknown };
    outgoing.write = () => { writes += 1; };
    outgoing.setTimeout = () => outgoing;
    outgoing.destroy = () => undefined;
    outgoing.end = () => {
      active += 1;
      maximum = Math.max(maximum, active);
      queueMicrotask(() => {
        const socket = new EventEmitter() as EventEmitter & { authorized: boolean; authorizationError: null; getProtocol(): string; getPeerCertificate(): Readonly<{ valid_to: string }> };
        socket.authorized = true;
        socket.authorizationError = null;
        socket.getProtocol = () => "TLSv1.3";
        socket.getPeerCertificate = () => Object.freeze({ valid_to: "Sep 20 00:00:00 2030 GMT" });
        outgoing.emit("socket", socket);
        socket.emit("secureConnect");
        const path = String(requestOptions.path);
        const fixture = FIXTURES[path] ?? FIXTURES["/"]!;
        const body = requestOptions.method === "HEAD" ? "" : fixture.body;
        const response = Readable.from(body === "" ? [] : [Buffer.from(body)]) as Readable & { statusCode?: number; headers: Record<string, string>; setTimeout(milliseconds: number, callback: () => void): unknown };
        response.statusCode = statusCode;
        Object.setPrototypeOf(response, Object.create(Object.getPrototypeOf(response), {
          headers: { configurable: true, get: () => ({ "content-type": fixture.contentType }) }
        }));
        response.setTimeout = () => response;
        response.once("end", () => { active -= 1; });
        callback(response);
      });
    };
    return outgoing;
  };
  return Object.freeze({ request, options, writes: () => writes, maxActive: () => maximum });
}

describe("fixed anonymous endpoint probe", () => {
  it("rejects every opt-in except the exact confirmation before constructing requests", async () => {
    const createPlan = (await loadProbe()).createAnonymousEndpointPlan;
    expect(typeof createPlan).toBe("function");
    for (const value of [undefined, null, "", "confirmed ", "CONFIRMED", true]) {
      expect(() => createPlan!(value)).toThrowError("OPT_IN_REQUIRED");
    }
  });

  it("constructs exactly five GETs and one HEAD to the fixed CivCom origin", async () => {
    const createPlan = (await loadProbe()).createAnonymousEndpointPlan;
    expect(typeof createPlan).toBe("function");
    const plan = createPlan!("confirmed");
    expect(plan).toEqual([
      { method: "GET", origin: "https://civcom.soia.info", path: "/", maxBytes: 262144 },
      { method: "GET", origin: "https://civcom.soia.info", path: "/version", maxBytes: 262144 },
      { method: "GET", origin: "https://civcom.soia.info", path: "/config.json", maxBytes: 262144 },
      { method: "GET", origin: "https://civcom.soia.info", path: "/manifest.json", maxBytes: 262144 },
      { method: "GET", origin: "https://civcom.soia.info", path: "/sw.js", maxBytes: 1048576 },
      { method: "HEAD", origin: "https://civcom.soia.info", path: "/", maxBytes: 0 }
    ]);
    expect(plan.every((entry) => !entry.path.includes("?") && ["GET", "HEAD"].includes(entry.method))).toBe(true);
  });

  it("validates TLS authorization and at least fourteen days of certificate life", async () => {
    const validateTls = (await loadProbe()).validateAnonymousTls;
    expect(typeof validateTls).toBe("function");
    const now = Date.parse("2026-08-19T00:00:00.000Z");
    expect(validateTls!({ authorized: true, authorizationError: null, protocol: "TLSv1.3", validTo: "Sep 20 00:00:00 2026 GMT", now })).toEqual({ kind: "accepted", code: "TLS_OK" });
    for (const input of [
      { authorized: false, authorizationError: "CERT_HAS_EXPIRED", protocol: "TLSv1.3", validTo: "Sep 20 00:00:00 2026 GMT", now },
      { authorized: true, authorizationError: null, protocol: "TLSv1.1", validTo: "Sep 20 00:00:00 2026 GMT", now },
      { authorized: true, authorizationError: null, protocol: "TLSv1.3", validTo: "Aug 25 00:00:00 2026 GMT", now }
    ]) expect(validateTls!(input).kind).toBe("rejected");
  });

  it("validates endpoint bodies without returning body or arbitrary header data", async () => {
    const validateResponse = (await loadProbe()).validateAnonymousEndpointResponse;
    expect(typeof validateResponse).toBe("function");
    const cases = [
      { path: "/", method: "GET", statusCode: 200, contentType: "text/html", body: "<!doctype html><meta name=referrer content=no-referrer><meta http-equiv=Content-Security-Policy content=default-src><div id=matrixchat></div>", expected: { kind: "accepted", code: "ROOT_OK" } },
      { path: "/version", method: "GET", statusCode: 200, contentType: "text/plain", body: "1.12.25\n", expected: { kind: "accepted", code: "VERSION_OK" } },
      { path: "/config.json", method: "GET", statusCode: 200, contentType: "application/json", body: JSON.stringify({ brand: "CivCom", default_server_config: { "m.homeserver": { base_url: "https://matrix.soia.info", server_name: "soia.info" } }, element_call: { url: "https://call.soia.info" }, permalink_prefix: "https://civcom.soia.info" }), expected: { kind: "accepted", code: "CONFIG_OK" } },
      { path: "/manifest.json", method: "GET", statusCode: 200, contentType: "application/manifest+json", body: JSON.stringify({ name: "Element", start_url: "/", icons: [{ src: "/icon.png" }] }), expected: { kind: "accepted", code: "MANIFEST_OK", warning: "MANIFEST_BRAND_PENDING" } },
      { path: "/sw.js", method: "GET", statusCode: 200, contentType: "application/javascript", body: "self.addEventListener('install',()=>{});self.addEventListener('activate',()=>{});self.addEventListener('fetch',()=>{});", expected: { kind: "accepted", code: "SERVICE_WORKER_OK" } },
      { path: "/", method: "HEAD", statusCode: 200, contentType: "text/html", body: "", expected: { kind: "accepted", code: "HEAD_OK" } }
    ];
    for (const fixture of cases) {
      const result = validateResponse!(fixture);
      expect(result).toEqual(fixture.expected);
      expect(result).not.toHaveProperty("body");
      expect(result).not.toHaveProperty("headers");
    }
  });

  it("rejects redirects, oversized/secret-bearing responses, and server-version drift", async () => {
    const validateResponse = (await loadProbe()).validateAnonymousEndpointResponse;
    expect(typeof validateResponse).toBe("function");
    for (const input of [
      { path: "/", method: "GET", statusCode: 302, contentType: "text/html", body: "" },
      { path: "/version", method: "GET", statusCode: 200, contentType: "text/plain", body: "1.12.26" },
      { path: "/config.json", method: "GET", statusCode: 200, contentType: "application/json", body: JSON.stringify({ brand: "CivCom", access_token: "fake" }) },
      { path: "/sw.js", method: "GET", statusCode: 200, contentType: "application/javascript", body: "x".repeat(1048577) }
    ]) {
      const result = validateResponse!(input);
      expect(result.kind).toBe("rejected");
      expect(JSON.stringify(result)).not.toContain("fake");
    }
  });

  it("executes the fixed HTTPS plan sequentially with no request body, retry, redirect, or credential header", async () => {
    const module = await loadProbe();
    const execute = module.executeAnonymousEndpointProbe;
    expect(typeof execute).toBe("function");
    const transport = fakeHttpsTransport();
    const result = await execute!({ optIn: "confirmed", request: transport.request, now: () => Date.parse("2026-08-19T00:00:00.000Z") });
    expect(result).toEqual({
      kind: "accepted",
      code: "ANONYMOUS_ENDPOINTS_OK",
      checks: ["ROOT_OK", "VERSION_OK", "CONFIG_OK", "MANIFEST_OK", "SERVICE_WORKER_OK", "HEAD_OK"],
      warnings: ["MANIFEST_BRAND_PENDING"]
    });
    expect(transport.options).toHaveLength(6);
    expect(transport.maxActive()).toBe(1);
    expect(transport.writes()).toBe(0);
    expect(transport.options.map((entry) => [entry.method, entry.hostname, entry.port, entry.path])).toEqual([
      ["GET", "civcom.soia.info", 443, "/"],
      ["GET", "civcom.soia.info", 443, "/version"],
      ["GET", "civcom.soia.info", 443, "/config.json"],
      ["GET", "civcom.soia.info", 443, "/manifest.json"],
      ["GET", "civcom.soia.info", 443, "/sw.js"],
      ["HEAD", "civcom.soia.info", 443, "/"]
    ]);
    for (const options of transport.options) {
      expect(options).toMatchObject({ protocol: "https:", rejectUnauthorized: true, minVersion: "TLSv1.2", maxVersion: "TLSv1.3", agent: false });
      expect(JSON.stringify(options)).not.toMatch(/authorization|cookie|proxy|referer|token/i);
    }
  });

  it("stops on the first redirect without retry and keeps the public runner argument-free", async () => {
    const module = await loadProbe();
    const execute = module.executeAnonymousEndpointProbe;
    const run = module.runAnonymousEndpointProbe;
    expect(typeof execute).toBe("function");
    expect(typeof run).toBe("function");
    expect(run).toHaveLength(0);
    const transport = fakeHttpsTransport(302);
    await expect(execute!({ optIn: "confirmed", request: transport.request, now: () => Date.parse("2026-08-19T00:00:00.000Z") })).resolves.toEqual({ kind: "rejected", code: "REDIRECT_REJECTED" });
    expect(transport.options).toHaveLength(1);
    await expect(execute!({ optIn: "wrong", request: () => { throw new Error("must-not-run"); }, now: () => 0 })).resolves.toEqual({ kind: "rejected", code: "OPT_IN_REQUIRED" });
  });

  it("applies one wall-clock deadline even when the transport never connects", async () => {
    vi.useFakeTimers();
    try {
      const execute = (await loadProbe()).executeAnonymousEndpointProbe;
      expect(typeof execute).toBe("function");
      const request = (): any => {
        const outgoing = new EventEmitter() as EventEmitter & { end(): void; destroy(): void; setTimeout(): unknown };
        outgoing.end = () => undefined;
        outgoing.destroy = () => undefined;
        outgoing.setTimeout = () => outgoing;
        return outgoing;
      };
      let result: unknown;
      void execute!({ optIn: "confirmed", request, now: () => 0 }).then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(result).toEqual({ kind: "rejected", code: "REQUEST_TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the absolute wall-clock deadline while a response drips data", async () => {
    vi.useFakeTimers();
    try {
      const execute = (await loadProbe()).executeAnonymousEndpointProbe;
      expect(typeof execute).toBe("function");
      const request = (_options: unknown, callback: (response: any) => void): any => {
        const outgoing = new EventEmitter() as EventEmitter & { end(): void; destroy(): void; setTimeout(): unknown };
        outgoing.destroy = () => undefined;
        outgoing.setTimeout = () => outgoing;
        outgoing.end = () => {
          queueMicrotask(() => {
            const socket = new EventEmitter() as EventEmitter & { authorized: boolean; authorizationError: null; getProtocol(): string; getPeerCertificate(): Readonly<{ valid_to: string }> };
            socket.authorized = true;
            socket.authorizationError = null;
            socket.getProtocol = () => "TLSv1.3";
            socket.getPeerCertificate = () => Object.freeze({ valid_to: "Sep 20 00:00:00 2030 GMT" });
            outgoing.emit("socket", socket);
            socket.emit("secureConnect");
            const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; setTimeout(): unknown; resume(): void };
            response.statusCode = 200;
            Object.setPrototypeOf(response, Object.create(Object.getPrototypeOf(response), {
              headers: { configurable: true, get: () => ({ "content-type": "text/html" }) }
            }));
            response.setTimeout = () => response;
            response.resume = () => undefined;
            callback(response);
            setInterval(() => response.emit("data", Buffer.from("x")), 500);
          });
        };
        return outgoing;
      };
      let result: unknown;
      void execute!({ optIn: "confirmed", request, now: () => Date.parse("2026-08-19T00:00:00.000Z") }).then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(result).toEqual({ kind: "rejected", code: "REQUEST_TIMEOUT" });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
