import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

type BuilderFactory = (environment: Readonly<Record<string, string | undefined>>) => Record<string, any>;

function loadFactory(): BuilderFactory {
  const exported = require("../electron-builder.config.cjs") as { createConfig?: BuilderFactory };
  if (typeof exported.createConfig !== "function") throw new Error("missing-builder-config-factory");
  return exported.createConfig;
}

const base = Object.freeze({ CIVCOM_BUILD_MODE: "pilot" });

describe("effective electron-builder configuration", () => {
  it("exposes the required Node 24 verification and packaging commands", () => {
    const packageJson = require("../package.json") as { author: string; homepage: string; engines: Record<string, string>; scripts: Record<string, string> };
    expect(packageJson.author).toBe("Komenda Główna Państwowej Straży Pożarnej — Biuro Informatyki i Łączności");
    expect(packageJson.homepage).toBe("https://kgpsp.github.io/civcom-desktop/");
    expect(packageJson.engines.node).toBe(">=24 <25");
    for (const script of ["verify", "package:win", "package:mac", "package:linux", "package:verify", "release:verify", "release:checksums", "release:sbom"]) expect(packageJson.scripts[script]).toBeTypeOf("string");
    expect(packageJson.scripts["package:win"]).toBe("node scripts/run-builder.mjs windows");
    expect(packageJson.scripts["package:mac"]).toBe("node scripts/run-builder.mjs macos");
    expect(packageJson.scripts["package:linux"]).toBe("node scripts/run-builder.mjs linux");
    expect(packageJson.scripts["release:checksums"]).toBe("node scripts/release-artifacts.mjs checksums release/assembled");
  });

  it("documents the real pilot, production, verification, and manual DEB update boundaries", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).not.toMatch(/Packaging and Electron lifecycle behavior are intentionally deferred/i);
    for (const command of ["npm run verify", "npm run package:win", "npm run package:mac", "npm run package:linux", "npm run package:verify"]) expect(readme).toContain(command);
    expect(readme).toContain("CIVCOM_BUILD_MODE=pilot");
    expect(readme).toContain("--publish never");
    expect(readme).toMatch(/niepodpisany pilot[^\n]+artefakt[a-ząćęłńóśźż]* workflow/i);
    expect(readme).toMatch(/nigdy[^\n]+niepodpisanego[^\n]+publicznego wydania GitHub/i);
    expect(readme).toMatch(/artefakty produkcyjne[^\n]+podpisane[^\n]+notaryzowane/i);
    expect(readme).toMatch(/aktualizacja DEB[^\n]+ręczna/i);
    expect(readme).toContain("Get-FileHash");
    expect(readme).toContain("md5sum");
    expect(readme).toContain("sha256sum");
    expect(readme).toMatch(/Windows[^\n]+bez uprawnień administratora/i);
    expect(readme).toContain("[procedura publikacji](docs/GITHUB-PUBLICATION.md)");
    for (const input of ["CIVCOM_WINDOWS_PUBLISHER_DN", "APPLE_TEAM_ID", "APPLE_API_KEY", "CIVCOM_LINUX_MAINTAINER"]) expect(readme).toContain(input);
  });

  it("builds an unsigned per-user Windows x64 NSIS with the canonical update feed and filename", () => {
    const config = loadFactory()({ ...base, CIVCOM_RELEASE_TARGET: "windows" });
    expect(config).toMatchObject({
      appId: "info.soia.civcom.desktop",
      productName: "CivCom",
      electronVersion: "43.4.1",
      asar: { smartUnpack: false },
      disableAsarIntegrity: false,
      directories: { output: "release", buildResources: "assets" },
      publish: [{ provider: "generic", url: "https://github.com/KGPSP/civcom-desktop/releases/latest/download", channel: "latest" }],
      win: {
        target: [{ target: "nsis", arch: ["x64"] }],
        artifactName: "CivCom-Windows-x64.exe",
        forceCodeSigning: false,
        signExecutable: false,
        requestedExecutionLevel: "asInvoker",
      },
      nsis: {
        oneClick: true,
        perMachine: false,
        allowElevation: false,
        packElevateHelper: false
      }
    });
    expect(config.electronFuses).toBeUndefined();
    expect(config.asarUnpack).toBeUndefined();
    expect(config.afterPack).toBe("scripts/after-pack.mjs");
    expect(config.extraMetadata).toMatchObject({
      desktopName: "info.soia.civcom.desktop",
      civcomUpdatePolicy: "pilot-disabled-v1"
    });
    expect(config.extraResources).toEqual([{ from: "build/package-type-windows", to: "package-type" }]);
    expect(config.files).toEqual([
      "package.json",
      "!**/*.map",
      { from: "dist", to: "dist", filter: ["**/*", "!**/*.map", "!security/credential-metadata.js"] },
      { from: "assets", to: "assets", filter: ["civcom.png", "civcom-tray.png", "civcom-tray@2x.png"] },
      "LICENSE"
    ]);
  });

  it("builds unsigned universal macOS 13 DMG and ZIP together without a hardened-runtime claim", () => {
    const config = loadFactory()({ ...base, CIVCOM_RELEASE_TARGET: "macos" });
    expect(config.mac).toMatchObject({
      target: [
        { target: "dmg", arch: ["universal"] },
        { target: "zip", arch: ["universal"] }
      ],
      artifactName: "CivCom-macOS-universal.${ext}",
      category: "public.app-category.business",
      minimumSystemVersion: "13.0.0",
      identity: null,
      notarize: false,
      hardenedRuntime: false,
      forceCodeSigning: false,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.inherit.plist",
      preAutoEntitlements: false
    });
    expect(config.mac.extendInfo).toEqual({
      NSCameraUsageDescription: "CivCom używa kamery wyłącznie podczas połączeń wybranych przez użytkownika.",
      NSMicrophoneUsageDescription: "CivCom używa mikrofonu wyłącznie podczas połączeń wybranych przez użytkownika.",
      NSScreenCaptureUsageDescription: "CivCom udostępnia wybrany ekran lub okno wyłącznie po potwierdzeniu użytkownika.",
      NSAudioCaptureUsageDescription: "CivCom może przechwycić dźwięk wybranego źródła podczas udostępniania za zgodą użytkownika."
    });
    expect(config.extraMetadata.civcomUpdatePolicy).toBe("pilot-disabled-v1");
    expect(config.extraResources).toEqual([{ from: "build/package-type-macos", to: "package-type" }]);
  });

  it("builds AppImage and DEB in one Linux x64 configuration with a static zstd AppImage", () => {
    const config = loadFactory()({
      ...base,
      CIVCOM_RELEASE_TARGET: "linux",
      CIVCOM_LINUX_MAINTAINER: "Test Organisation <release@example.org>"
    });
    expect(config.toolsets).toEqual({ appimage: "1.0.3" });
    expect(config.linux).toMatchObject({
      target: [
        { target: "AppImage", arch: ["x64"] },
        { target: "deb", arch: ["x64"] }
      ],
      artifactName: "CivCom-Linux-x86_64.${ext}",
      executableName: "civcom",
      syncDesktopName: true,
      category: "Network;InstantMessaging",
      maintainer: "Test Organisation <release@example.org>",
      desktop: { entry: {
        Name: "CivCom",
        StartupWMClass: "info.soia.civcom.desktop",
        StartupNotify: "true",
        "X-GNOME-UsesNotifications": "true",
        Keywords: "CivCom;Matrix;komunikator;wiadomości;"
      } }
    });
    expect(config.extraMetadata).toMatchObject({
      desktopName: "info.soia.civcom.desktop",
      civcomUpdatePolicy: "pilot-disabled-v1"
    });
    expect(config.extraResources).toBeUndefined();
    expect(config.appImage).toMatchObject({ compression: "zstd" });
    expect(config.deb).toMatchObject({ maintainer: "Test Organisation <release@example.org>", packageCategory: "net", packageName: "civcom" });
  });

  it("fails closed for absent, ambiguous, or hostile build inputs and absent DEB ownership", () => {
    const factory = loadFactory();
    for (const environment of [
      {},
      { CIVCOM_BUILD_MODE: "debug", CIVCOM_RELEASE_TARGET: "windows" },
      { CIVCOM_BUILD_MODE: "pilot", CIVCOM_RELEASE_TARGET: "darwin" },
      { CIVCOM_BUILD_MODE: "pilot\nproduction", CIVCOM_RELEASE_TARGET: "windows" },
      { CIVCOM_BUILD_MODE: "pilot", CIVCOM_RELEASE_TARGET: "linux" },
      { CIVCOM_BUILD_MODE: "pilot", CIVCOM_RELEASE_TARGET: "linux", CIVCOM_LINUX_MAINTAINER: "root" }
    ]) expect(() => factory(environment)).toThrow();
  });

  it("requires target-specific production signing and notarization inputs before packaging", () => {
    const factory = loadFactory();
    for (const target of ["windows", "macos", "linux"] as const) {
      expect(() => factory({ CIVCOM_BUILD_MODE: "production", CIVCOM_RELEASE_TARGET: target })).toThrow();
    }

    const windows = factory({
      CIVCOM_BUILD_MODE: "production",
      CIVCOM_RELEASE_TARGET: "windows",
      CIVCOM_WINDOWS_PUBLISHER_DN: "CN=Test Fixture, O=Test Organisation, L=Test City, ST=Test State, C=PL",
      CSC_LINK: "/tmp/test-fixture.p12",
      CSC_KEY_PASSWORD: "test-only-password"
    });
    expect(windows.win).toMatchObject({
      forceCodeSigning: true,
      verifyUpdateCodeSignature: true,
      signtoolOptions: {
        publisherName: ["CN=Test Fixture, O=Test Organisation, L=Test City, ST=Test State, C=PL"],
        signingHashAlgorithms: ["sha256"]
      }
    });
    expect(windows.extraMetadata.civcomUpdatePolicy).toBe("production-enabled-v1");

    const reorderedWindows = factory({
      CIVCOM_BUILD_MODE: "production",
      CIVCOM_RELEASE_TARGET: "windows",
      CIVCOM_WINDOWS_PUBLISHER_DN: "C=PL, O=Test Organisation, OU=Release Engineering, CN=Test Fixture",
      CSC_LINK: "/tmp/test-fixture.p12",
      CSC_KEY_PASSWORD: "test-only-password"
    });
    expect(reorderedWindows.win.signtoolOptions.publisherName).toEqual(["C=PL, O=Test Organisation, OU=Release Engineering, CN=Test Fixture"]);

    const macos = factory({
      CIVCOM_BUILD_MODE: "production",
      CIVCOM_RELEASE_TARGET: "macos",
      CSC_LINK: "/tmp/test-fixture.p12",
      CSC_KEY_PASSWORD: "test-only-password",
      APPLE_TEAM_ID: "A1B2C3D4E5",
      APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
      APPLE_API_KEY_ID: "F6G7H8J9K0",
      APPLE_API_ISSUER: "11111111-2222-1333-8444-555555555555"
    });
    expect(macos.mac).toMatchObject({ forceCodeSigning: true, hardenedRuntime: true, strictVerify: true, notarize: true });
    expect(macos.extraMetadata.civcomUpdatePolicy).toBe("production-enabled-v1");
    expect(macos.mac.identity).toBeUndefined();
  });

  it("ships only the approved macOS entitlements", () => {
    const main = readFileSync(new URL("../build/entitlements.mac.plist", import.meta.url), "utf8");
    const inherit = readFileSync(new URL("../build/entitlements.mac.inherit.plist", import.meta.url), "utf8");
    expect([...main.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort()).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.device.audio-input",
      "com.apple.security.device.camera"
    ]);
    expect([...inherit.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(`${main}\n${inherit}`).not.toMatch(/get-task-allow|disable-library-validation|allow-dyld|app-sandbox|screen-capture|allow-unsigned-executable-memory/);
  });
});
