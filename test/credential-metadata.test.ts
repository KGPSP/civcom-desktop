import * as credentialMetadata from "../src/security/credential-metadata.js";
import { inspect } from "node:util";
import { describe, expect, test } from "vitest";

type CredentialMetadata = Readonly<{
  scope: string;
  purpose: string;
  fileMode: number;
}>;

type CredentialMetadataValidator = (metadata: unknown) => boolean;

type ManualCredentialResult =
  | Readonly<{
      kind: "accepted";
      credential: Readonly<{ adresTest: unknown; login: unknown; pass: unknown }>;
    }>
  | Readonly<{
      kind: "rejected";
      code: "invalid-metadata" | "invalid-format" | "duplicate-key" | "unexpected-key" | "empty-secret" | "invalid-route";
    }>;

type ManualCredentialParser = (text: string, metadata: CredentialMetadata) => ManualCredentialResult;
type RouteResolution =
  | Readonly<{ kind: "resolved"; url: string }>
  | Readonly<{ kind: "rejected"; code: "invalid-route" }>;

type RouteResolver = (route: unknown) => RouteResolution;

const validateCredentialMetadata = (
  credentialMetadata as unknown as {
    validateCredentialMetadata: CredentialMetadataValidator;
  }
).validateCredentialMetadata;

const parseManualCredentialText = (
  credentialMetadata as unknown as { parseManualCredentialText: ManualCredentialParser }
).parseManualCredentialText;

const resolveValidatedRoute = (
  credentialMetadata as unknown as { resolveValidatedRoute: RouteResolver }
).resolveValidatedRoute;

describe("validateCredentialMetadata", () => {
  test("accepts only local, manual metadata with owner-only permissions", () => {
    expect(
      validateCredentialMetadata({
        scope: "local",
        purpose: "interactive-manual-test",
        fileMode: 0o600
      })
    ).toBe(true);
  });

  test("rejects metadata that could permit automated credential use", () => {
    expect(
      validateCredentialMetadata({
        scope: "local",
        purpose: "automated-test",
        fileMode: 0o600
      })
    ).toBe(false);
  });

  test("rejects metadata for a non-local credential file", () => {
    expect(
      validateCredentialMetadata({
        scope: "ci",
        purpose: "interactive-manual-test",
        fileMode: 0o600
      })
    ).toBe(false);
  });

  test("rejects metadata for a group-readable credential file", () => {
    expect(
      validateCredentialMetadata({
        scope: "local",
        purpose: "interactive-manual-test",
        fileMode: 0o640
      })
    ).toBe(false);
  });
});

describe("parseManualCredentialText", () => {
  const validMetadata = Object.freeze({
    scope: "local",
    purpose: "interactive-manual-test",
    fileMode: 0o600
  });

  test("accepts exactly the local manual credentials and an opaque same-origin room route", () => {
    const result = parseManualCredentialText(
      [
        "adres_test=https://civcom.soia.info/#/room/!room-id:soia.info",
        "login=operator@example.org",
        "pass=correct-horse-battery-staple"
      ].join("\n"),
      validMetadata
    );

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") {
      return;
    }
    expect(resolveValidatedRoute(result.credential.adresTest)).toEqual({
      kind: "resolved",
      url: "https://civcom.soia.info/#/room/!room-id:soia.info"
    });
    const accidentalRepresentations = [
      String(result.credential.login),
      String(result.credential.pass),
      String(result.credential.adresTest),
      JSON.stringify(result),
      inspect(result)
    ].join("\n");
    for (const forbidden of [
      "operator@example.org",
      "correct-horse-battery-staple",
      "!room-id:soia.info"
    ]) {
      expect(accidentalRepresentations).not.toContain(forbidden);
    }
  });

  test("rejects missing-safe-metadata credential input", () => {
    expect(
      parseManualCredentialText(
        "adres_test=https://civcom.soia.info/\nlogin=operator\npass=secret",
        { scope: "ci", purpose: "interactive-manual-test", fileMode: 0o600 }
      )
    ).toEqual({ kind: "rejected", code: "invalid-metadata" });
  });

  test("returns a discriminated rejection for malformed metadata", () => {
    expect(() =>
      parseManualCredentialText(
        "adres_test=https://civcom.soia.info/\nlogin=operator\npass=secret",
        null as never
      )
    ).not.toThrow();
    expect(
      parseManualCredentialText(
        "adres_test=https://civcom.soia.info/\nlogin=operator\npass=secret",
        null as never
      )
    ).toEqual({ kind: "rejected", code: "invalid-metadata" });
  });

  test("accepts only plain metadata with own data descriptors", () => {
    const nullPrototype = Object.assign(Object.create(null), validMetadata);
    const inherited = Object.create(validMetadata);
    let getterReads = 0;
    const accessor = Object.defineProperties({}, {
      scope: {
        enumerable: true,
        get() {
          getterReads += 1;
          return "local";
        }
      },
      purpose: { value: "interactive-manual-test", enumerable: true },
      fileMode: { value: 0o600, enumerable: true }
    });
    const descriptorTrap = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("metadata descriptor trap");
      }
    });

    expect(validateCredentialMetadata(nullPrototype)).toBe(true);
    expect(validateCredentialMetadata(inherited)).toBe(false);
    expect(validateCredentialMetadata(accessor)).toBe(false);
    expect(getterReads).toBe(0);
    expect(() => validateCredentialMetadata(descriptorTrap)).not.toThrow();
    expect(validateCredentialMetadata(descriptorTrap)).toBe(false);
  });

  test("rejects duplicate, extra, and empty credential fields without returning their text", () => {
    expect(
      parseManualCredentialText(
        "adres_test=https://civcom.soia.info/\nlogin=operator\nlogin=other\npass=secret",
        validMetadata
      )
    ).toEqual({ kind: "rejected", code: "duplicate-key" });
    expect(
      parseManualCredentialText(
        "adres_test=https://civcom.soia.info/\nlogin=operator\npass=secret\ntrace=true",
        validMetadata
      )
    ).toEqual({ kind: "rejected", code: "unexpected-key" });
    expect(
      parseManualCredentialText(
        "adres_test=https://civcom.soia.info/\nlogin=operator\npass=",
        validMetadata
      )
    ).toEqual({ kind: "rejected", code: "empty-secret" });
  });

  test("rejects a route with a query but permits the same CivCom path and fragment", () => {
    expect(
      parseManualCredentialText(
        "adres_test=https://civcom.soia.info/?token=not-allowed\nlogin=operator\npass=secret",
        validMetadata
      )
    ).toEqual({ kind: "rejected", code: "invalid-route" });
    expect(
      parseManualCredentialText(
        "adres_test=https://civcom.soia.info/#/room/opaque?access_token=not-allowed\nlogin=operator\npass=secret",
        validMetadata
      )
    ).toEqual({ kind: "rejected", code: "invalid-route" });
  });

  test("rejects unsafe control and whitespace tricks without echoing credentials", () => {
    for (const text of [
      "adres_test=https://civcom.soia.info/\nlogin=operator\t\npass=secret",
      "adres_test=https://civcom.soia.info/\rlogin=operator\npass=secret",
      "adres_test=https://civcom.soia.info/\nlogin=operator\npass=secret\u0000",
      "adres_test=https://civcom.soia.info/\nlogin=operator\npass=secret\u007f",
      "adres_test= https://civcom.soia.info/\nlogin=operator\npass=secret",
      "adres_test=https://civcom.soia.info/\nlogin =operator\npass=secret"
    ]) {
      const result = parseManualCredentialText(text, validMetadata);
      expect(result.kind).toBe("rejected");
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  test("keeps CRLF parsing while refusing forged route objects without invoking them", () => {
    const result = parseManualCredentialText(
      "adres_test=https://civcom.soia.info/room\r\nlogin=operator\r\npass=secret\r\n",
      validMetadata
    );
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") {
      return;
    }
    expect(resolveValidatedRoute(result.credential.adresTest)).toEqual({
      kind: "resolved",
      url: "https://civcom.soia.info/room"
    });

    let maliciousCalls = 0;
    const forged = {
      resolve() {
        maliciousCalls += 1;
        return "https://evil.example/";
      },
      toString: () => "[CivCom route]",
      toJSON: () => "[CivCom route]"
    };
    const structural = { toString: () => "[CivCom route]", toJSON: () => "[CivCom route]" };
    const hostileProxy = new Proxy({}, {
      get() {
        throw new Error("route getter must not run");
      }
    });
    expect(resolveValidatedRoute(forged)).toEqual({ kind: "rejected", code: "invalid-route" });
    expect(maliciousCalls).toBe(0);
    expect(resolveValidatedRoute(structural)).toEqual({ kind: "rejected", code: "invalid-route" });
    expect(() => resolveValidatedRoute(hostileProxy)).not.toThrow();
    expect(resolveValidatedRoute(hostileProxy)).toEqual({ kind: "rejected", code: "invalid-route" });
  });
});
