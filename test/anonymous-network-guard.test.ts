import { describe, expect, it } from "vitest";

type GuardModule = Readonly<{
  createAnonymousProductionNetworkGuard?: () => Readonly<{
    request(input: unknown): Readonly<{ kind: "allow" | "block"; code: string }>;
    headers(input: unknown): Readonly<{ kind: "allow" | "block"; code: string }>;
  }>;
  createLoopbackNetworkGuard?: (origins: readonly string[]) => Readonly<{
    request(input: unknown): Readonly<{ kind: "allow" | "block"; code: string }>;
    headers(input: unknown): Readonly<{ kind: "allow" | "block"; code: string }>;
  }>;
  authorizeAnonymousBootstrapSequence?: (events: readonly string[]) => Readonly<{ kind: "allow" | "block"; code: string }>;
  createAnonymousMemoryPartition?: (entropy: Uint8Array) => string;
  decideElectronRequest?: (guard: Readonly<{ request(input: unknown): Readonly<{ kind: "allow" | "block"; code: string }> }>, details: unknown, redirected?: boolean) => Readonly<{ kind: "allow" | "block"; code: string }>;
}>;

async function loadGuard(): Promise<GuardModule> {
  return await import(new URL("./support/anonymous-network-guard.mjs", import.meta.url).href).catch(() => Object.freeze({})) as GuardModule;
}

describe("anonymous production network boundary", () => {
  it("allows only GET and HEAD without upload data on exact approved origins", async () => {
    const createGuard = (await loadGuard()).createAnonymousProductionNetworkGuard;
    expect(typeof createGuard).toBe("function");
    expect(createGuard).toHaveLength(0);
    const guard = createGuard!();

    expect(guard.request({ method: "GET", url: "https://civcom.soia.info/config.json", resourceType: "xhr" })).toEqual({ kind: "allow", code: "SAFE_GET" });
    expect(guard.request({ method: "HEAD", url: "https://matrix.soia.info/", resourceType: "other" })).toEqual({ kind: "allow", code: "SAFE_HEAD" });
    for (const input of [
      { method: "POST", url: "https://civcom.soia.info/", resourceType: "xhr" },
      { method: "PUT", url: "https://civcom.soia.info/", resourceType: "xhr" },
      { method: "OPTIONS", url: "https://civcom.soia.info/", resourceType: "xhr" },
      { method: "GET", url: "https://civcom.soia.info/", resourceType: "xhr", uploadData: [] },
      { method: "GET", url: "https://civcom.soia.info.evil.invalid/", resourceType: "script" },
      { method: "GET", url: "https://user@civcom.soia.info/", resourceType: "script" },
      { method: "GET", url: "https://civcom.soia.info:444/", resourceType: "script" },
      { method: "GET", url: "https://call.soia.info/", resourceType: "script" },
      { method: "GET", url: "https://example.org/", resourceType: "script" }
    ]) expect(guard.request(input).kind).toBe("block");
  });

  it("permits only an explicit HTTP 127.0.0.1 origin for the local guard fixture", async () => {
    const createGuard = (await loadGuard()).createLoopbackNetworkGuard;
    expect(typeof createGuard).toBe("function");
    const guard = createGuard!(["http://127.0.0.1:43123"]);
    expect(guard.request({ method: "GET", url: "http://127.0.0.1:43123/fixture.js", resourceType: "script" })).toEqual({ kind: "allow", code: "SAFE_GET" });
    expect(() => createGuard!(["http://localhost:43123"])).toThrowError("INVALID_ORIGINS");
    expect(() => createGuard!(["http://127.0.0.1:0"])).toThrowError("INVALID_ORIGINS");
  });

  it("blocks WebSocket, ping, CSP reports, redirects, and credential-bearing queries", async () => {
    const createGuard = (await loadGuard()).createAnonymousProductionNetworkGuard;
    expect(typeof createGuard).toBe("function");
    const guard = createGuard!();
    for (const input of [
      { method: "GET", url: "https://civcom.soia.info/socket", resourceType: "webSocket" },
      { method: "GET", url: "https://civcom.soia.info/ping", resourceType: "ping" },
      { method: "POST", url: "https://civcom.soia.info/report", resourceType: "cspReport" },
      { method: "GET", url: "https://civcom.soia.info/next", resourceType: "mainFrame", redirected: true },
      { method: "GET", url: "https://civcom.soia.info/?access_token=fake", resourceType: "xhr" },
      { method: "GET", url: "https://civcom.soia.info/?code=fake", resourceType: "xhr" },
      { method: "GET", url: "https://civcom.soia.info/?next=Bearer%20fake", resourceType: "xhr" },
      { method: "GET", url: "https://civcom.soia.info/?loginToken=fake", resourceType: "xhr" }
    ]) expect(guard.request(input).kind).toBe("block");
  });

  it("cancels Authorization and Cookie headers without returning their values", async () => {
    const createGuard = (await loadGuard()).createAnonymousProductionNetworkGuard;
    expect(typeof createGuard).toBe("function");
    const guard = createGuard!();
    expect(guard.headers({ requestHeaders: { Accept: "text/html" } })).toEqual({ kind: "allow", code: "SAFE_HEADERS" });
    for (const requestHeaders of [
      { Authorization: "Bearer fake-secret" },
      { authorization: "Basic fake-secret" },
      { Cookie: "session=fake-secret" },
      { cookie: "session=fake-secret" }
    ]) {
      const result = guard.headers({ requestHeaders });
      expect(result).toEqual({ kind: "block", code: "CREDENTIAL_HEADER" });
      expect(JSON.stringify(result)).not.toContain("fake-secret");
    }
  });

  it("is total for hostile values and never invokes accessors", async () => {
    const createGuard = (await loadGuard()).createAnonymousProductionNetworkGuard;
    expect(typeof createGuard).toBe("function");
    const guard = createGuard!();
    let reads = 0;
    const accessor = Object.defineProperty({}, "url", { get() { reads += 1; throw new Error("must-not-run"); } });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("descriptor-trap"); } });
    for (const value of [undefined, null, 1, "x", [], accessor, proxy]) {
      expect(() => guard.request(value)).not.toThrow();
      expect(guard.request(value).kind).toBe("block");
      expect(() => guard.headers(value)).not.toThrow();
      expect(guard.headers(value).kind).toBe("block");
    }
    expect(reads).toBe(0);
  });

  it("requires the main-process guard before window creation and rejects Playwright routing as the boundary", async () => {
    const authorize = (await loadGuard()).authorizeAnonymousBootstrapSequence;
    expect(typeof authorize).toBe("function");
    expect(authorize!(["opt-in", "paths", "memory-session", "tls", "guard", "window", "listeners", "navigate"])).toEqual({ kind: "allow", code: "SAFE_SEQUENCE" });
    expect(authorize!(["opt-in", "paths", "memory-session", "guard", "window", "listeners", "navigate"])).toEqual({ kind: "block", code: "UNSAFE_SEQUENCE" });
    expect(authorize!(["opt-in", "paths", "memory-session", "window", "playwright-route", "guard", "navigate"])).toEqual({ kind: "block", code: "UNSAFE_SEQUENCE" });
    expect(authorize!(["opt-in", "paths", "memory-session", "guard", "window", "navigate", "listeners"])).toEqual({ kind: "block", code: "UNSAFE_SEQUENCE" });
  });

  it("creates a bounded non-persistent partition from fixed entropy", async () => {
    const createPartition = (await loadGuard()).createAnonymousMemoryPartition;
    expect(typeof createPartition).toBe("function");
    const partition = createPartition!(Uint8Array.from({ length: 16 }, (_, index) => index));
    expect(partition).toBe("civcom-anonymous-000102030405060708090a0b0c0d0e0f");
    expect(partition.startsWith("persist:")).toBe(false);
    expect(() => createPartition!(new Uint8Array(15))).toThrowError("INVALID_ENTROPY");
  });

  it("preserves any own uploadData presence when adapting Electron request details", async () => {
    const module = await loadGuard();
    const createGuard = module.createAnonymousProductionNetworkGuard;
    const decide = module.decideElectronRequest;
    expect(typeof createGuard).toBe("function");
    expect(typeof decide).toBe("function");
    const guard = createGuard!();
    const base = { method: "GET", url: "https://civcom.soia.info/", resourceType: "mainFrame" };
    expect(decide!(guard, base)).toEqual({ kind: "allow", code: "SAFE_GET" });
    expect(decide!(guard, { ...base, uploadData: [] })).toEqual({ kind: "block", code: "REQUEST_BODY" });
    expect(decide!(guard, { ...base, uploadData: undefined })).toEqual({ kind: "block", code: "REQUEST_BODY" });
    const accessor = Object.defineProperty({ ...base }, "uploadData", { get: () => [] });
    expect(decide!(guard, accessor)).toEqual({ kind: "block", code: "INVALID_REQUEST" });
    expect(decide!(guard, new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } }))).toEqual({ kind: "block", code: "INVALID_REQUEST" });
  });
});
