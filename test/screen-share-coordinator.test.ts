import { describe, expect, it, vi } from "vitest";
import { DisplayMediaCoordinator, type PickerPresentation } from "../src/screen-share/coordinator.js";
import type { CaptureSourceCandidate } from "../src/screen-share/source-catalog.js";

type Source = Readonly<{ label: string }>;

const TOKEN = "T".repeat(43);

function displayRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    frame: { alive: true },
    securityOrigin: "https://civcom.soia.info",
    userGesture: true,
    videoRequested: true,
    audioRequested: false,
    ...overrides
  };
}

function candidate(source: Source, id = "screen:1:0"): CaptureSourceCandidate<Source> {
  return { source, id, name: source.label, thumbnailDataUrl: "data:image/png;base64,AA==" };
}

async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function harness(options: Readonly<{
  platform?: "win32" | "darwin" | "linux";
  systemVersion?: string;
  sessionType?: "wayland" | "x11";
  sources?: readonly CaptureSourceCandidate<Source>[];
}> = {}) {
  const source = { label: "Monitor" } as const;
  let sources = options.sources ?? [candidate(source)];
  let presentation: PickerPresentation | undefined;
  let presentationCount = 0;
  let decide: ((decision: unknown) => void) | undefined;
  let closePicker: (() => void) | undefined;
  let frameGone: (() => void) | undefined;
  let operationTimeout: (() => void) | undefined;
  let usable = true;
  let refreshResult: CaptureSourceCandidate<Source> | undefined = sources[0];
  let onDestroy: (() => void) | undefined;
  const destroy = vi.fn(() => { closePicker?.(); onDestroy?.(); });
  const log = vi.fn();
  const coordinator = new DisplayMediaCoordinator<Source>({
    environment: {
      platform: options.platform ?? "win32",
      ...(options.systemVersion === undefined ? {} : { systemVersion: options.systemVersion }),
      ...(options.sessionType === undefined ? {} : { sessionType: options.sessionType })
    },
    getSources: async () => sources,
    refreshSource: async () => refreshResult,
    presentPicker: (view, settle) => {
      presentation = view;
      presentationCount += 1;
      decide = settle;
      closePicker = () => settle({ kind: "cancel" });
      return { destroy };
    },
    watchFrame: (_frame, onGone) => { frameGone = onGone; return vi.fn(); },
    watchOperationTimeout: (onTimeout: () => void) => { operationTimeout = onTimeout; return vi.fn(); },
    isFrameUsable: () => usable,
    createToken: () => TOKEN,
    log
  });
  return {
    coordinator,
    source,
    log,
    setSources(value: readonly CaptureSourceCandidate<Source>[]) { sources = value; },
    setRefresh(value: CaptureSourceCandidate<Source> | undefined) { refreshResult = value; },
    setUsable(value: boolean) { usable = value; },
    setDestroyAction(value: () => void) { onDestroy = value; },
    presentation: () => presentation,
    presentationCount: () => presentationCount,
    decide: (value: unknown) => decide?.(value),
    close: () => closePicker?.(),
    frameGone: () => frameGone?.(),
    expireOperation: () => operationTimeout?.(),
    destroy
  };
}

describe("display-media coordinator", () => {
  it("never auto-selects a general source and settles once after an explicit current token", async () => {
    const h = harness();
    const callback = vi.fn();
    h.coordinator.handle(displayRequest(), callback);
    await turn();
    expect(callback).not.toHaveBeenCalled();
    expect(h.presentation()?.sources).toHaveLength(1);
    h.decide({ generation: h.presentation()?.generation, token: TOKEN });
    await turn();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ video: h.source });
    h.close();
    h.decide({ generation: h.presentation()?.generation, token: TOKEN });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("grants loopback only for an explicit Windows audio request", async () => {
    const windows = harness({ platform: "win32" });
    const winCallback = vi.fn();
    windows.coordinator.handle(displayRequest({ audioRequested: true }), winCallback);
    await turn();
    windows.decide({ generation: windows.presentation()?.generation, token: TOKEN });
    await turn();
    expect(winCallback).toHaveBeenCalledWith({ video: windows.source, audio: "loopback" });

    const mac = harness({ platform: "darwin", systemVersion: "14.7" });
    const macCallback = vi.fn();
    mac.coordinator.handle(displayRequest({ audioRequested: true }), macCallback);
    await turn();
    mac.decide({ generation: mac.presentation()?.generation, token: TOKEN });
    await turn();
    expect(macCallback).toHaveBeenCalledWith({ video: mac.source });
  });

  it("uses the safe local fallback if a macOS 15 system-picker handler is invoked", async () => {
    const h = harness({ platform: "darwin", systemVersion: "15.3" });
    const callback = vi.fn();
    h.coordinator.handle(displayRequest(), callback);
    await turn();
    expect(h.presentation()?.sources).toHaveLength(1);
    expect(callback).not.toHaveBeenCalled();
    h.close();
    expect(callback).toHaveBeenCalledWith({});
  });

  it("accepts exactly one Wayland portal-selected source and denies empty or multiple results", async () => {
    for (const count of [0, 2]) {
      const list = Array.from({ length: count }, (_, index) => candidate({ label: `S${index}` }, `screen:${index}:0`));
      const h = harness({ platform: "linux", sessionType: "wayland", sources: list });
      const callback = vi.fn();
      h.coordinator.handle(displayRequest(), callback);
      await turn();
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith({});
      expect(h.presentation()).toBeUndefined();
    }
    const one = harness({ platform: "linux", sessionType: "wayland" });
    const callback = vi.fn();
    one.coordinator.handle(displayRequest(), callback);
    await turn();
    expect(callback).toHaveBeenCalledWith({ video: one.source });
    expect(one.presentation()).toBeUndefined();
  });

  it("fails closed for concurrent requests, cancellation, stale selection, and source disappearance", async () => {
    const h = harness();
    const first = vi.fn();
    const second = vi.fn();
    h.coordinator.handle(displayRequest(), first);
    h.coordinator.handle(displayRequest(), second);
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith({});
    await turn();
    const generation = h.presentation()?.generation;
    h.decide({ generation: Number(generation) + 1, token: TOKEN });
    expect(first).toHaveBeenCalledWith({});

    const disappeared = harness();
    const missing = vi.fn();
    disappeared.coordinator.handle(displayRequest(), missing);
    await turn();
    disappeared.setRefresh(undefined);
    disappeared.decide({ generation: disappeared.presentation()?.generation, token: TOKEN });
    await turn();
    expect(missing).toHaveBeenCalledOnce();
    expect(missing).toHaveBeenCalledWith({});
  });

  it("settles exactly once on picker close, frame destruction, shutdown, and duplicate late decisions", async () => {
    for (const stop of ["close", "frame", "shutdown"] as const) {
      const h = harness();
      const callback = vi.fn();
      h.coordinator.handle(displayRequest(), callback);
      await turn();
      if (stop === "close") h.close();
      if (stop === "frame") h.frameGone();
      if (stop === "shutdown") h.coordinator.shutdown();
      h.decide({ generation: h.presentation()?.generation, token: TOKEN });
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith({});
    }
  });

  it("fails closed for a request synchronously re-entered from the completion callback", async () => {
    const h = harness();
    const reentrant = vi.fn();
    const first = vi.fn(() => h.coordinator.handle(displayRequest(), reentrant));
    h.coordinator.handle(displayRequest(), first);
    await turn();
    h.decide({ generation: h.presentation()?.generation, token: TOKEN });
    await turn();
    expect(first).toHaveBeenCalledOnce();
    expect(reentrant).toHaveBeenCalledOnce();
    expect(reentrant).toHaveBeenCalledWith({});
    expect(h.presentationCount()).toBe(1);
  });

  it("keeps the single-flight lock while picker cleanup runs", async () => {
    const h = harness();
    const reentrant = vi.fn();
    h.coordinator.handle(displayRequest(), vi.fn());
    await turn();
    h.setDestroyAction(() => h.coordinator.handle(displayRequest(), reentrant));
    h.decide({ generation: h.presentation()?.generation, token: TOKEN });
    await turn();
    expect(reentrant).toHaveBeenCalledOnce();
    expect(reentrant).toHaveBeenCalledWith({});
    expect(h.presentationCount()).toBe(1);
  });

  it("settles exactly once when source enumeration or source refresh never resolves", async () => {
    const enumeration = harness();
    const enumerationCallback = vi.fn();
    enumeration.coordinator.handle(displayRequest(), enumerationCallback);
    enumeration.expireOperation();
    await turn();
    enumeration.expireOperation();
    expect(enumerationCallback).toHaveBeenCalledOnce();
    expect(enumerationCallback).toHaveBeenCalledWith({});
    expect(enumeration.presentation()).toBeUndefined();

    const refresh = harness();
    const refreshCallback = vi.fn();
    refresh.coordinator.handle(displayRequest(), refreshCallback);
    await turn();
    refresh.decide({ generation: refresh.presentation()?.generation, token: TOKEN });
    refresh.expireOperation();
    await turn();
    refresh.expireOperation();
    expect(refreshCallback).toHaveBeenCalledOnce();
    expect(refreshCallback).toHaveBeenCalledWith({});
  });

  it("does not enumerate sources when the frame watcher reports destruction synchronously", () => {
    const getSources = vi.fn(async () => [] as const);
    const coordinator = new DisplayMediaCoordinator<Source>({
      environment: { platform: "win32" },
      getSources,
      refreshSource: async () => undefined,
      presentPicker: () => { throw new Error("must not open"); },
      watchFrame: (_frame, onGone) => { onGone(); return () => undefined; },
      watchOperationTimeout: () => () => undefined,
      isFrameUsable: () => true,
      createToken: () => TOKEN,
      log: vi.fn()
    });
    const callback = vi.fn();
    coordinator.handle(displayRequest(), callback);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({});
    expect(getSources).not.toHaveBeenCalled();
  });

  it("snapshots descriptor-valid sources without invoking throwing value traps", async () => {
    const original = candidate({ label: "Hostile" });
    const hostile = new Proxy(original, {
      getOwnPropertyDescriptor: (target, property) => Reflect.getOwnPropertyDescriptor(target, property),
      get: (_target, property) => {
        if (property === "then") return undefined;
        throw new Error("value trap");
      }
    });
    const portal = harness({ platform: "linux", sessionType: "wayland", sources: [hostile] });
    const portalCallback = vi.fn();
    portal.coordinator.handle(displayRequest(), portalCallback);
    await turn();
    expect(portalCallback).toHaveBeenCalledOnce();
    expect(portalCallback).toHaveBeenCalledWith({ video: original.source });

    const local = harness();
    const localCallback = vi.fn();
    local.coordinator.handle(displayRequest(), localCallback);
    await turn();
    expect(local.presentation()).toBeDefined();
    local.setRefresh(hostile);
    local.decide({ generation: local.presentation()?.generation, token: TOKEN });
    await turn();
    expect(localCallback).toHaveBeenCalledOnce();
    expect(localCallback).toHaveBeenCalledWith({ video: original.source });
  });

  it("denies malformed requests, destroyed frames, getSources errors, and callback re-entry without throwing", async () => {
    const h = harness();
    h.setUsable(false);
    const destroyed = vi.fn();
    expect(() => h.coordinator.handle(displayRequest(), destroyed)).not.toThrow();
    expect(destroyed).toHaveBeenCalledWith({});

    const failing = new DisplayMediaCoordinator<Source>({
      environment: { platform: "win32" },
      getSources: async () => { throw new Error("portal details must not leak"); },
      refreshSource: async () => undefined,
      presentPicker: () => { throw new Error("must not open"); },
      watchFrame: () => () => undefined,
      watchOperationTimeout: () => () => undefined,
      isFrameUsable: () => true,
      createToken: () => TOKEN,
      log: vi.fn()
    });
    const rejected = vi.fn(() => { throw new Error("callback trap"); });
    failing.handle(displayRequest(), rejected);
    await turn();
    expect(rejected).toHaveBeenCalledOnce();
    expect(() => failing.handle(null, vi.fn())).not.toThrow();
  });
});
