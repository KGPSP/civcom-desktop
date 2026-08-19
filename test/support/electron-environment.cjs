"use strict";

const SAFE_ELECTRON_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "TMP",
  "TEMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS"
]);

const SAFE_ELECTRON_ENVIRONMENT_KEY_SET = new Set(SAFE_ELECTRON_ENVIRONMENT_KEYS);
const SENSITIVE_ENVIRONMENT_KEY = /^(?:(?:CI(?:$|_)|GITHUB_|ACTIONS_|NODE_|NPM_|DEBUG$|PWDEBUG$|ELECTRON_|CIVCOM_)|.*(?:TOKEN|SECRET|PASSWORD|PASS|COOKIE|AUTH|PROXY))/i;

function copySafeElectronEnvironment(source) {
  const environment = {};
  if (source === null || (typeof source !== "object" && typeof source !== "function")) return environment;
  for (const key of SAFE_ELECTRON_ENVIRONMENT_KEYS) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(source, key); }
    catch { continue; }
    if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") environment[key] = descriptor.value;
  }
  return environment;
}

function scrubSensitiveElectronEnvironment(environment) {
  if (environment === null || (typeof environment !== "object" && typeof environment !== "function")) return;
  for (const key of Object.keys(environment)) {
    if (!SAFE_ELECTRON_ENVIRONMENT_KEY_SET.has(key) && SENSITIVE_ENVIRONMENT_KEY.test(key)) delete environment[key];
  }
}

module.exports = Object.freeze({ copySafeElectronEnvironment, scrubSensitiveElectronEnvironment });
