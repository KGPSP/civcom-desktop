import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createPickerNavigationCallbacks,
  createPickerWebPreferences,
  validatePickerIpcSender
} from "../src/screen-share/picker-security.js";
import { createPickerPreloadApi } from "../src/screen-share/preload-api.js";
import { installDisplayMediaRequestHandler } from "../src/screen-share/install.js";
import { runPickerAction, setElementText } from "../src/screen-share/picker-view.js";

describe("local picker isolation", () => {
  it("uses a dedicated minimal preload and hardened sandboxed preferences", () => {
    const preferences = createPickerWebPreferences("/Applications/CivCom/dist/screen-share/picker-preload.cjs");
    expect(preferences).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      partition: "civcom-picker",
      preload: "/Applications/CivCom/dist/screen-share/picker-preload.cjs"
    });
    expect(createPickerWebPreferences("relative/preload.js")).toBeUndefined();
  });

  it("blocks picker popups and every navigation away from its exact local document", () => {
    const gate = createPickerNavigationCallbacks("civcom-local://picker/index.html");
    expect(gate.windowOpen()).toEqual({ action: "deny" });
    const allowed = { preventDefault: vi.fn() };
    gate.navigate(allowed, "civcom-local://picker/index.html");
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    for (const url of ["https://civcom.soia.info/", "file:///tmp/picker.html", "data:text/html,x"] ) {
      const event = { preventDefault: vi.fn() };
      gate.navigate(event, url);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it("ships a local HTML artifact with strict CSP and no inline executable content", () => {
    const html = readFileSync(new URL("../src/screen-share/picker.html", import.meta.url), "utf8");
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src data:");
    expect(csp).toContain("connect-src 'none'");
    expect(html).not.toMatch(/<script(?![^>]+src=)/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain('id="system-audio-option"');
    expect(html).toContain('id="system-audio" type="checkbox"');
    expect(html).toContain("Dołącz dźwięk systemowy");
  });

  it("keeps source actions retryable after a rejected picker IPC decision", () => {
    const renderer = readFileSync(new URL("../src/screen-share/picker-renderer.ts", import.meta.url), "utf8");
    expect(renderer).toContain('button.addEventListener("click", () => choose(source.token));');
  });

  it("renders hostile names through textContent instead of HTML", () => {
    let text = "";
    const element = Object.defineProperties({}, {
      textContent: { set: (value: string) => { text = value; } },
      innerHTML: { set: () => { throw new Error("HTML injection"); } }
    });
    expect(() => setElementText(element, "<img src=x onerror=alert(1)>")).not.toThrow();
    expect(text).toBe("<img src=x onerror=alert(1)>");
  });

  it("re-enables picker controls when an IPC choice is rejected or fails", async () => {
    for (const action of [
      vi.fn().mockResolvedValue(false),
      vi.fn().mockRejectedValue(new Error("IPC failed"))
    ]) {
      const pending: boolean[] = [];
      await expect(runPickerAction(action, (value) => pending.push(value))).resolves.toBe(false);
      expect(pending).toEqual([true, false]);
    }
    const accepted: boolean[] = [];
    await expect(runPickerAction(vi.fn().mockResolvedValue(true), (value) => accepted.push(value))).resolves.toBe(true);
    expect(accepted).toEqual([true]);
  });
});

describe("picker IPC boundary", () => {
  function contents(url = "civcom-local://picker/index.html") {
    const mainFrame = { url };
    return { mainFrame, getURL: () => url, isDestroyed: () => false };
  }

  it("accepts only the active picker's exact main frame and local document", () => {
    const expectedContents = contents();
    const context = { contents: expectedContents, documentUrl: expectedContents.getURL(), generation: 4 };
    expect(validatePickerIpcSender(context, { sender: expectedContents, senderFrame: expectedContents.mainFrame }, 4)).toBe(true);
    expect(validatePickerIpcSender(context, { sender: contents("https://civcom.soia.info/"), senderFrame: {} }, 4)).toBe(false);
    expect(validatePickerIpcSender(context, { sender: expectedContents, senderFrame: { url: expectedContents.getURL() } }, 4)).toBe(false);
    expect(validatePickerIpcSender(context, { sender: expectedContents, senderFrame: expectedContents.mainFrame }, 3)).toBe(false);
    const wrongFile = contents("civcom-local://picker/unknown.html");
    expect(validatePickerIpcSender(context, { sender: wrongFile, senderFrame: wrongFile.mainFrame }, 4)).toBe(false);
  });

  it("denies destroyed, accessor, proxy, and forged IPC events without throwing", () => {
    const expectedContents = contents();
    const context = { contents: expectedContents, documentUrl: expectedContents.getURL(), generation: 1 };
    const destroyed = { ...expectedContents, isDestroyed: () => true };
    const accessor = Object.defineProperty({}, "sender", { get: () => { throw new Error("trap"); } });
    const proxy = new Proxy({}, { get: () => { throw new Error("trap"); } });
    for (const event of [null, {}, accessor, proxy, { sender: destroyed, senderFrame: destroyed.mainFrame }]) {
      expect(() => validatePickerIpcSender(context, event, 1)).not.toThrow();
      expect(validatePickerIpcSender(context, event, 1)).toBe(false);
    }
  });

  it("exposes only a frozen get/choose/cancel API and keeps generation inside the preload", async () => {
    const bridge = {
      list: vi.fn().mockResolvedValue({ generation: 12, sources: [{ token: "Q".repeat(43), name: "Monitor", kind: "screen", thumbnailDataUrl: "data:image/png;base64,AA==" }] }),
      choose: vi.fn().mockResolvedValue(true),
      cancel: vi.fn().mockResolvedValue(true)
    };
    const api = createPickerPreloadApi(bridge);
    expect(Object.keys(api).sort()).toEqual(["cancel", "choose", "getSources", "systemAudioAvailable"]);
    expect(Object.isFrozen(api)).toBe(true);
    expect("invoke" in api).toBe(false);
    expect("send" in api).toBe(false);
    expect("electron" in api).toBe(false);
    await expect(api.getSources()).resolves.toEqual([{ token: "Q".repeat(43), name: "Monitor", kind: "screen", thumbnailDataUrl: "data:image/png;base64,AA==" }]);
    await api.choose("Q".repeat(43));
    expect(bridge.choose).toHaveBeenCalledWith({ generation: 12, token: "Q".repeat(43), includeSystemAudio: false });
    await api.cancel();
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it("forwards audio consent only for the current generation when the host made it available", async () => {
    const token = "Z".repeat(43);
    const bridge = {
      list: vi.fn()
        .mockResolvedValueOnce({ generation: 20, sources: [{ token, name: "Ekran", kind: "screen" }], systemAudioAvailable: true })
        .mockResolvedValueOnce({ generation: 21, sources: [{ token, name: "Ekran", kind: "screen" }], systemAudioAvailable: false }),
      choose: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(true),
      cancel: vi.fn()
    };
    const api = createPickerPreloadApi(bridge);

    await api.getSources();
    expect(api.systemAudioAvailable()).toBe(true);
    await expect(api.choose(token, true)).resolves.toBe(false);
    expect(api.systemAudioAvailable()).toBe(true);
    await expect(api.choose(token, true)).resolves.toBe(true);
    expect(bridge.choose).toHaveBeenNthCalledWith(2, { generation: 20, token, includeSystemAudio: true });
    expect(api.systemAudioAvailable()).toBe(false);

    await api.getSources();
    expect(api.systemAudioAvailable()).toBe(false);
    await expect(api.choose(token, true)).resolves.toBe(true);
    expect(bridge.choose).toHaveBeenNthCalledWith(3, { generation: 21, token, includeSystemAudio: false });
  });

  it("rejects a non-PNG thumbnail payload instead of forwarding it to the picker DOM", async () => {
    const bridge = {
      list: vi.fn().mockResolvedValue({
        generation: 2,
        sources: [{
          token: "R".repeat(43),
          name: "Monitor",
          kind: "screen",
          thumbnailDataUrl: "data:image/png;base64,not base64!"
        }]
      }),
      choose: vi.fn(),
      cancel: vi.fn()
    };
    await expect(createPickerPreloadApi(bridge).getSources()).resolves.toEqual([]);
  });

  it("queues an early cancel until the active generation arrives", async () => {
    let resolveList: ((value: unknown) => void) | undefined;
    const bridge = {
      list: vi.fn(() => new Promise<unknown>((resolve) => { resolveList = resolve; })),
      choose: vi.fn(),
      cancel: vi.fn().mockResolvedValue(true)
    };
    const api = createPickerPreloadApi(bridge);
    const loading = api.getSources();
    const cancelling = api.cancel();
    expect(bridge.cancel).not.toHaveBeenCalled();
    await Promise.resolve();
    resolveList?.({ generation: 15, sources: [], systemAudioAvailable: true });
    await loading;
    await cancelling;
    expect(bridge.cancel).toHaveBeenCalledOnce();
    expect(bridge.cancel).toHaveBeenCalledWith({ generation: 15 });
    expect(api.systemAudioAvailable()).toBe(false);
    await expect(api.choose("Q".repeat(43), true)).resolves.toBe(false);
    expect(bridge.choose).not.toHaveBeenCalled();
  });

  it("preserves the current generation when a choose or cancel IPC attempt is rejected", async () => {
    const token = "Y".repeat(43);
    const bridge = {
      list: vi.fn().mockResolvedValue({
        generation: 16,
        sources: [{ token, name: "Ekran", kind: "screen" }]
      }),
      choose: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      cancel: vi.fn().mockRejectedValueOnce(new Error("IPC failed")).mockResolvedValueOnce(true)
    };
    const chooseApi = createPickerPreloadApi(bridge);
    await chooseApi.getSources();
    await expect(chooseApi.choose(token)).resolves.toBe(false);
    await expect(chooseApi.choose(token)).resolves.toBe(true);
    expect(bridge.choose).toHaveBeenCalledTimes(2);
    expect(bridge.choose).toHaveBeenNthCalledWith(2, { generation: 16, token, includeSystemAudio: false });

    const cancelApi = createPickerPreloadApi(bridge);
    await cancelApi.getSources();
    await expect(cancelApi.cancel()).rejects.toThrow("IPC failed");
    await expect(cancelApi.cancel()).resolves.toBe(true);
    expect(bridge.cancel).toHaveBeenCalledTimes(2);
    expect(bridge.cancel).toHaveBeenNthCalledWith(2, { generation: 16 });
  });
});

describe("display-media handler installation", () => {
  it("opts into the system picker only on macOS 15 and safely delegates any fallback handler call", () => {
    for (const [environment, expected] of [
      [{ platform: "darwin", systemVersion: "15.1" }, true],
      [{ platform: "darwin", systemVersion: "14.7" }, false],
      [{ platform: "win32" }, false],
      [{ platform: "linux", sessionType: "wayland" }, false]
    ] as const) {
      let installed: Parameters<Electron.Session["setDisplayMediaRequestHandler"]>[0] | undefined;
      let options: unknown;
      const handle = vi.fn();
      installDisplayMediaRequestHandler({
        session: { setDisplayMediaRequestHandler: (handler, opts) => { installed = handler; options = opts; } },
        environment,
        handle
      });
      expect(options).toEqual({ useSystemPicker: expected });
      const callback = vi.fn();
      const request = { frame: null, securityOrigin: "https://civcom.soia.info", videoRequested: true, audioRequested: false, userGesture: true };
      installed?.(request, callback);
      expect(handle).toHaveBeenCalledWith(request, callback);
    }
  });
});
