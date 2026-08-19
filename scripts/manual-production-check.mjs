import { _electron as electron } from "playwright";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { navigateCredentialRoute, readFixedManualCredentialFile } from "./manual/credential-file.mjs";

const FIXED_CREDENTIAL_PATH = fileURLToPath(new URL("../.cred.env", import.meta.url));
const MANUAL_BOOTSTRAP_PATH = fileURLToPath(new URL("../test/support/electron-manual-bootstrap.cjs", import.meta.url));

function rejected(code) {
  return Object.freeze({ kind: "rejected", code });
}

function snapshotInvocation(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
    const result = new Map();
    for (const key of ["argv", "ci", "stdinIsTTY", "stdoutIsTTY", "platform"]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      result.set(key, descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

export function validateManualInvocation(input) {
  const values = snapshotInvocation(input);
  if (values === undefined) return rejected("MANUAL_INVOCATION_REJECTED");
  const argv = values.get("argv");
  if (!Array.isArray(argv) || argv.length !== 0 || values.get("ci") !== false || values.get("stdinIsTTY") !== true || values.get("stdoutIsTTY") !== true) return rejected("MANUAL_INVOCATION_REJECTED");
  if (values.get("platform") === "win32") return rejected("WINDOWS_ACL_UNSUPPORTED");
  return Object.freeze({ kind: "accepted", code: "MANUAL_INVOCATION_OK" });
}

export async function runManualProductionFlow(dependencies) {
  const invocation = validateManualInvocation(dependencies?.invocation);
  if (invocation.kind !== "accepted") return invocation;
  let profile;
  let browser;
  let result;
  try {
    result = await (async () => {
      const credential = dependencies.readCredentials();
      if (credential?.kind !== "accepted" || credential.route === null || typeof credential.route !== "object") return rejected("CREDENTIAL_REJECTED");
      profile = dependencies.createProfile();
      if (typeof profile !== "string" || profile.length === 0) return rejected("PROFILE_REJECTED");
      browser = await dependencies.launchBrowser(profile);
      dependencies.status("ENTER_CREDENTIALS_INTERACTIVELY");
      if (await dependencies.confirmInteractiveLogin() !== true) return rejected("LOGIN_NOT_CONFIRMED");
      if (await browser.isAuthenticated() !== true) return rejected("LOGIN_NOT_CONFIRMED");
      const navigation = await navigateCredentialRoute(credential.route, browser);
      if (navigation.kind !== "accepted") return rejected("ROUTE_REJECTED");
      dependencies.status("MANUAL_ROUTE_READY");
      if (await dependencies.waitForManualCompletion() !== true) return rejected("MANUAL_CHECKS_NOT_CONFIRMED");
      return Object.freeze({ kind: "accepted", code: "MANUAL_ROUTE_READY" });
    })();
  } catch {
    result = rejected("MANUAL_FLOW_REJECTED");
  }
  let cleanupFailed = false;
  if (browser !== undefined) {
    try { await browser.close(); } catch { cleanupFailed = true; }
  }
  if (profile !== undefined) {
    try { dependencies.removeProfile(profile); } catch { cleanupFailed = true; }
  }
  return cleanupFailed ? rejected("MANUAL_CLEANUP_REJECTED") : result;
}

function createVerifiedManualProfile() {
  const parent = realpathSync(tmpdir());
  const created = mkdtempSync(join(parent, "civcom-manual-electron-"));
  chmodSync(created, 0o700);
  const resolved = realpathSync(created);
  if (!resolved.startsWith(`${parent}${sep}`) || !basename(resolved).startsWith("civcom-manual-electron-")) throw new Error("PROFILE_REJECTED");
  return resolved;
}

function removeVerifiedManualProfile(profile) {
  const parent = realpathSync(tmpdir());
  const before = lstatSync(profile);
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o777) !== 0o700) throw new Error("PROFILE_REJECTED");
  const resolved = realpathSync(profile);
  const after = lstatSync(profile);
  if (resolved !== profile || !resolved.startsWith(`${parent}${sep}`) || !basename(profile).startsWith("civcom-manual-electron-") || after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) throw new Error("PROFILE_REJECTED");
  rmSync(profile, { recursive: true });
}

function safeEnvironment(profile) {
  const environment = { CIVCOM_MANUAL_PROFILE_ROOT: profile };
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = process.env[key];
    if (typeof value === "string") environment[key] = value;
  }
  return environment;
}

async function launchManualBrowser(profile) {
  const app = await electron.launch({ args: [MANUAL_BOOTSTRAP_PATH], chromiumSandbox: true, acceptDownloads: true, ignoreHTTPSErrors: false, env: safeEnvironment(profile), timeout: 30_000 });
  let page;
  try { page = await app.firstWindow({ timeout: 30_000 }); }
  catch {
    try { await app.close(); } catch { /* mapped by the outer flow */ }
    throw new Error("MANUAL_BROWSER_REJECTED");
  }
  return Object.freeze({
    async isAuthenticated() {
      try {
        return await page.evaluate(() => {
          const url = new URL(globalThis.location.href);
          return url.origin === "https://civcom.soia.info" && !url.hash.startsWith("#/login");
        });
      } catch { return false; }
    },
    async navigate(url) { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }); },
    async close() { await app.close(); }
  });
}

async function ttyConfirmation(message) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(message)).trim() === "TAK"; }
  finally { terminal.close(); }
}

function status(code) {
  const messages = Object.freeze({
    ENTER_CREDENTIALS_INTERACTIVELY: "Zaloguj się ręcznie w oknie CivCom/OIDC. Helper nie wpisuje żadnych danych.\n",
    MANUAL_ROUTE_READY: "Trasa pokoju testowego została otwarta. Wykonaj pozycje z checklisty bez danych operacyjnych.\n"
  });
  const message = messages[code];
  if (message !== undefined) process.stdout.write(message);
}

async function runFromTerminal() {
  const result = await runManualProductionFlow({
    invocation: Object.freeze({
      argv: Object.freeze(process.argv.slice(2)),
      ci: process.env.CI !== undefined || process.env.GITHUB_ACTIONS !== undefined || process.env.BUILDKITE !== undefined,
      stdinIsTTY: process.stdin.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true,
      platform: process.platform
    }),
    readCredentials: () => readFixedManualCredentialFile(FIXED_CREDENTIAL_PATH),
    createProfile: createVerifiedManualProfile,
    launchBrowser: launchManualBrowser,
    confirmInteractiveLogin: async () => await ttyConfirmation("Po zakończeniu ręcznego logowania wpisz TAK: "),
    waitForManualCompletion: async () => await ttyConfirmation("Po zakończeniu testów ręcznych wpisz TAK, aby zamknąć aplikację: "),
    removeProfile: removeVerifiedManualProfile,
    status
  });
  process.stdout.write(result.kind === "accepted" ? "MANUAL_CHECK_ACCEPTED\n" : `MANUAL_CHECK_REJECTED_${result.code}\n`);
  if (result.kind !== "accepted") process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runFromTerminal();
