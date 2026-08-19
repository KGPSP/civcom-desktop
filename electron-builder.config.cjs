"use strict";

const downloads = require("./docs/downloads.json");

const FEED_URL = "https://github.com/KGPSP/civcom-desktop/releases/latest/download";
const MODES = new Set(["pilot", "production"]);
const TARGETS = new Set(["windows", "macos", "linux"]);

function ownString(environment, key) {
  try {
    if (environment === null || typeof environment !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") return undefined;
    const value = descriptor.value;
    if (value === "" || value.length > 4096 || [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function requireValue(environment, key, pattern) {
  const value = ownString(environment, key);
  if (value === undefined || (pattern !== undefined && !pattern.test(value))) throw new Error(`Missing or invalid required build input: ${key}`);
  return value;
}

function requirePublisherSubject(environment) {
  const value = requireValue(environment, "CIVCOM_WINDOWS_PUBLISHER_DN");
  const equals = value.indexOf("=");
  if (value !== value.trim() || value.length > 2048 || equals <= 0 || equals === value.length - 1) throw new Error("Missing or invalid required build input: CIVCOM_WINDOWS_PUBLISHER_DN");
  return value;
}

function windowsSigning(environment) {
  const publisher = requirePublisherSubject(environment);
  requireValue(environment, "CSC_LINK");
  requireValue(environment, "CSC_KEY_PASSWORD");
  return Object.freeze({
    forceCodeSigning: true,
    verifyUpdateCodeSignature: true,
    signtoolOptions: Object.freeze({ publisherName: Object.freeze([publisher]), signingHashAlgorithms: Object.freeze(["sha256"]) })
  });
}

function macSigning(environment) {
  requireValue(environment, "CSC_LINK");
  requireValue(environment, "CSC_KEY_PASSWORD");
  requireValue(environment, "APPLE_TEAM_ID", /^[A-Z0-9]{10}$/);
  requireValue(environment, "APPLE_API_KEY");
  requireValue(environment, "APPLE_API_KEY_ID", /^[A-Z0-9]{10}$/);
  requireValue(environment, "APPLE_API_ISSUER", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return Object.freeze({ forceCodeSigning: true, hardenedRuntime: true, strictVerify: true, notarize: true });
}

function linuxMaintainer(environment) {
  return requireValue(environment, "CIVCOM_LINUX_MAINTAINER", /^[^<>]{2,100} <[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}>$/i);
}

function commonConfig(target) {
  const marker = `build/package-type-${target}`;
  return {
    appId: "info.soia.civcom.desktop",
    productName: "CivCom",
    electronVersion: "43.4.1",
    asar: { smartUnpack: false },
    disableAsarIntegrity: false,
    compression: "normal",
    directories: { output: "release", buildResources: "assets" },
    files: [
      "package.json",
      "!**/*.map",
      { from: "dist", to: "dist", filter: ["**/*", "!**/*.map", "!security/credential-metadata.js"] },
      { from: "assets", to: "assets", filter: ["civcom.png", "civcom-tray.png", "civcom-tray@2x.png"] },
      "LICENSE"
    ],
    extraResources: [{ from: marker, to: "package-type" }],
    extraMetadata: { desktopName: "info.soia.civcom.desktop" },
    afterPack: "scripts/after-pack.mjs",
    detectUpdateChannel: false,
    generateUpdatesFilesForAllChannels: false,
    publish: [{ provider: "generic", url: FEED_URL, channel: "latest" }]
  };
}

function createConfig(environment) {
  const mode = ownString(environment, "CIVCOM_BUILD_MODE");
  const target = ownString(environment, "CIVCOM_RELEASE_TARGET");
  if (mode === undefined || !MODES.has(mode)) throw new Error("CIVCOM_BUILD_MODE must be exactly pilot or production");
  if (target === undefined || !TARGETS.has(target)) throw new Error("CIVCOM_RELEASE_TARGET must be exactly windows, macos, or linux");
  const production = mode === "production";
  const config = commonConfig(target);

  if (target === "windows") {
    config.win = {
      target: [{ target: "nsis", arch: ["x64"] }],
      artifactName: downloads.assets.windowsInstaller,
      icon: "civcom.png",
      requestedExecutionLevel: "asInvoker",
      ...(production ? windowsSigning(environment) : { forceCodeSigning: false, verifyUpdateCodeSignature: false, signExecutable: false })
    };
    config.nsis = { oneClick: true, perMachine: false, allowElevation: false, packElevateHelper: false, deleteAppDataOnUninstall: false };
  } else if (target === "macos") {
    config.mac = {
      target: [{ target: "dmg", arch: ["universal"] }, { target: "zip", arch: ["universal"] }],
      artifactName: "CivCom-macOS-universal.${ext}",
      icon: "civcom.png",
      category: "public.app-category.business",
      minimumSystemVersion: "13.0.0",
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.inherit.plist",
      preAutoEntitlements: false,
      extendInfo: {
        NSCameraUsageDescription: "CivCom używa kamery wyłącznie podczas połączeń wybranych przez użytkownika.",
        NSMicrophoneUsageDescription: "CivCom używa mikrofonu wyłącznie podczas połączeń wybranych przez użytkownika.",
        NSScreenCaptureUsageDescription: "CivCom udostępnia wybrany ekran lub okno wyłącznie po potwierdzeniu użytkownika.",
        NSAudioCaptureUsageDescription: "CivCom może przechwycić dźwięk wybranego źródła podczas udostępniania za zgodą użytkownika."
      },
      ...(production ? macSigning(environment) : { identity: null, notarize: false, hardenedRuntime: false, strictVerify: true, forceCodeSigning: false })
    };
    config.dmg = { writeUpdateInfo: false };
  } else {
    const maintainer = linuxMaintainer(environment);
    config.toolsets = { appimage: "1.0.3" };
    config.linux = {
      target: [{ target: "AppImage", arch: ["x64"] }, { target: "deb", arch: ["x64"] }],
      artifactName: "CivCom-Linux-x86_64.${ext}",
      icon: "civcom.png",
      executableName: "civcom",
      syncDesktopName: true,
      category: "Network;InstantMessaging",
      synopsis: "Bezpieczny klient komunikatora CivCom",
      description: "Cienki klient desktopowy istniejącej usługi CivCom.",
      maintainer,
      desktop: { entry: {
        Name: "CivCom",
        StartupWMClass: "info.soia.civcom.desktop",
        StartupNotify: "true",
        "X-GNOME-UsesNotifications": "true",
        Keywords: "CivCom;Matrix;komunikator;wiadomości;"
      } }
    };
    config.appImage = { compression: "zstd" };
    config.deb = { maintainer, packageCategory: "net", packageName: "civcom", priority: "optional", compression: "xz" };
  }

  return config;
}

function electronBuilderConfig() {
  return createConfig(process.env);
}

Object.defineProperty(electronBuilderConfig, "createConfig", { value: createConfig, enumerable: false });
module.exports = electronBuilderConfig;
