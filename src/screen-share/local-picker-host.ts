import type { PickerHandle, PickerPresentation } from "./coordinator.js";
import { PICKER_DOCUMENT_URL } from "./local-protocol.js";
import { createPickerNavigationCallbacks, createPickerWebPreferences, validatePickerIpcSender } from "./picker-security.js";

export const PICKER_IPC_CHANNELS = Object.freeze({
  list: "civcom-screen-picker:list",
  choose: "civcom-screen-picker:choose",
  cancel: "civcom-screen-picker:cancel"
});

type ActivePicker = {
  readonly window: Electron.BrowserWindow;
  readonly generation: number;
  readonly documentUrl: string;
  readonly settle: (decision: unknown) => void;
  presentation: PickerPresentation | undefined;
};

type PickerSelection = Readonly<{
  generation: number;
  token: string;
  includeSystemAudio: boolean;
}>;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type LocalPickerHost = Readonly<{
  present(presentation: PickerPresentation, settle: (decision: unknown) => void): PickerHandle;
  shutdown(): void;
}>;

function ownGeneration(value: unknown): unknown {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "generation");
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function snapshotSelection(value: unknown): PickerSelection | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const generation = Object.getOwnPropertyDescriptor(value, "generation");
    const token = Object.getOwnPropertyDescriptor(value, "token");
    const audio = Object.getOwnPropertyDescriptor(value, "includeSystemAudio");
    if (
      generation === undefined || !("value" in generation) || !Number.isSafeInteger(generation.value) || generation.value <= 0 ||
      token === undefined || !("value" in token) || typeof token.value !== "string" || !TOKEN_PATTERN.test(token.value) ||
      audio === undefined || !("value" in audio) || typeof audio.value !== "boolean"
    ) return undefined;
    return Object.freeze({ generation: generation.value as number, token: token.value, includeSystemAudio: audio.value });
  } catch {
    return undefined;
  }
}

export function createLocalPickerHost(dependencies: Readonly<{
  ipcMain: Electron.IpcMain;
  createWindow(options: Electron.BrowserWindowConstructorOptions): Electron.BrowserWindow;
  preloadPath: string;
}>): LocalPickerHost {
  const documentUrl = PICKER_DOCUMENT_URL;
  const preferences = createPickerWebPreferences(dependencies.preloadPath);
  if (preferences === undefined) throw new Error("invalid-picker-preload");
  let active: ActivePicker | undefined;
  let stopped = false;

  const emptyPayload = (): Readonly<{ generation: 0; sources: readonly never[] }> => Object.freeze({ generation: 0, sources: Object.freeze([]) });
  const currentFor = (event: unknown, generation: unknown): ActivePicker | undefined => {
    const candidate = active;
    if (candidate === undefined) return undefined;
    const context = { contents: candidate.window.webContents, documentUrl: candidate.documentUrl, generation: candidate.generation };
    return validatePickerIpcSender(context, event, generation) ? candidate : undefined;
  };
  const deactivate = (candidate: ActivePicker, decision: unknown, notify: boolean): void => {
    if (active !== candidate) return;
    active = undefined;
    candidate.presentation = undefined;
    if (notify) {
      try { candidate.settle(decision); } catch { /* coordinator owns callback safety */ }
    }
    try { if (!candidate.window.isDestroyed()) candidate.window.destroy(); } catch { /* already gone */ }
  };

  dependencies.ipcMain.handle(PICKER_IPC_CHANNELS.list, (event) => {
    const candidate = active;
    if (candidate === undefined || currentFor(event, candidate.generation) === undefined || candidate.presentation === undefined) return emptyPayload();
    return Object.freeze({
      generation: candidate.generation,
      sources: candidate.presentation.sources,
      systemAudioAvailable: candidate.presentation.systemAudioAvailable === true
    });
  });
  dependencies.ipcMain.handle(PICKER_IPC_CHANNELS.choose, (event, selection: unknown) => {
    const snapshot = snapshotSelection(selection);
    const candidate = currentFor(event, snapshot?.generation);
    if (
      snapshot === undefined || candidate === undefined ||
      (snapshot.includeSystemAudio && candidate.presentation?.systemAudioAvailable !== true)
    ) return false;
    deactivate(candidate, snapshot, true);
    return true;
  });
  dependencies.ipcMain.handle(PICKER_IPC_CHANNELS.cancel, (event, request: unknown) => {
    const generation = ownGeneration(request);
    const candidate = currentFor(event, generation);
    if (candidate === undefined) return false;
    deactivate(candidate, Object.freeze({ kind: "cancel" }), true);
    return true;
  });

  return Object.freeze({
    present(presentation, settle): PickerHandle {
      if (stopped || active !== undefined) throw new Error("picker-unavailable");
      const window = dependencies.createWindow({
        title: "Wybierz ekran lub okno — CivCom",
        width: 820,
        height: 620,
        minWidth: 560,
        minHeight: 420,
        show: false,
        autoHideMenuBar: true,
        webPreferences: preferences
      });
      const candidate: ActivePicker = { window, generation: presentation.generation, documentUrl, settle, presentation };
      active = candidate;
      try {
        const navigation = createPickerNavigationCallbacks(documentUrl);
        window.webContents.setWindowOpenHandler(() => navigation.windowOpen());
        window.webContents.on("will-navigate", (event, url) => navigation.navigate(event, url));
        window.webContents.on("will-redirect", (event, url) => navigation.navigate(event, url));
        window.webContents.on("will-attach-webview", (event) => event.preventDefault());
        window.webContents.session.setPermissionCheckHandler(() => false);
        window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        window.webContents.session.setDevicePermissionHandler(() => false);
        window.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
          if (isMainFrame) deactivate(candidate, Object.freeze({ kind: "cancel" }), true);
        });
        window.webContents.on("render-process-gone", () => deactivate(candidate, Object.freeze({ kind: "cancel" }), true));
        window.webContents.on("destroyed", () => deactivate(candidate, Object.freeze({ kind: "cancel" }), true));
        window.once("ready-to-show", () => {
          try {
            if (window.isDestroyed()) deactivate(candidate, Object.freeze({ kind: "cancel" }), true);
            else window.show();
          } catch { deactivate(candidate, Object.freeze({ kind: "cancel" }), true); }
        });
        window.on("closed", () => deactivate(candidate, Object.freeze({ kind: "cancel" }), true));
        void Promise.resolve(window.loadURL(documentUrl)).catch(() => deactivate(candidate, Object.freeze({ kind: "cancel" }), true));
      } catch {
        deactivate(candidate, Object.freeze({ kind: "cancel" }), true);
      }
      return Object.freeze({ destroy: () => deactivate(candidate, Object.freeze({ kind: "cancel" }), false) });
    },
    shutdown(): void {
      stopped = true;
      if (active !== undefined) deactivate(active, Object.freeze({ kind: "cancel" }), true);
      for (const channel of Object.values(PICKER_IPC_CHANNELS)) dependencies.ipcMain.removeHandler(channel);
    }
  });
}
