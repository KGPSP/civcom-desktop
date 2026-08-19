import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { isSafeSvgContent, verifyAssetDirectory } from "../scripts/verify-assets.mjs";
import { describe, expect, test } from "vitest";

describe("isSafeSvgContent", () => {
  test("rejects an SVG event-handler attribute", () => {
    expect(
      isSafeSvgContent('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')
    ).toBe(false);
  });

  test("rejects a javascript URI in an SVG href", () => {
    expect(
      isSafeSvgContent(
        '<svg xmlns="http://www.w3.org/2000/svg"><path href="javascript:alert(1)"/></svg>'
      )
    ).toBe(false);
  });

  test("rejects an entity-obfuscated javascript URI", () => {
    expect(
      isSafeSvgContent(
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="javascript&#58;alert(1)"/></svg>'
      )
    ).toBe(false);
  });

  test("rejects an external resource in a paint URL", () => {
    expect(
      isSafeSvgContent(
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://attacker.example/p.svg)"/></svg>'
      )
    ).toBe(false);
  });

  test("rejects a CSS hex-escaped paint URL", () => {
    expect(
      isSafeSvgContent(
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="u\\72l(https://attacker.example/p.svg)"/></svg>'
      )
    ).toBe(false);
  });

  test("rejects a CSS comment-split paint URL", () => {
    expect(
      isSafeSvgContent(
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="u/**/rl(https://attacker.example/p.svg)"/></svg>'
      )
    ).toBe(false);
  });

  test("rejects a CSS hex escape terminated by whitespace", () => {
    expect(
      isSafeSvgContent(
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="u\\72 l(https://attacker.example/p.svg)"/></svg>'
      )
    ).toBe(false);
  });

  test("rejects local-fragment paint URLs as well", () => {
    expect(
      isSafeSvgContent(
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(#gradient)"/></svg>'
      )
    ).toBe(false);
  });

  test("rejects active SVG use elements", () => {
    expect(
      isSafeSvgContent('<svg xmlns="http://www.w3.org/2000/svg"><use href="#shape"/></svg>')
    ).toBe(false);
  });

  test("rejects an arbitrary namespace-prefixed URI attribute", () => {
    expect(
      isSafeSvgContent(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:evil="https://attacker.example/" evil:href="#fragment"/>'
      )
    ).toBe(false);
  });

  test("rejects namespace declarations outside the root SVG element", () => {
    expect(
      isSafeSvgContent(
        '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/2000/svg"/></svg>'
      )
    ).toBe(false);
  });

  test("rejects XML processing instructions", () => {
    expect(isSafeSvgContent('<?xml-stylesheet href="https://attacker.example/style.css"?><svg/>')).toBe(false);
  });

  test("rejects DTD declarations", () => {
    expect(isSafeSvgContent('<!DOCTYPE svg [<!ENTITY payload "unsafe">]><svg/>')).toBe(false);
  });

  test("accepts the actual vendored CivCom mark", async () => {
    const asset = await readFile(new URL("../assets/civcom.svg", import.meta.url), "utf8");

    expect(isSafeSvgContent(asset)).toBe(true);
  });

  test("requires the canonical 1024x1024 application raster as well as both tray rasters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "civcom-assets-"));
    for (const filename of ["civcom.svg", "civcom-tray.png", "civcom-tray@2x.png"]) {
      await copyFile(new URL(`../assets/${filename}`, import.meta.url), join(directory, filename));
    }
    await expect(verifyAssetDirectory(directory)).rejects.toThrow("civcom.png");
    await expect(readFile(new URL("../assets/civcom.png", import.meta.url))).resolves.toBeInstanceOf(Buffer);
    await expect(verifyAssetDirectory()).resolves.toBeUndefined();
  });
});
