import { posix, win32 } from "node:path";

export type PackagedSmokeResult = Readonly<{
  schemaVersion: 1;
  status: "ok";
  windowVisible: true;
  loadedUrl: string;
}>;

export function isPackagedSmokeRequested(input: Readonly<{ isPackaged: boolean; argv: readonly string[] }>): boolean {
  if (input.isPackaged !== true || !Array.isArray(input.argv)) return false;
  return input.argv.filter((value) => value === "--civcom-packaged-smoke").length === 1
    && !input.argv.some((value) => value.startsWith("--civcom-packaged-smoke=") || [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127));
}

export function packagedSmokeResultPath(userDataDirectory: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === "win32" ? win32 : posix;
  if (typeof userDataDirectory !== "string" || !pathApi.isAbsolute(userDataDirectory)) throw new Error("invalid-packaged-smoke-user-data");
  return pathApi.join(userDataDirectory, "packaged-smoke.json");
}

export function createPackagedSmokeResult(input: Readonly<{ windowVisible: boolean; loadedUrl: string }>): PackagedSmokeResult {
  if (input.windowVisible !== true || typeof input.loadedUrl !== "string" || !input.loadedUrl.startsWith("data:text/html;charset=utf-8,") || input.loadedUrl.length > 64 * 1024) throw new Error("invalid-packaged-smoke-result");
  return Object.freeze({ schemaVersion: 1, status: "ok", windowVisible: true, loadedUrl: input.loadedUrl });
}
