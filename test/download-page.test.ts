import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type PageApi = Readonly<{
  detectPlatform(input: Readonly<{ userAgent?: string; platform?: string; maxTouchPoints?: number; userAgentDataPlatform?: string }>): string;
  boot(input: Readonly<{ document: any; navigator: any; fetch: any }>): Promise<void>;
}>;

async function loadPageApi(): Promise<PageApi> {
  const script = await readFile(new URL("../docs/downloads.js", import.meta.url), "utf8");
  const context: Record<string, any> = { console: { error: () => undefined } };
  context.globalThis = context;
  runInNewContext(script, context, { filename: "downloads.js" });
  if (typeof context.CivComDownloads !== "object") throw new Error("missing-page-api");
  return context.CivComDownloads as PageApi;
}

const contract = Object.freeze({
  schemaVersion: 1,
  releaseBaseUrl: "https://github.com/KGPSP/civcom-desktop/releases/latest/download",
  latestReleaseUrl: "https://github.com/KGPSP/civcom-desktop/releases/latest",
  assets: {
    windowsInstaller: "CivCom-Windows-x64.exe",
    windowsBlockmap: "CivCom-Windows-x64.exe.blockmap",
    windowsMetadata: "latest.yml",
    macDmg: "CivCom-macOS-universal.dmg",
    macZip: "CivCom-macOS-universal.zip",
    macBlockmap: "CivCom-macOS-universal.zip.blockmap",
    macMetadata: "latest-mac.yml",
    linuxAppImage: "CivCom-Linux-x86_64.AppImage",
    linuxDeb: "CivCom-Linux-x86_64.deb",
    linuxMetadata: "latest-linux.yml",
    buildSbom: "CivCom-build.spdx.json",
    checksums: "SHA256SUMS"
  }
});

describe("Polish static download page", () => {
  it("detects Android before Linux and excludes iPad masquerading as Mac", async () => {
    const { detectPlatform } = await loadPageApi();
    const cases = [
      [{ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" }, "windows"],
      [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6)", platform: "MacIntel", maxTouchPoints: 0 }, "macos"],
      [{ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" }, "linux"],
      [{ userAgent: "Mozilla/5.0 (Linux; Android 15)", platform: "Linux armv8l" }, "mobile"],
      [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Mobile/15E148", platform: "MacIntel", maxTouchPoints: 5 }, "mobile"],
      [{ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone" }, "mobile"],
      [{ userAgent: "curl/8.0", platform: "" }, "unknown"]
    ] as const;
    for (const [input, expected] of cases) expect(detectPlatform(input)).toBe(expected);
  });

  it("changes one CTA from the canonical JSON without clicking or navigating", async () => {
    const { boot } = await loadPageApi();
    const choices = [
      ["Win32", "Mozilla/5.0 (Windows NT 10.0)", "CivCom-Windows-x64.exe"],
      ["MacIntel", "Mozilla/5.0 (Macintosh)", "CivCom-macOS-universal.dmg"],
      ["Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)", "CivCom-Linux-x86_64.AppImage"],
      ["Linux armv8l", "Mozilla/5.0 (Linux; Android 15)", undefined],
      ["", "curl/8", undefined]
    ] as const;
    for (const [platform, userAgent, filename] of choices) {
      const click = vi.fn();
      const primary = { href: "", textContent: "", click };
      const alternatives = Object.values(contract.assets).map((asset) => ({ dataset: { asset }, href: "" }));
      const document = {
        getElementById: (id: string) => id === "primary-download" ? primary : undefined,
        querySelectorAll: (selector: string) => selector === "[data-asset]" ? alternatives : []
      };
      const locationBefore = "https://example.invalid/downloads";
      await boot({ document, navigator: { platform, userAgent, maxTouchPoints: 0 }, fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => contract }) });
      const expected = filename === undefined ? contract.latestReleaseUrl : `${contract.releaseBaseUrl}/${filename}`;
      expect(primary.href).toBe(expected);
      expect(click).not.toHaveBeenCalled();
      expect(locationBefore).toBe("https://example.invalid/downloads");
      expect(alternatives.find((item) => item.dataset.asset === "CivCom-Linux-x86_64.deb")?.href).toBe(`${contract.releaseBaseUrl}/CivCom-Linux-x86_64.deb`);
    }
  });

  it("contains strict local-only page resources, Polish content, manual alternatives, checksums, and SPDX", async () => {
    const html = await readFile(new URL("../docs/index.html", import.meta.url), "utf8");
    expect(html).toContain('<html lang="pl">');
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
    for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'"]) expect(csp).toContain(directive);
    expect(html).toContain("Alternatywne pliki do pobrania");
    expect(html).toContain("CivCom-Linux-x86_64.deb");
    expect(html).toContain("SHA256SUMS");
    expect(html).toContain("CivCom-build.spdx.json");
    expect(html).not.toMatch(/analytics|googletag|fonts\.google|https?:\/\/(?!github\.com\/KGPSP\/civcom-desktop)/i);
    expect(html).not.toMatch(/<script(?![^>]+src=)/i);
  });
});
