import { describe, expect, it } from "vitest";
import { createPackagedSmokeResult, isPackagedSmokeRequested, packagedSmokeResultPath } from "../src/desktop/packaged-smoke.js";

describe("native packaged smoke harness", () => {
  it("can be requested only for a packaged app with one exact flag", () => {
    expect(isPackagedSmokeRequested({ isPackaged: true, argv: ["CivCom", "--civcom-packaged-smoke"] })).toBe(true);
    for (const input of [
      { isPackaged: false, argv: ["CivCom", "--civcom-packaged-smoke"] },
      { isPackaged: true, argv: ["CivCom", "--civcom-packaged-smoke=1"] },
      { isPackaged: true, argv: ["CivCom", "--civcom-packaged-smoke", "--civcom-packaged-smoke"] }
    ]) expect(isPackagedSmokeRequested(input)).toBe(false);
  });

  it("records only a visible self-contained data document under fixed user data", () => {
    expect(packagedSmokeResultPath("/tmp/civcom-smoke")).toBe("/tmp/civcom-smoke/packaged-smoke.json");
    expect(createPackagedSmokeResult({ windowVisible: true, loadedUrl: "data:text/html;charset=utf-8,test" })).toEqual({ schemaVersion: 1, status: "ok", windowVisible: true, loadedUrl: "data:text/html;charset=utf-8,test" });
    for (const input of [{ windowVisible: false, loadedUrl: "data:text/html,test" }, { windowVisible: true, loadedUrl: "https://civcom.soia.gov.pl/" }]) expect(() => createPackagedSmokeResult(input)).toThrow();
  });
});
