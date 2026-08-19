import { describe, expect, it } from "vitest";
import {
  authorizeDisplayMediaRequestSnapshot,
  selectDisplayMediaRoute
} from "../src/screen-share/policy.js";
import {
  createOpaqueSourceCatalog,
  type CaptureSourceCandidate
} from "../src/screen-share/source-catalog.js";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    frame: { id: "frame" },
    securityOrigin: "https://civcom.soia.info",
    userGesture: true,
    videoRequested: true,
    audioRequested: false,
    ...overrides
  };
}

describe("display-media request policy", () => {
  it("requires an exact approved origin, an exact user gesture, video, audio boolean, and a live-looking frame", () => {
    expect(authorizeDisplayMediaRequestSnapshot(request())).toMatchObject({ kind: "allow", audioRequested: false });
    expect(authorizeDisplayMediaRequestSnapshot(request({ securityOrigin: "https://call.soia.info", audioRequested: true }))).toMatchObject({ kind: "allow", audioRequested: true });

    for (const overrides of [
      { securityOrigin: "https://civcom.soia.info/" },
      { securityOrigin: "https://civcom.soia.info/room/a" },
      { securityOrigin: "https://auth.soia.info" },
      { securityOrigin: "https://call.soia.info.evil" },
      { userGesture: "true" },
      { userGesture: false },
      { videoRequested: false },
      { videoRequested: 1 },
      { audioRequested: "false" },
      { frame: null }
    ]) {
      expect(authorizeDisplayMediaRequestSnapshot(request(overrides))).toEqual({ kind: "deny" });
    }
  });

  it("is total for null, primitive, inherited, accessor, throwing, and revoked request shapes", () => {
    let getterReads = 0;
    const accessor = Object.defineProperties({}, {
      frame: { value: {} },
      securityOrigin: { get: () => { getterReads += 1; return "https://civcom.soia.info"; } },
      userGesture: { value: true },
      videoRequested: { value: true },
      audioRequested: { value: false }
    });
    const inherited = Object.create(request());
    const throwing = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const revokedFrame = Proxy.revocable({}, {});
    revokedFrame.revoke();

    for (const value of [null, undefined, true, 1, "request", [], inherited, accessor, throwing, revocable.proxy]) {
      expect(() => authorizeDisplayMediaRequestSnapshot(value)).not.toThrow();
      expect(authorizeDisplayMediaRequestSnapshot(value)).toEqual({ kind: "deny" });
    }
    expect(() => authorizeDisplayMediaRequestSnapshot(request({ frame: revokedFrame.proxy }))).not.toThrow();
    expect(authorizeDisplayMediaRequestSnapshot(request({ frame: revokedFrame.proxy }))).toEqual({ kind: "deny" });
    expect(getterReads).toBe(0);
  });
});

describe("display-media platform routing", () => {
  it("uses the macOS 15 system picker and local pickers for macOS 13/14 and Windows", () => {
    expect(selectDisplayMediaRoute({ platform: "darwin", systemVersion: "15.0" })).toBe("system-picker");
    expect(selectDisplayMediaRoute({ platform: "darwin", systemVersion: "16.2.1" })).toBe("system-picker");
    expect(selectDisplayMediaRoute({ platform: "darwin", systemVersion: "14.7.2" })).toBe("local-picker");
    expect(selectDisplayMediaRoute({ platform: "darwin", systemVersion: "13" })).toBe("local-picker");
    expect(selectDisplayMediaRoute({ platform: "win32" })).toBe("local-picker");
  });

  it("distinguishes Wayland portal from X11 and denies malformed or unsupported environments", () => {
    expect(selectDisplayMediaRoute({ platform: "linux", sessionType: "wayland" })).toBe("wayland-portal");
    expect(selectDisplayMediaRoute({ platform: "linux", sessionType: "x11" })).toBe("local-picker");
    for (const value of [
      { platform: "darwin", systemVersion: "15beta" },
      { platform: "darwin", systemVersion: "12.6" },
      { platform: "darwin", systemVersion: 15 },
      { platform: "linux", sessionType: "Wayland" },
      { platform: "linux", sessionType: "" },
      { platform: "freebsd" },
      Object.create({ platform: "win32" }),
      new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } })
    ]) {
      expect(() => selectDisplayMediaRoute(value)).not.toThrow();
      expect(selectDisplayMediaRoute(value)).toBe("deny");
    }
  });

  it("uses only the injected system-version snapshot and rejects an accessor without reading it", () => {
    let reads = 0;
    const environment = Object.defineProperties({}, {
      platform: { value: "darwin" },
      systemVersion: { get: () => { reads += 1; throw new Error("global-like adapter"); } }
    });
    expect(selectDisplayMediaRoute(environment)).toBe("deny");
    expect(reads).toBe(0);
    expect(selectDisplayMediaRoute({ platform: "darwin", systemVersion: "15.4" })).toBe("system-picker");
  });
});

describe("opaque source catalog", () => {
  const firstToken = "A".repeat(43);
  const secondToken = "B".repeat(43);
  const screen = { capture: "screen" };
  const windowSource = { capture: "window" };

  function candidates(): readonly CaptureSourceCandidate<object>[] {
    return [
      { source: screen, id: "screen:44:0", name: "Monitor <b>alarm</b>\u0000", thumbnailDataUrl: "data:image/png;base64,AA==" },
      { source: windowSource, id: "window:55:0", name: "W".repeat(200), thumbnailDataUrl: "javascript:alert(1)" }
    ];
  }

  it("maps opaque current tokens to originals without exposing raw capture identifiers", () => {
    const tokens = [firstToken, secondToken];
    const catalog = createOpaqueSourceCatalog(7, candidates(), () => tokens.shift() ?? "C".repeat(43));
    expect(catalog.sources).toEqual([
      { token: firstToken, name: "Monitor <b>alarm</b>�", kind: "screen", thumbnailDataUrl: "data:image/png;base64,AA==" },
      { token: secondToken, name: "W".repeat(120), kind: "window" }
    ]);
    expect(JSON.stringify(catalog.sources)).not.toContain("screen:44:0");
    expect(catalog.resolve({ generation: 7, token: firstToken })).toMatchObject({ source: screen, id: "screen:44:0" });
    expect(catalog.resolve({ generation: 7, token: secondToken })).toMatchObject({ source: windowSource, id: "window:55:0" });
  });

  it("denies unknown, stale, inherited, accessor, proxy, malformed, and raw source selections without throwing", () => {
    const catalog = createOpaqueSourceCatalog(9, candidates(), () => firstToken);
    const accessor = Object.defineProperties({}, { generation: { value: 9 }, token: { get: () => firstToken } });
    const inherited = Object.create({ generation: 9, token: firstToken });
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    for (const selection of [
      firstToken,
      "screen:44:0",
      { generation: 8, token: firstToken },
      { generation: 9, token: "Z".repeat(43) },
      { generation: 9, token: "short" },
      inherited,
      accessor,
      hostile,
      null
    ]) {
      expect(() => catalog.resolve(selection)).not.toThrow();
      expect(catalog.resolve(selection)).toBeUndefined();
    }
    catalog.clear();
    expect(catalog.sources).toEqual([]);
    expect(catalog.resolve({ generation: 9, token: firstToken })).toBeUndefined();
  });

  it("totally sanitizes hostile source lists and bounds thumbnails", () => {
    const throwing = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("source trap"); } });
    const longThumbnail = `data:image/png;base64,${"A".repeat(600_000)}`;
    expect(() => createOpaqueSourceCatalog(1, [throwing as never, { source: {}, id: "screen:1:0", name: 7, thumbnailDataUrl: longThumbnail }], () => firstToken)).not.toThrow();
    expect(createOpaqueSourceCatalog(1, [throwing as never, { source: {}, id: "screen:1:0", name: 7, thumbnailDataUrl: longThumbnail }], () => firstToken).sources).toEqual([]);
  });
});
