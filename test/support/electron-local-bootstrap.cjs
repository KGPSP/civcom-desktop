"use strict";

const { app, BrowserWindow, session, shell } = require("electron");
const { randomBytes } = require("node:crypto");
const { chmodSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");

function exactLoopbackOrigin(value, protocols) {
  if (typeof value !== "string" || value.length > 256 || /[\s\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (!protocols.includes(url.protocol) || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535 || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.origin !== value) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

const startOrigin = exactLoopbackOrigin(process.env.CIVCOM_LOCAL_HARNESS_ORIGIN, ["http:"]);
const tlsOrigin = exactLoopbackOrigin(process.env.CIVCOM_LOCAL_HARNESS_TLS_ORIGIN, ["https:"]);
for (const key of Object.keys(process.env)) {
  if (/^(?:CI|GITHUB_|ACTIONS_|NODE_|NPM_|npm_|DEBUG|PWDEBUG|ELECTRON_|CIVCOM_|.*(?:TOKEN|SECRET|PASSWORD|PASS|COOKIE|AUTH|PROXY).*)$/i.test(key)) delete process.env[key];
}

if (startOrigin === undefined || tlsOrigin === undefined) {
  app.exit(2);
} else {
  const temporaryParent = realpathSync(tmpdir());
  const temporaryRoot = mkdtempSync(join(temporaryParent, "civcom-local-electron-"));
  chmodSync(temporaryRoot, 0o700);
  const resolvedRoot = resolve(temporaryRoot);
  const safeTemporaryRoot = resolvedRoot.startsWith(`${temporaryParent}${sep}`) && basename(resolvedRoot).startsWith("civcom-local-electron-");
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

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      try { rmSync(resolvedRoot, { recursive: true }); } catch { /* verified generated child only */ }
    }
    app.once("will-quit", cleanup);

    const projectRoot = resolve(__dirname, "..", "..");
    const partition = `civcom-local-${randomBytes(16).toString("hex")}`;
    const counters = { externalOpenCount: 0, blockedRequestCount: 0, redirectCount: 0 };
    const redirected = new Set();
    let guardInstalled = false;
    let guardInstalledBeforeWindow = false;
    let harnessSession;

    process.env.CIVCOM_DEV_URL = `${startOrigin}/`;
    process.env.CIVCOM_UNPACKAGED_HARNESS = "local-v1";
    process.env.CIVCOM_UNPACKAGED_HARNESS_PARTITION = partition;
    shell.openExternal = async () => { counters.externalOpenCount += 1; };

    void (async () => {
      const [{ createOfflinePageUrl, OFFLINE_RETRY_URL }, { createLoopbackNetworkGuard, decideElectronRequest }] = await Promise.all([
        import(pathToFileURL(join(projectRoot, "dist", "desktop", "shell.js")).href),
        import(pathToFileURL(join(__dirname, "anonymous-network-guard.mjs")).href)
      ]);
      const offlineUrl = createOfflinePageUrl("embedded");
      const guard = createLoopbackNetworkGuard([startOrigin, tlsOrigin]);

      const guardReady = app.whenReady().then(() => {
        guardInstalledBeforeWindow = BrowserWindow.getAllWindows().length === 0;
        harnessSession = session.fromPartition(partition);
        harnessSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
          if ((details.url === "about:blank" || details.url === OFFLINE_RETRY_URL || details.url === offlineUrl) && details.method === "GET" && details.resourceType === "mainFrame") {
            callback({ cancel: false });
            return;
          }
          const decision = decideElectronRequest(guard, details, redirected.delete(details.id));
          if (decision.kind === "block") counters.blockedRequestCount += 1;
          callback({ cancel: decision.kind === "block" });
        });
        harnessSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
          const decision = guard.headers({ requestHeaders: details.requestHeaders });
          if (decision.kind === "block") counters.blockedRequestCount += 1;
          callback(decision.kind === "block" ? { cancel: true } : { cancel: false, requestHeaders: details.requestHeaders });
        });
        harnessSession.webRequest.onBeforeRedirect({ urls: ["<all_urls>"] }, (details) => {
          counters.redirectCount += 1;
          redirected.add(details.id);
        });
        guardInstalled = true;
      });

      await import(pathToFileURL(join(projectRoot, "dist", "main.js")).href);
      await guardReady;

      let window;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        window = BrowserWindow.getAllWindows()[0];
        if (window !== undefined) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      if (window === undefined || !guardInstalled || harnessSession === undefined || window.webContents.session !== harnessSession) {
        app.exit(2);
        return;
      }
      let started = false;
      globalThis.__civcomLocalStart = async () => {
        if (started) return false;
        started = true;
        try { await window.loadURL(`${startOrigin}/`); return true; } catch { return false; }
      };
      globalThis.__civcomLocalSnapshot = async () => {
        const current = window.webContents.getURL();
        const phase = current === "about:blank" ? "about" : current === offlineUrl ? "offline" : current.startsWith(`${startOrigin}/`) ? "loopback" : "other";
        let downloadsEntryCount;
        try { downloadsEntryCount = readdirSync(downloads).length; } catch { downloadsEntryCount = -1; }
        return Object.freeze({ phase, ...counters, downloadsEmpty: downloadsEntryCount === 0, downloadsEntryCount, productionMainWired: true, guardInstalledBeforeWindow, memoryPartition: !partition.startsWith("persist:") && window.webContents.session === harnessSession });
      };
      globalThis.__civcomLocalProbeCertificate = async () => {
        const probe = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, partition } });
        return await new Promise((resolveProbe) => {
          let settled = false;
          const settle = (value) => { if (settled) return; settled = true; clearTimeout(timeout); probe.destroy(); resolveProbe(value); };
          const timeout = setTimeout(() => settle(false), 10_000);
          probe.webContents.once("did-fail-load", () => settle(false));
          probe.webContents.once("did-finish-load", () => settle(true));
          void probe.loadURL(`${tlsOrigin}/`).catch(() => settle(false));
        });
      };
    })().catch(() => app.exit(2));
  }
}
