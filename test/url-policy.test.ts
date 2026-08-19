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
  resolveStartUrl(input: Readonly<{ isPackaged: boolean; developmentUrl?: string }>): StartUrlResult;
  classifyTrustedOrigin(url: string): OriginResult;
  authorizeTopLevelNavigation(url: string): NavigationResult;
  authorizeExternalProtocol(url: string): ExternalProtocolResult;
  authorizePermissionRequest(input: Readonly<{ origin: string; permission: string }>): PermissionDecision;
  authorizeDisplayMediaRequest(input: Readonly<{ origin: string; userGesture: boolean }>): DisplayMediaDecision;
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
      "http://operator:secret@127.0.0.1:4173/"
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
    for (const url of ["http://example.org/", "javascript:alert(1)", "file:///tmp/a", "matrix:r/example"]) {
      expect(policy.authorizeExternalProtocol(url)).toEqual({
        kind: "deny",
        code: "unsafe-protocol"
      });
    }
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
  });
});
