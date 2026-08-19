import { describe, expect, it, vi } from "vitest";
import { createLocalPickerHost, PICKER_IPC_CHANNELS } from "../src/screen-share/local-picker-host.js";

const DOCUMENT_URL = "civcom-local://picker/index.html";
const PRELOAD_PATH = "/Applications/CivCom/dist/screen-share/picker-preload.cjs";

function fixture(setupOptions: Readonly<{
  failDuringSetup?: boolean;
  failDuringLoad?: boolean;
  failDuringShow?: boolean;
}> = {}) {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const windowListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const contentsListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const mainFrame = { url: DOCUMENT_URL };
  let destroyed = false;
  const contents = {
    mainFrame,
    getURL: () => DOCUMENT_URL,
    isDestroyed: () => destroyed,
    setWindowOpenHandler: vi.fn(() => {
      if (setupOptions.failDuringSetup === true) throw new Error("setup failed");
    }),
    on: (event: string, listener: (...args: unknown[]) => void) => { contentsListeners.set(event, [...(contentsListeners.get(event) ?? []), listener]); },
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn() }
  };
  const window = {
    webContents: contents,
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => { destroyed = true; for (const listener of windowListeners.get("closed") ?? []) listener(); }),
    show: vi.fn(() => {
      if (setupOptions.failDuringShow === true) throw new Error("show failed");
    }),
    loadURL: vi.fn((url: string) => {
      if (url !== DOCUMENT_URL) throw new Error("wrong local URL");
      if (setupOptions.failDuringLoad === true) throw new Error("load failed");
      return Promise.resolve();
    }),
    on: (event: string, listener: (...args: unknown[]) => void) => { windowListeners.set(event, [...(windowListeners.get(event) ?? []), listener]); },
    once: (event: string, listener: (...args: unknown[]) => void) => { windowListeners.set(event, [...(windowListeners.get(event) ?? []), listener]); }
  };
  let options: unknown;
  const host = createLocalPickerHost({
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, handler); },
      removeHandler: (channel: string) => { ipcHandlers.delete(channel); }
    } as never,
    createWindow: (value) => { options = value; return window as never; },
    preloadPath: PRELOAD_PATH
  });
  return {
    host,
    window,
    contents,
    mainFrame,
    markDestroyed: () => { destroyed = true; },
    options: () => options,
    invoke: async (channel: string, event: unknown, value?: unknown) => await ipcHandlers.get(channel)?.(event, value),
    emitWindow: (event: string, ...args: unknown[]) => { for (const listener of windowListeners.get(event) ?? []) listener(...args); },
    emitContents: (event: string, ...args: unknown[]) => { for (const listener of contentsListeners.get(event) ?? []) listener(...args); },
    handlers: ipcHandlers
  };
}

describe("local picker host", () => {
  it("returns source data only to the active exact local main frame", async () => {
    const f = fixture();
    const sources = [{ token: "S".repeat(43), name: "Monitor", kind: "screen" as const }];
    f.host.present({ generation: 6, sources }, vi.fn());
    const validEvent = { sender: f.contents, senderFrame: f.mainFrame };
    await expect(f.invoke(PICKER_IPC_CHANNELS.list, validEvent)).resolves.toEqual({ generation: 6, sources });
    await expect(f.invoke(PICKER_IPC_CHANNELS.list, { sender: {}, senderFrame: {} })).resolves.toEqual({ generation: 0, sources: [] });
  });

  it("validates generation before selection, clears ephemeral data, and settles once", async () => {
    const f = fixture();
    const settle = vi.fn();
    f.host.present({ generation: 3, sources: [{ token: "T".repeat(43), name: "Okno", kind: "window" }] }, settle);
    const event = { sender: f.contents, senderFrame: f.mainFrame };
    await expect(f.invoke(PICKER_IPC_CHANNELS.choose, event, { generation: 2, token: "T".repeat(43) })).resolves.toBe(false);
    await expect(f.invoke(PICKER_IPC_CHANNELS.choose, event, { generation: 3, token: "T".repeat(43) })).resolves.toBe(true);
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({ generation: 3, token: "T".repeat(43) });
    expect(f.window.destroy).toHaveBeenCalledOnce();
    await expect(f.invoke(PICKER_IPC_CHANNELS.list, event)).resolves.toEqual({ generation: 0, sources: [] });
  });

  it("treats the Polish cancel action, picker close, load failure, and shutdown as cancellation", async () => {
    for (const mode of ["ipc", "close", "load", "shutdown"] as const) {
      const f = fixture();
      const settle = vi.fn();
      f.host.present({ generation: 8, sources: [{ token: "U".repeat(43), name: "Ekran", kind: "screen" }] }, settle);
      if (mode === "ipc") await f.invoke(PICKER_IPC_CHANNELS.cancel, { sender: f.contents, senderFrame: f.mainFrame }, { generation: 8 });
      if (mode === "close") f.emitWindow("closed");
      if (mode === "load") f.emitContents("did-fail-load", {}, -2, "failed", DOCUMENT_URL, true);
      if (mode === "shutdown") f.host.shutdown();
      expect(settle).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledWith({ kind: "cancel" });
    }
  });

  it("fails closed if picker security setup or local loading throws synchronously", async () => {
    for (const mode of ["setup", "load"] as const) {
      const f = fixture({
        failDuringSetup: mode === "setup",
        failDuringLoad: mode === "load"
      });
      const settle = vi.fn();
      expect(() => f.host.present({
        generation: 9,
        sources: [{ token: "W".repeat(43), name: "Ekran", kind: "screen" }]
      }, settle)).not.toThrow();
      expect(settle).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledWith({ kind: "cancel" });
      expect(f.window.destroy).toHaveBeenCalledOnce();
      await expect(f.invoke(PICKER_IPC_CHANNELS.list, {
        sender: f.contents,
        senderFrame: f.mainFrame
      })).resolves.toEqual({ generation: 0, sources: [] });
    }
  });

  it("cancels once if the picker renderer crashes, vanishes, or showing the window fails", () => {
    for (const mode of ["crash", "destroyed", "show"] as const) {
      const f = fixture({ failDuringShow: mode === "show" });
      const settle = vi.fn();
      f.host.present({
        generation: 10,
        sources: [{ token: "X".repeat(43), name: "Okno", kind: "window" }]
      }, settle);
      if (mode === "crash") f.emitContents("render-process-gone");
      if (mode === "destroyed") f.markDestroyed();
      if (mode === "destroyed") f.emitWindow("ready-to-show");
      if (mode === "show") f.emitWindow("ready-to-show");
      expect(settle).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledWith({ kind: "cancel" });
      expect(f.window.destroy).toHaveBeenCalledTimes(mode === "destroyed" ? 0 : 1);
    }
  });

  it("constructs a sandboxed picker, denies permissions/popups, and blocks off-document navigation", () => {
    const f = fixture();
    f.host.present({ generation: 1, sources: [{ token: "V".repeat(43), name: "Ekran", kind: "screen" }] }, vi.fn());
    expect(f.options()).toMatchObject({ show: false, title: "Wybierz ekran lub okno — CivCom", webPreferences: { sandbox: true, preload: PRELOAD_PATH } });
    expect(f.contents.setWindowOpenHandler).toHaveBeenCalled();
    expect(f.window.loadURL).toHaveBeenCalledWith(DOCUMENT_URL);
    const permissionCallback = f.contents.session.setPermissionRequestHandler.mock.calls[0]?.[0] as ((contents: unknown, permission: unknown, callback: (allowed: boolean) => void) => void);
    const permission = vi.fn();
    permissionCallback({}, "media", permission);
    expect(permission).toHaveBeenCalledWith(false);
    const permissionCheck = f.contents.session.setPermissionCheckHandler.mock.calls[0]?.[0] as (() => boolean);
    expect(permissionCheck()).toBe(false);
    const deviceCheck = f.contents.session.setDevicePermissionHandler.mock.calls[0]?.[0] as (() => boolean);
    expect(deviceCheck()).toBe(false);
    const navigation = { preventDefault: vi.fn() };
    f.emitContents("will-navigate", navigation, "https://civcom.soia.info/");
    expect(navigation.preventDefault).toHaveBeenCalledOnce();
  });
});
