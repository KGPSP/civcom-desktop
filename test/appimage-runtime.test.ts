import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVerifiedAppImageRuntime } from "../src/desktop/appimage-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function type2Header(type = 2): Buffer {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46], 0);
  header.set([0x41, 0x49, type], 8);
  return header;
}

function fixture(): Readonly<{
  root: string;
  appImagePath: string;
  appDir: string;
  executablePath: string;
  resourcesPath: string;
  input: Readonly<{ appImagePath: string; appDir: string; executablePath: string; resourcesPath: string }>;
}> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "civcom-appimage-"));
  roots.push(root);
  const appImagePath = join(root, "CivCom-Linux-x86_64.AppImage");
  writeFileSync(appImagePath, type2Header(), { mode: 0o755 });
  const appDir = join(root, ".mount_CivCom");
  mkdirSync(appDir, { mode: 0o755 });
  const appRun = join(appDir, "AppRun");
  writeFileSync(appRun, "#!/bin/sh\n", { mode: 0o755 });
  const executablePath = join(appDir, "civcom");
  writeFileSync(executablePath, "runtime", { mode: 0o755 });
  const resourcesPath = join(appDir, "resources");
  mkdirSync(resourcesPath, { mode: 0o755 });
  return Object.freeze({
    root,
    appImagePath,
    appDir,
    executablePath,
    resourcesPath,
    input: Object.freeze({ appImagePath, appDir, executablePath, resourcesPath })
  });
}

describe("AppImage runtime identity", () => {
  it("accepts only a canonical executable Type2 AppImage bound to the builder AppDir runtime", () => {
    const value = fixture();
    expect(resolveVerifiedAppImageRuntime(value.input)).toBe(value.appImagePath);
  });

  it("rejects an arbitrary executable, Type1 image, truncated header, or non-executable image", () => {
    for (const mutate of [
      (path: string) => writeFileSync(path, Buffer.from("not an AppImage")),
      (path: string) => writeFileSync(path, type2Header(1)),
      (path: string) => writeFileSync(path, type2Header().subarray(0, 10)),
      (path: string) => chmodSync(path, 0o644)
    ]) {
      const value = fixture();
      mutate(value.appImagePath);
      expect(resolveVerifiedAppImageRuntime(value.input)).toBeUndefined();
    }
  });

  it("rejects relative, symlinked, non-canonical, and control-character APPIMAGE values", () => {
    const value = fixture();
    const symlink = join(value.root, "linked.AppImage");
    symlinkSync(value.appImagePath, symlink);
    for (const appImagePath of [
      "CivCom.AppImage",
      symlink,
      `${value.appImagePath}\n`,
      `${value.root}/./CivCom-Linux-x86_64.AppImage`
    ]) {
      expect(resolveVerifiedAppImageRuntime({ ...value.input, appImagePath })).toBeUndefined();
    }
  });

  it("rejects APPDIR, executable, or resources values that are not the exact mounted runtime", () => {
    const value = fixture();
    const outside = join(value.root, "outside");
    mkdirSync(outside);
    const outsideExecutable = join(outside, "civcom");
    writeFileSync(outsideExecutable, "runtime", { mode: 0o755 });
    const outsideResources = join(outside, "resources");
    mkdirSync(outsideResources);
    for (const changes of [
      { appDir: outside },
      { executablePath: outsideExecutable },
      { resourcesPath: outsideResources },
      { appDir: `${value.appDir}/..` },
      { executablePath: `${value.executablePath}\n` }
    ]) {
      expect(resolveVerifiedAppImageRuntime({ ...value.input, ...changes })).toBeUndefined();
    }
  });

  it("rejects missing, symlinked, or non-executable AppRun and civcom runtime entries", () => {
    {
      const value = fixture();
      chmodSync(join(value.appDir, "AppRun"), 0o644);
      expect(resolveVerifiedAppImageRuntime(value.input)).toBeUndefined();
    }
    {
      const value = fixture();
      rmSync(join(value.appDir, "AppRun"));
      symlinkSync("civcom", join(value.appDir, "AppRun"));
      expect(resolveVerifiedAppImageRuntime(value.input)).toBeUndefined();
    }
    {
      const value = fixture();
      chmodSync(value.executablePath, 0o644);
      expect(resolveVerifiedAppImageRuntime(value.input)).toBeUndefined();
    }
  });
});
