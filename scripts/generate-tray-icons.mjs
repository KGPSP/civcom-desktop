// Provenance: raster derivatives of the vetted static assets/civcom.svg mark.
// macOS sips is used locally; no network input is accepted.
import { execFileSync } from "node:child_process";

execFileSync("sips", ["-s", "format", "png", "assets/civcom.svg", "--out", "assets/civcom-tray.png"], { stdio: "inherit" });
execFileSync("sips", ["-z", "44", "44", "assets/civcom-tray.png", "--out", "assets/civcom-tray.png"], { stdio: "inherit" });
execFileSync("sips", ["-z", "88", "88", "assets/civcom-tray.png", "--out", "assets/civcom-tray@2x.png"], { stdio: "inherit" });
