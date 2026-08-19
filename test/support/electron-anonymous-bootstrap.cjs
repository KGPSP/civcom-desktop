"use strict";

const { app, BrowserWindow, session } = require("electron");
const { randomBytes } = require("node:crypto");
const { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");
const { scrubSensitiveElectronEnvironment } = require("./electron-environment.cjs");

const PRODUCTION_URL = "https://civcom.soia.info/";
const optInConfirmed = process.env.CIVCOM_ALLOW_ANONYMOUS_PRODUCTION_SMOKE === "confirmed";
scrubSensitiveElectronEnvironment(process.env);

if (!optInConfirmed) {
  app.exit(2);
} else {
  const events = ["opt-in"];
  let clientCertificateDenyCount = 0;
  app.on("select-client-certificate", (event, _contents, _url, _certificateList, callback) => { clientCertificateDenyCount += 1; event.preventDefault(); callback(); });
  const temporaryParent = realpathSync(tmpdir());
  const temporaryRoot = mkdtempSync(join(temporaryParent, "civcom-anonymous-electron-"));
  chmodSync(temporaryRoot, 0o700);
  const resolvedRoot = resolve(temporaryRoot);
  const safeTemporaryRoot = resolvedRoot.startsWith(`${temporaryParent}${sep}`) && basename(resolvedRoot).startsWith("civcom-anonymous-electron-");
  if (!safeTemporaryRoot) {
    app.exit(2);
  } else {
    const userData = join(resolvedRoot, "user-data");
    const sessionData = join(resolvedRoot, "session-data");
    const downloads = join(resolvedRoot, "downloads");
    for (const directory of [userData, sessionData, downloads]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    app.setPath("userData", userData);
    app.setPath("sessionData", sessionData);
    app.setPath("downloads", downloads);
    events.push("paths");

    let cleaned = false;
    app.once("will-quit", () => {
      if (cleaned) return;
      cleaned = true;
      try { rmSync(resolvedRoot, { recursive: true }); } catch { /* verified generated child only */ }
    });
    app.on("certificate-error", (event, _contents, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });

    void app.whenReady().then(async () => {
      const projectRoot = resolve(__dirname, "..", "..");
      const [{ createWebPreferences }, { authorizeAnonymousBootstrapSequence, createAnonymousMemoryPartition, createAnonymousProductionNetworkGuard, decideElectronRequest }] = await Promise.all([
        import(pathToFileURL(join(projectRoot, "dist", "desktop", "shell.js")).href),
        import(pathToFileURL(join(__dirname, "anonymous-network-guard.mjs")).href)
      ]);
      const partition = createAnonymousMemoryPartition(randomBytes(16));
      const anonymousSession = session.fromPartition(partition);
      events.push("memory-session");
      anonymousSession.setSSLConfig({ minVersion: "tls1.2", maxVersion: "tls1.3" });
      events.push("tls");
      const guard = createAnonymousProductionNetworkGuard();
      const redirected = new Set();
      const counters = { blockedRequestCount: 0, mutationBlockCount: 0, credentialHeaderBlockCount: 0, redirectBlockCount: 0, deniedPermissionCount: 0, deniedDownloadCount: 0, rendererConsoleErrorCount: 0, rendererCrashCount: 0 };
      const guardInstalledBeforeWindow = BrowserWindow.getAllWindows().length === 0;

      anonymousSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
        if (details.url === "about:blank" && details.method === "GET" && details.resourceType === "mainFrame") { callback({ cancel: false }); return; }
        const decision = decideElectronRequest(guard, details, redirected.delete(details.id));
        if (decision.kind === "block") {
          counters.blockedRequestCount += 1;
          if (decision.code === "UNSAFE_METHOD" || decision.code === "REQUEST_BODY") counters.mutationBlockCount += 1;
          if (decision.code === "REDIRECT") counters.redirectBlockCount += 1;
        }
        callback({ cancel: decision.kind === "block" });
      });
      anonymousSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
        let requestHeaders;
        try { requestHeaders = details.requestHeaders; } catch { requestHeaders = null; }
        const decision = guard.headers({ requestHeaders });
        if (decision.kind === "block") {
          counters.blockedRequestCount += 1;
          if (decision.code === "CREDENTIAL_HEADER") counters.credentialHeaderBlockCount += 1;
        }
        callback(decision.kind === "block" ? { cancel: true } : { cancel: false, requestHeaders });
      });
      anonymousSession.webRequest.onBeforeRedirect({ urls: ["<all_urls>"] }, (details) => { redirected.add(details.id); });
      anonymousSession.setPermissionCheckHandler(() => { counters.deniedPermissionCount += 1; return false; });
      anonymousSession.setPermissionRequestHandler((_contents, _permission, callback) => { counters.deniedPermissionCount += 1; callback(false); });
      anonymousSession.setDevicePermissionHandler(() => false);
      anonymousSession.on("will-download", (_event, item) => { counters.deniedDownloadCount += 1; item.cancel(); });
      events.push("guard");

      const webPreferences = createWebPreferences(partition);
      const window = new BrowserWindow({ title: "CivCom", show: true, width: 900, height: 700, webPreferences });
      events.push("window");
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (details) => {
        let allowed;
        try {
          const url = new URL(details.url);
          allowed = url.username === "" && url.password === "" && url.port === "" && (url.origin === "https://civcom.soia.info" || url.origin === "https://auth.soia.info");
        } catch { allowed = false; }
        if (!allowed) details.preventDefault();
      });
      window.webContents.on("will-redirect", (details) => { details.preventDefault(); counters.redirectBlockCount += 1; });
      window.webContents.on("console-message", (details, level) => { if (details?.level === "error" || level === 3) counters.rendererConsoleErrorCount += 1; });
      window.webContents.on("render-process-gone", () => { counters.rendererCrashCount += 1; });
      await window.loadURL("about:blank");

      let armed = false;
      let started = false;
      globalThis.__civcomAnonymousArm = () => {
        if (armed) return false;
        armed = true;
        events.push("listeners");
        return true;
      };
      globalThis.__civcomAnonymousStart = async () => {
        if (!armed || started) return false;
        started = true;
        events.push("navigate");
        if (authorizeAnonymousBootstrapSequence(events).kind !== "allow") return false;
        try { await window.loadURL(PRODUCTION_URL); return true; } catch { return false; }
      };
      globalThis.__civcomAnonymousLoginRoute = async () => {
        if (!started) return false;
        try { await window.loadURL(`${PRODUCTION_URL}#/login`); return true; } catch { return false; }
      };
      globalThis.__civcomAnonymousSnapshot = () => {
        const current = window.webContents.getURL();
        let phase = "other";
        try {
          const url = new URL(current);
          if (current === "about:blank") phase = "about";
          else if (url.origin === "https://civcom.soia.info" && url.hash === "#/login") phase = "login";
          else if (url.origin === "https://civcom.soia.info") phase = "civcom";
        } catch { phase = "other"; }
        return Object.freeze({ phase, ...counters, clientCertificateDenyCount, guardInstalledBeforeWindow, memoryPartition: !partition.startsWith("persist:") && window.webContents.session === anonymousSession, securePreferences: webPreferences.nodeIntegration === false && webPreferences.contextIsolation === true && webPreferences.sandbox === true && webPreferences.webSecurity === true && webPreferences.webviewTag === false && !("preload" in webPreferences), sequenceAccepted: authorizeAnonymousBootstrapSequence(events).kind === "allow" });
      };
    }).catch(() => app.exit(2));
  }
}
