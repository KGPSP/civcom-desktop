import * as urlPolicy from "../src/security/url-policy.js";
import { describe, expect, test } from "vitest";

type StartUrlResult =
  | Readonly<{ kind: "allow"; url: string; source: "production" | "development" }>
  | Readonly<{ kind: "deny"; code: "invalid-development-url" }>;

type OriginResult =
  | Readonly<{ kind: "trusted"; service: "civcom" | "auth" | "matrix" | "call" }>
  | Readonly<{ kind: "untrusted"; code: "invalid-url" | "untrusted-origin" }>;

type NavigationResult =
  | Readonly<{ kind: "allow"; service: "civcom" | "auth" }>
  | Readonly<{ kind: "deny"; code: "invalid-url" | "untrusted-origin" }>;

type ExternalProtocolResult =
  | Readonly<{ kind: "allow"; protocol: "https:" | "mailto:" }>
  | Readonly<{ kind: "deny"; code: "invalid-url" | "unsafe-protocol" }>;

type PermissionDecision =
  | Readonly<{
      kind: "allow";
      permission: "media" | "notifications" | "fullscreen" | "clipboard-sanitized-write";
    }>
  | Readonly<{ kind: "deny"; code: "untrusted-origin" | "unknown-permission" }>;

type DisplayMediaDecision =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "deny"; code: "untrusted-origin" | "missing-user-gesture" }>;

type UrlPolicy = Readonly<{
  PRODUCTION_CIVCOM_URL: string;
  resolveStartUrl(input: unknown): StartUrlResult;
  classifyTrustedOrigin(url: unknown): OriginResult;
  authorizeTopLevelNavigation(url: unknown): NavigationResult;
  authorizeExternalProtocol(url: unknown): ExternalProtocolResult;
  authorizePermissionRequest(input: unknown): PermissionDecision;
  authorizeDisplayMediaRequest(input: unknown): DisplayMediaDecision;
}>;

const policy = urlPolicy as unknown as UrlPolicy;

describe("start URL policy", () => {
  test("keeps the packaged client on the immutable CivCom production URL", () => {
    expect(
      policy.resolveStartUrl({
        isPackaged: true,
        developmentUrl: "https://civcom.soia.info.evil/redirect"
      })
    ).toEqual({
      kind: "allow",
      source: "production",
      url: "https://civcom.soia.info/"
    });
  });

  test("allows an unpackaged loopback development harness only", () => {
    expect(
      policy.resolveStartUrl({ isPackaged: false, developmentUrl: "http://127.0.0.1:4173/" })
    ).toEqual({ kind: "allow", source: "development", url: "http://127.0.0.1:4173/" });
    expect(
      policy.resolveStartUrl({ isPackaged: false, developmentUrl: "https://[::1]:4173/" })
    ).toEqual({ kind: "allow", source: "development", url: "https://[::1]:4173/" });
    expect(
      policy.resolveStartUrl({ isPackaged: false, developmentUrl: "http://localhost:4173/" })
    ).toEqual({ kind: "allow", source: "development", url: "http://localhost:4173/" });
  });

  test("rejects non-loopback or credentialed development harness URLs", () => {
    for (const developmentUrl of [
      "https://civcom.soia.info/",
      "http://localhost.evil:4173/",
      "file:///tmp/harness.html",
      "http://operator:secret@127.0.0.1:4173/",
      "http://localhost:4173/\tpath",
      "http://localhost:4173/\npath"
    ]) {
      expect(policy.resolveStartUrl({ isPackaged: false, developmentUrl })).toEqual({
        kind: "deny",
        code: "invalid-development-url"
      });
    }
  });
});

describe("trusted origin policy", () => {
  test("recognizes only the four exact HTTPS service origins", () => {
    expect(policy.classifyTrustedOrigin("https://civcom.soia.info/rooms")).toEqual({
      kind: "trusted",
      service: "civcom"
    });
    expect(policy.classifyTrustedOrigin("https://auth.soia.info/login")).toEqual({
      kind: "trusted",
      service: "auth"
    });
    expect(policy.classifyTrustedOrigin("https://matrix.soia.info/_matrix/client")).toEqual({
      kind: "trusted",
      service: "matrix"
    });
    expect(policy.classifyTrustedOrigin("https://call.soia.info/")).toEqual({
      kind: "trusted",
      service: "call"
    });
  });

  test("rejects lookalikes, userinfo, custom ports, encoded authorities, and malformed URLs", () => {
    for (const url of [
      "https://civcom.soia.info.evil/",
      "https://civcom.soia.info@evil.example/",
      "https://operator@civcom.soia.info/",
      "https://civcom.soia.info:444/",
      "https://civcom%2esoia.info/",
      "https://cіvcom.soia.info/",
      "https://xn--cvcom-5cd.soia.info/",
      "https://civcom.soia.info\\evil",
      "https://civcom.soia.info/\tpath",
      "https://civcom.soia.info/\npath",
      "http://civcom.soia.info/",
      "https:\\civcom.soia.info/",
      "not a URL"
    ]) {
      expect(policy.classifyTrustedOrigin(url).kind).toBe("untrusted");
    }
  });
});

describe("navigation protocol policy", () => {
  test("limits top-level navigation to CivCom and its authentication origin", () => {
    expect(policy.authorizeTopLevelNavigation("https://civcom.soia.info/#/room/opaque")).toEqual({
      kind: "allow",
      service: "civcom"
    });
    expect(policy.authorizeTopLevelNavigation("https://auth.soia.info/login")).toEqual({
      kind: "allow",
      service: "auth"
    });
    expect(policy.authorizeTopLevelNavigation("https://matrix.soia.info/_matrix/client")).toEqual({
      kind: "deny",
      code: "untrusted-origin"
    });
    expect(policy.authorizeTopLevelNavigation("https://call.soia.info/")).toEqual({
      kind: "deny",
      code: "untrusted-origin"
    });
  });

  test("allows only HTTPS and mailto external protocols", () => {
    expect(policy.authorizeExternalProtocol("https://example.org/docs")).toEqual({
      kind: "allow",
      protocol: "https:"
    });
    expect(policy.authorizeExternalProtocol("mailto:service@example.org")).toEqual({
      kind: "allow",
      protocol: "mailto:"
    });
    expect(policy.authorizeExternalProtocol("mailto:service@example.org?subject=Bezpieczny%20temat")).toEqual({
      kind: "allow",
      protocol: "mailto:"
    });
    for (const url of [
      "mailto:service@example.org?subject=100%25",
      "mailto:service@example.org?subject=100%2525",
      "mailto:service@example.org?subject=100%25zz",
      "mailto:service@example.org?subject=%C5%BC%C3%B3%C5%82%C4%87"
    ]) {
      expect(policy.authorizeExternalProtocol(url)).toEqual({ kind: "allow", protocol: "mailto:" });
    }
    for (const url of ["http://example.org/", "javascript:alert(1)", "file:///tmp/a", "matrix:r/example"]) {
      expect(policy.authorizeExternalProtocol(url)).toEqual({
        kind: "deny",
        code: "unsafe-protocol"
      });
    }
  });

  test("rejects raw URL controls, backslashes, and mailto header-injection encodings", () => {
    for (const url of [
      "https://example.org/\tpath",
      "https://example.org/\npath",
      "https://example.org\\path",
      "mailto:service@example.org\r\nBcc:attacker@example.org",
      "mailto:service@example.org%0d%0aBcc:attacker@example.org",
      "mailto:service@example.org%00",
      "mailto:service@example.org%250d%250aBcc:attacker@example.org",
      "mailto:service@example.org%25250Abcc:attacker@example.org",
      "mailto:service@example.org%25250aBcc:attacker@example.org",
      "mailto:service@example.org%255cBcc:attacker@example.org",
      "mailto:service@example.org%2",
      "mailto:service@example.org?subject=100%2525%25250a",
      "mailto:service@example.org?subject=%FF"
    ]) {
      expect(policy.authorizeExternalProtocol(url)).toEqual({ kind: "deny", code: "unsafe-protocol" });
    }
  });
});

describe("total policy boundaries", () => {
  test("fails closed for malformed start-url records without invoking getters or proxy traps", () => {
    let getterReads = 0;
    const accessor = Object.defineProperty({}, "isPackaged", {
      get() {
        getterReads += 1;
        return true;
      }
    });
    const hostileProxy = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("start-url descriptor trap");
      }
    });
    const prototypeTrapProxy = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("start-url prototype trap");
      }
    });
    let developmentGetterReads = 0;
    const developmentAccessor = Object.defineProperties({}, {
      isPackaged: { value: false },
      developmentUrl: {
        get() {
          developmentGetterReads += 1;
          return "http://127.0.0.1:4173/";
        }
      }
    });

    for (const input of [
      null,
      undefined,
      "true",
      1,
      [],
      accessor,
      developmentAccessor,
      Object.freeze({ isPackaged: "true" }),
      Object.create({ isPackaged: true }),
      prototypeTrapProxy,
      hostileProxy
    ]) {
      expect(() => policy.resolveStartUrl(input)).not.toThrow();
      expect(policy.resolveStartUrl(input)).toEqual({ kind: "deny", code: "invalid-development-url" });
    }
    expect(getterReads).toBe(0);
    expect(developmentGetterReads).toBe(0);
    expect(policy.resolveStartUrl(Object.freeze({ isPackaged: true }))).toEqual({
      kind: "allow",
      source: "production",
      url: "https://civcom.soia.info/"
    });
  });

  test("fails closed for non-string navigation and external URL inputs", () => {
    const hostileProxy = new Proxy({}, {
      get() {
        throw new Error("URL coercion must not run");
      }
    });
    let getterReads = 0;
    const accessor = Object.defineProperty({}, "toString", {
      get() {
        getterReads += 1;
        throw new Error("URL getter must not run");
      }
    });
    for (const value of [null, undefined, 1, [], {}, accessor, hostileProxy]) {
      expect(() => policy.classifyTrustedOrigin(value)).not.toThrow();
      expect(policy.classifyTrustedOrigin(value)).toEqual({ kind: "untrusted", code: "invalid-url" });
      expect(() => policy.authorizeTopLevelNavigation(value)).not.toThrow();
      expect(policy.authorizeTopLevelNavigation(value)).toEqual({ kind: "deny", code: "invalid-url" });
      expect(() => policy.authorizeExternalProtocol(value)).not.toThrow();
      expect(policy.authorizeExternalProtocol(value)).toEqual({ kind: "deny", code: "invalid-url" });
    }
    expect(getterReads).toBe(0);
  });

  test("reads only own data descriptors for permission and display-media records", () => {
    let getterReads = 0;
    const accessor = Object.defineProperties({}, {
      origin: {
        get() {
          getterReads += 1;
          return "https://civcom.soia.info/";
        }
      },
      permission: { value: "media" },
      userGesture: { value: true }
    });
    const inherited = Object.create({
      origin: "https://civcom.soia.info/",
      permission: "media",
      userGesture: true
    });
    const hostileProxy = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("permission descriptor trap");
      }
    });

    for (const input of [null, undefined, "record", 1, [], accessor, inherited, hostileProxy]) {
      expect(() => policy.authorizePermissionRequest(input)).not.toThrow();
      expect(policy.authorizePermissionRequest(input)).toEqual({ kind: "deny", code: "untrusted-origin" });
      expect(() => policy.authorizeDisplayMediaRequest(input)).not.toThrow();
      expect(policy.authorizeDisplayMediaRequest(input)).toEqual({ kind: "deny", code: "untrusted-origin" });
    }
    expect(getterReads).toBe(0);
    expect(policy.authorizePermissionRequest({ origin: "https://civcom.soia.info/", permission: "media" })).toEqual({
      kind: "allow",
      permission: "media"
    });
    expect(policy.authorizeDisplayMediaRequest({ origin: "https://civcom.soia.info/", userGesture: true })).toEqual({ kind: "allow" });
  });
});

describe("permission policy", () => {
  test("allows only the required permission categories for CivCom and Element Call", () => {
    for (const origin of ["https://civcom.soia.info/", "https://call.soia.info/"]) {
      for (const permission of ["media", "notifications", "fullscreen", "clipboard-sanitized-write"]) {
        expect(policy.authorizePermissionRequest({ origin, permission })).toEqual({
          kind: "allow",
          permission
        });
      }
    }
  });

  test("denies every permission from auth, matrix, unknown, and hostile origins", () => {
    for (const origin of [
      "https://auth.soia.info/login",
      "https://matrix.soia.info/_matrix/client",
      "https://civcom.soia.info.evil/",
      "https://operator@civcom.soia.info/"
    ]) {
      expect(policy.authorizePermissionRequest({ origin, permission: "media" })).toEqual({
        kind: "deny",
        code: "untrusted-origin"
      });
    }
  });

  test("denies unknown permissions even for CivCom", () => {
    expect(
      policy.authorizePermissionRequest({ origin: "https://civcom.soia.info/", permission: "geolocation" })
    ).toEqual({ kind: "deny", code: "unknown-permission" });
  });

  test("requires both an exact CivCom or Call origin and a user gesture for display capture", () => {
    expect(
      policy.authorizeDisplayMediaRequest({ origin: "https://civcom.soia.info/#/room/opaque", userGesture: true })
    ).toEqual({ kind: "allow" });
    expect(
      policy.authorizeDisplayMediaRequest({ origin: "https://call.soia.info/", userGesture: true })
    ).toEqual({ kind: "allow" });
    expect(
      policy.authorizeDisplayMediaRequest({ origin: "https://civcom.soia.info/", userGesture: false })
    ).toEqual({ kind: "deny", code: "missing-user-gesture" });
    expect(
      policy.authorizeDisplayMediaRequest({ origin: "https://auth.soia.info/", userGesture: true })
    ).toEqual({ kind: "deny", code: "untrusted-origin" });
    for (const userGesture of ["true", 1, {}, new Boolean(true)]) {
      expect(
        policy.authorizeDisplayMediaRequest({ origin: "https://civcom.soia.info/", userGesture })
      ).toEqual({ kind: "deny", code: "missing-user-gesture" });
    }
  });
});
