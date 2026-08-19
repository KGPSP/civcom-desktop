import * as credentialMetadata from "../src/security/credential-metadata.js";
import { inspect } from "node:util";
import { describe, expect, test } from "vitest";

type CredentialMetadata = Readonly<{
  scope: string;
  purpose: string;
  fileMode: number;
}>;

type CredentialMetadataValidator = (metadata: CredentialMetadata) => boolean;

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
type RouteResolver = (route: unknown) => string;

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
    expect(resolveValidatedRoute(result.credential.adresTest)).toBe(
      "https://civcom.soia.info/#/room/!room-id:soia.info"
    );
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
  });
});
