import { isAbsolute } from "node:path";

export const PICKER_PARTITION = "civcom-picker";

export type PickerWebPreferences = Readonly<{
  nodeIntegration: false;
  contextIsolation: true;
  sandbox: true;
  webSecurity: true;
  webviewTag: false;
  partition: typeof PICKER_PARTITION;
  preload: string;
}>;

export function createPickerWebPreferences(preloadPath: unknown): PickerWebPreferences | undefined {
  if (typeof preloadPath !== "string" || !isAbsolute(preloadPath) || [...preloadPath].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) return undefined;
  return Object.freeze({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    partition: PICKER_PARTITION,
    preload: preloadPath
  });
}

export type Preventable = Readonly<{ preventDefault(): void }>;

export function createPickerNavigationCallbacks(documentUrl: string): Readonly<{
  windowOpen(): Readonly<{ action: "deny" }>;
  navigate(event: Preventable, url: unknown): void;
}> {
  return Object.freeze({
    windowOpen: () => Object.freeze({ action: "deny" }),
    navigate(event, url): void {
      if (url !== documentUrl) {
        try { event.preventDefault(); } catch { /* deny path remains closed */ }
      }
    }
  });
}

export type PickerSenderContext = Readonly<{
  contents: Readonly<{
    mainFrame: unknown;
    getURL(): string;
    isDestroyed(): boolean;
  }>;
  documentUrl: string;
  generation: number;
}>;

export function validatePickerIpcSender(context: PickerSenderContext, event: unknown, generation: unknown): boolean {
  try {
    if (!Number.isSafeInteger(generation) || generation !== context.generation || context.contents.isDestroyed()) return false;
    if (event === null || typeof event !== "object") return false;
    const candidate = event as Readonly<{ sender?: unknown; senderFrame?: unknown }>;
    if (candidate.sender !== context.contents || candidate.senderFrame !== context.contents.mainFrame) return false;
    const frame = candidate.senderFrame as Readonly<{ url?: unknown }>;
    return context.contents.getURL() === context.documentUrl && frame.url === context.documentUrl;
  } catch {
    return false;
  }
}
