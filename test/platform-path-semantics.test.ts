import { describe, expect, it } from "vitest";

const packagedPolicyUrl = new URL("../scripts/packaged-app-policy.mjs", import.meta.url).href;

type PackagedPolicyModule = Readonly<{
  resolvePackagedTargetPath(target: "windows" | "macos" | "linux", root: string, segments: readonly string[]): string;
}>;

describe("artifact target path semantics", () => {
  it("keeps POSIX artifact paths POSIX even when the test host is Windows", async () => {
    const { resolvePackagedTargetPath } = await import(packagedPolicyUrl) as PackagedPolicyModule;
    expect(resolvePackagedTargetPath("macos", "/tmp/release", ["mac-universal", "CivCom.app"]))
      .toBe("/tmp/release/mac-universal/CivCom.app");
    expect(resolvePackagedTargetPath("linux", "/tmp/release", ["linux-unpacked", "resources"]))
      .toBe("/tmp/release/linux-unpacked/resources");
    expect(resolvePackagedTargetPath("windows", "D:\\release", ["win-unpacked", "resources"]))
      .toBe("D:\\release\\win-unpacked\\resources");
  });
});
