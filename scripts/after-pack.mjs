import { readFile } from "node:fs/promises";
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";
import { createFuseConfig, resolveElectronExecutable, shouldFlipFuses } from "./fuse-policy.mjs";

const packageMetadata = JSON.parse(await readFile(new URL("../node_modules/@electron/fuses/package.json", import.meta.url), "utf8"));
if (packageMetadata.version !== "2.1.3") throw new Error("The direct @electron/fuses package must be exactly 2.1.3");

export default async function afterPack(context) {
  if (!shouldFlipFuses({ platform: context.electronPlatformName, arch: context.arch })) return;
  const executable = resolveElectronExecutable({
    platform: context.electronPlatformName,
    appOutDir: context.appOutDir,
    productFilename: context.packager.appInfo.productFilename,
    executableName: context.packager.executableName
  });
  await flipFuses(executable, createFuseConfig({ FuseVersion, FuseV1Options }));
}
