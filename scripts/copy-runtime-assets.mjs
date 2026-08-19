import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
for (const file of ["offline.html", "offline.js", "offline.css"]) await copyFile(`src/${file}`, `dist/${file}`);
