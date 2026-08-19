import { copyFile, mkdir, rm } from "node:fs/promises";

await mkdir("dist", { recursive: true });
for (const file of ["offline.html", "offline.js", "offline.css"]) await copyFile(`src/${file}`, `dist/${file}`);
await mkdir("dist/screen-share", { recursive: true });
for (const stale of ["picker-preload.js", "picker-preload.js.map"]) await rm(`dist/screen-share/${stale}`, { force: true });
for (const file of ["picker.html", "picker.css", "picker-preload.cjs"]) await copyFile(`src/screen-share/${file}`, `dist/screen-share/${file}`);
