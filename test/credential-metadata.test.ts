import * as credentialMetadata from "../src/security/credential-metadata.js";
import { describe, expect, test } from "vitest";

type CredentialMetadata = Readonly<{
  scope: string;
  purpose: string;
  fileMode: number;
}>;

type CredentialMetadataValidator = (metadata: CredentialMetadata) => boolean;

const validateCredentialMetadata = (
  credentialMetadata as unknown as {
    validateCredentialMetadata: CredentialMetadataValidator;
  }
).validateCredentialMetadata;

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
