"use strict";

const { app } = require("electron");
const { chmodSync, mkdirSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");
const { scrubSensitiveElectronEnvironment } = require("./electron-environment.cjs");

const profileInput = process.env.CIVCOM_MANUAL_PROFILE_ROOT;
scrubSensitiveElectronEnvironment(process.env);

let profile;
try {
  const parent = realpathSync(tmpdir());
  profile = realpathSync(profileInput);
  if (!profile.startsWith(`${parent}${sep}`) || !basename(profile).startsWith("civcom-manual-electron-")) throw new Error("PROFILE_REJECTED");
  for (const [name, appPath] of [["userData", "user-data"], ["sessionData", "session-data"], ["downloads", "downloads"]]) {
    const directory = join(profile, appPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    app.setPath(name, directory);
  }
} catch {
  app.exit(2);
}

if (profile !== undefined) {
  const projectRoot = resolve(__dirname, "..", "..");
  void import(pathToFileURL(join(projectRoot, "dist", "main.js")).href).catch(() => app.exit(2));
}
