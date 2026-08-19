import * as credentialMetadata from "../src/security/credential-metadata.js";
import { describe, expect, test } from "vitest";

describe("production credential metadata boundary", () => {
  test("accepts only local interactive metadata with owner-only permissions", () => {
    expect(credentialMetadata.validateCredentialMetadata({
      scope: "local",
      purpose: "interactive-manual-test",
      fileMode: 0o600
    })).toBe(true);
    for (const metadata of [
      { scope: "ci", purpose: "interactive-manual-test", fileMode: 0o600 },
      { scope: "local", purpose: "automated-test", fileMode: 0o600 },
      { scope: "local", purpose: "interactive-manual-test", fileMode: 0o640 },
      null
    ]) expect(credentialMetadata.validateCredentialMetadata(metadata)).toBe(false);
  });

  test("does not ship a credential parser, secret holder, or route resolver in the product module", () => {
    expect(credentialMetadata).not.toHaveProperty("parseManualCredentialText");
    expect(credentialMetadata).not.toHaveProperty("resolveValidatedRoute");
    expect(credentialMetadata).not.toHaveProperty("OpaqueSecret");
  });

  test("never invokes inherited values, accessors, or descriptor traps", () => {
    const safe = Object.freeze({ scope: "local", purpose: "interactive-manual-test", fileMode: 0o600 });
    const inherited = Object.create(safe);
    let reads = 0;
    const accessor = Object.defineProperties({}, {
      scope: { get() { reads += 1; return "local"; } },
      purpose: { value: "interactive-manual-test" },
      fileMode: { value: 0o600 }
    });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap"); } });
    expect(credentialMetadata.validateCredentialMetadata(inherited)).toBe(false);
    expect(credentialMetadata.validateCredentialMetadata(accessor)).toBe(false);
    expect(reads).toBe(0);
    expect(() => credentialMetadata.validateCredentialMetadata(proxy)).not.toThrow();
    expect(credentialMetadata.validateCredentialMetadata(proxy)).toBe(false);
  });
});
