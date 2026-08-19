import { describe, expect, it } from "vitest";
import { shouldRejectRuntimeSandbox } from "../src/security/runtime-sandbox.js";

function input(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return Object.freeze({
    platform: "linux",
    argv: Object.freeze(["/opt/CivCom/civcom"]),
    noSandboxSwitch: false,
    ...overrides
  });
}

describe("packaged runtime sandbox policy", () => {
  it("accepts a normal sandboxed Linux launch", () => {
    expect(shouldRejectRuntimeSandbox(input())).toBe(false);
    expect(shouldRejectRuntimeSandbox(input({ argv: Object.freeze(["/opt/CivCom/civcom", "--hidden"]) }))).toBe(false);
  });

  it("rejects every explicit Linux no-sandbox switch spelling", () => {
    for (const argument of ["--no-sandbox", "--no-sandbox=true", "--no-sandbox=false", "--no-sandbox="]) {
      expect(shouldRejectRuntimeSandbox(input({ argv: Object.freeze(["/opt/CivCom/civcom", argument]) }))).toBe(true);
    }
    expect(shouldRejectRuntimeSandbox(input({ noSandboxSwitch: true }))).toBe(true);
  });

  it("does not change Windows or macOS startup policy", () => {
    for (const platform of ["win32", "darwin"]) {
      expect(shouldRejectRuntimeSandbox(input({ platform, argv: Object.freeze(["CivCom", "--no-sandbox"]), noSandboxSwitch: true }))).toBe(false);
    }
  });

  it("fails closed for malformed or hostile Linux boundary values", () => {
    const accessor = Object.create(null, {
      platform: { enumerable: true, value: "linux" },
      argv: { enumerable: true, get: () => ["/opt/CivCom/civcom"] },
      noSandboxSwitch: { enumerable: true, value: false }
    });
    const trapped = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    const sparse = new Array<string>(1);
    for (const value of [null, {}, accessor, trapped, input({ argv: sparse }), input({ argv: ["/opt/CivCom/civcom\n"] }), input({ noSandboxSwitch: "false" })]) {
      expect(shouldRejectRuntimeSandbox(value)).toBe(true);
    }
  });
});
