import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const matrix = readFileSync(new URL("../docs/testing/manual-acceptance-matrix.md", import.meta.url), "utf8");

describe("Polish manual acceptance matrix", () => {
  it("contains every required platform, artifact, status, and evidence column", () => {
    for (const value of [
      "Windows 10 x64", "Windows 11 x64", "macOS 13", "macOS 14", "macOS 15+", "Intel", "Apple Silicon",
      "Ubuntu 22.04", "Ubuntu 24.04", "Wayland", "X11", "Debian 12", "Fedora current", "NSIS", "DEB", "AppImage",
      "artefakt SHA-256", "build SHA", "warunki", "czynność", "wynik oczekiwany", "dowód zredagowany",
      "PASS/FAIL/BLOCKED/N/A", "wymagany drugi tester", "uwagi"
    ]) expect(matrix).toContain(value);
  });

  it("covers the approved lifecycle and treats missing prerequisites as BLOCKED", () => {
    for (const topic of [
      "notarization", "stapling", "--no-sandbox", "fuses", "ASAR", "WebPlatform", "OIDC", "sesji po restarcie",
      "wylogowanie", "zaszyfrowanej wiadomości", "zaszyfrowanego pliku", "powiadomienie", "audio", "wideo",
      "jednego okna", "całego monitora", "odmowa", "ponowne nadanie", "utrata sieci", "tray", "autostart",
      "pojedyncza instancja", "poprzedniej podpisanej wersji", "zakończyć połączenia", "wylogować zbędne urządzenia"
    ]) expect(matrix.toLowerCase()).toContain(topic.toLowerCase());
    expect(matrix).toMatch(/brak[^\n]+systemu[^\n]+BLOCKED/i);
    expect(matrix).toMatch(/drugiego testera[^\n]+BLOCKED/i);
    expect(matrix).toMatch(/poprzedniej podpisanej wersji[^\n]+BLOCKED/i);
    expect(matrix).toMatch(/pokoj[^\n]+operacyjn/i);
  });

  it("forbids sensitive evidence", () => {
    for (const value of ["nazwy użytkownika", "identyfikatora ani nazwy pokoju", "treści wiadomości", "nazwy pliku", "URL ani parametrów", "zrzutu ekranu zalogowanej sesji"]) expect(matrix).toContain(value);
  });
});
