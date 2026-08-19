(function (global) {
  "use strict";

  var ASSET_KEYS = [
    "windowsInstaller", "windowsBlockmap", "windowsMetadata",
    "macDmg", "macZip", "macBlockmap", "macMetadata",
    "linuxAppImage", "linuxDeb", "linuxMetadata", "buildSbom", "checksums"
  ];
  var PRIMARY = { windows: "windowsInstaller", macos: "macDmg", linux: "linuxAppImage" };
  var LABELS = {
    windows: "Pobierz CivCom dla Windows",
    macos: "Pobierz CivCom dla macOS",
    linux: "Pobierz przenośny CivCom AppImage",
    mobile: "Zobacz najnowsze wydanie",
    unknown: "Zobacz najnowsze wydanie"
  };

  function text(value) {
    return typeof value === "string" ? value : "";
  }

  function detectPlatform(input) {
    try {
      var userAgent = text(input && input.userAgent).toLowerCase();
      var platform = text(input && input.userAgentDataPlatform) || text(input && input.platform);
      var normalizedPlatform = platform.toLowerCase();
      var touches = Number(input && input.maxTouchPoints) || 0;
      if (userAgent.indexOf("android") !== -1 || userAgent.indexOf("iphone") !== -1 || userAgent.indexOf("ipad") !== -1 || userAgent.indexOf("mobile") !== -1 || (normalizedPlatform === "macintel" && touches > 1)) return "mobile";
      if (normalizedPlatform.indexOf("win") !== -1 || userAgent.indexOf("windows") !== -1) return "windows";
      if (normalizedPlatform.indexOf("mac") !== -1 || userAgent.indexOf("macintosh") !== -1) return "macos";
      if (normalizedPlatform.indexOf("linux") !== -1 || userAgent.indexOf("linux") !== -1) return "linux";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  function validContract(value) {
    if (!value || typeof value !== "object" || value.schemaVersion !== 1 || value.releaseBaseUrl !== "https://github.com/KGPSP/civcom-desktop/releases/latest/download" || value.latestReleaseUrl !== "https://github.com/KGPSP/civcom-desktop/releases/latest" || !value.assets || typeof value.assets !== "object") return false;
    var seen = Object.create(null);
    for (var index = 0; index < ASSET_KEYS.length; index += 1) {
      var filename = value.assets[ASSET_KEYS[index]];
      if (typeof filename !== "string" || filename === "" || filename.length > 240 || filename.indexOf("/") !== -1 || filename.indexOf("\\") !== -1 || Array.from(filename).some(function (character) { var code = character.charCodeAt(0); return code <= 31 || code === 127; }) || seen[filename]) return false;
      seen[filename] = true;
    }
    return Object.keys(value.assets).length === ASSET_KEYS.length;
  }

  function navigatorInput(navigatorObject) {
    var userAgentDataPlatform = "";
    try { userAgentDataPlatform = text(navigatorObject && navigatorObject.userAgentData && navigatorObject.userAgentData.platform); } catch { /* unknown */ }
    return {
      userAgent: text(navigatorObject && navigatorObject.userAgent),
      platform: text(navigatorObject && navigatorObject.platform),
      maxTouchPoints: Number(navigatorObject && navigatorObject.maxTouchPoints) || 0,
      userAgentDataPlatform: userAgentDataPlatform
    };
  }

  async function boot(input) {
    try {
      var response = await input.fetch("downloads.json", { cache: "no-store", credentials: "same-origin" });
      if (!response || response.ok !== true) return;
      var contract = await response.json();
      if (!validContract(contract)) return;
      var alternatives = input.document.querySelectorAll("[data-asset]");
      for (var index = 0; index < alternatives.length; index += 1) {
        var link = alternatives[index];
        var filename = link && link.dataset && link.dataset.asset;
        if (typeof filename === "string" && Object.values(contract.assets).indexOf(filename) !== -1) link.href = contract.releaseBaseUrl + "/" + filename;
      }
      var platform = detectPlatform(navigatorInput(input.navigator));
      var primary = input.document.getElementById("primary-download");
      if (!primary) return;
      var assetKey = PRIMARY[platform];
      primary.href = assetKey ? contract.releaseBaseUrl + "/" + contract.assets[assetKey] : contract.latestReleaseUrl;
      primary.textContent = LABELS[platform] || LABELS.unknown;
    } catch {
      /* Static manual links remain available. */
    }
  }

  global.CivComDownloads = Object.freeze({ detectPlatform: detectPlatform, boot: boot });
  if (global.document && global.navigator && global.fetch) {
    global.document.addEventListener("DOMContentLoaded", function () {
      void boot({ document: global.document, navigator: global.navigator, fetch: global.fetch.bind(global) });
    }, { once: true });
  }
}(globalThis));
