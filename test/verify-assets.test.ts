import { isSafeSvgContent } from "../scripts/verify-assets.mjs";
import { describe, expect, test } from "vitest";

describe("isSafeSvgContent", () => {
  test("rejects an SVG event-handler attribute", () => {
    expect(isSafeSvgContent('<svg onload="alert(1)"></svg>')).toBe(false);
  });

  test("rejects a javascript URI in an SVG href", () => {
    expect(isSafeSvgContent('<svg><a href="javascript:alert(1)">x</a></svg>')).toBe(false);
  });
});
