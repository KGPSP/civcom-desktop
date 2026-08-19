import { authorizeDisplayMediaRequestSnapshot, selectDisplayMediaRoute, type DisplayMediaRoute } from "./policy.js";
import { createOpaqueSourceCatalog, type CaptureSourceCandidate, type OpaqueSourceCatalog, type PickerSource } from "./source-catalog.js";

export type PickerPresentation = Readonly<{
  generation: number;
  sources: readonly PickerSource[];
  systemAudioAvailable?: boolean;
}>;

export type PickerHandle = Readonly<{ destroy(): void }>;

export type CaptureStreams<T> = Readonly<{
  video?: T;
  audio?: "loopback";
}>;

export type ScreenShareLogCode =
  | "request-denied"
  | "source-error"
  | "picker-error"
  | "callback-error";

export type DisplayMediaCoordinatorDependencies<T> = Readonly<{
  environment: unknown;
  getSources(): Promise<readonly CaptureSourceCandidate<T>[]>;
  refreshSource(selected: CaptureSourceCandidate<T>): Promise<CaptureSourceCandidate<T> | undefined>;
  presentPicker(presentation: PickerPresentation, settle: (decision: unknown) => void): PickerHandle;
  watchFrame(frame: object, onGone: () => void): () => void;
  watchOperationTimeout(onTimeout: () => void): () => void;
  isFrameUsable(frame: object): boolean;
  createToken(): string;
  log(code: ScreenShareLogCode): void;
}>;

type ActiveRequest<T> = {
  readonly generation: number;
  readonly frame: object;
  readonly systemAudioAvailable: boolean;
  readonly callback: (streams: CaptureStreams<T>) => void;
  settled: boolean;
  catalog: OpaqueSourceCatalog<T> | undefined;
  picker: PickerHandle | undefined;
  stopWatching: (() => void) | undefined;
  stopOperationTimeout: (() => void) | undefined;
};

type PickerDecision = Readonly<{
  generation: number;
  token: string;
  includeSystemAudio: boolean;
}>;

function snapshotPickerDecision(value: unknown): PickerDecision | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const generation = Object.getOwnPropertyDescriptor(value, "generation");
    const token = Object.getOwnPropertyDescriptor(value, "token");
    const audio = Object.getOwnPropertyDescriptor(value, "includeSystemAudio");
    if (
      generation === undefined || !("value" in generation) || !Number.isSafeInteger(generation.value) || generation.value <= 0 ||
      token === undefined || !("value" in token) || typeof token.value !== "string" ||
      (audio !== undefined && (!("value" in audio) || typeof audio.value !== "boolean"))
    ) return undefined;
    return Object.freeze({
      generation: generation.value as number,
      token: token.value,
      includeSystemAudio: audio === undefined ? false : audio.value
    });
  } catch {
    return undefined;
  }
}

function safeArray<T>(value: unknown): readonly T[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 100) return undefined;
    const result: T[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      result.push(descriptor.value as T);
    }
    return result;
  } catch {
    return undefined;
  }
}

function snapshotCandidate<T>(candidate: unknown): CaptureSourceCandidate<T> | undefined {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const values = new Map<string, unknown>();
    for (const field of ["source", "id", "name", "thumbnailDataUrl"]) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, field);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      values.set(field, descriptor.value);
    }
    const source = values.get("source");
    if (source === null || typeof source !== "object") return undefined;
    return Object.freeze({ source: source as T, id: values.get("id"), name: values.get("name"), thumbnailDataUrl: values.get("thumbnailDataUrl") });
  } catch {
    return undefined;
  }
}

export class DisplayMediaCoordinator<T> {
  readonly #route: DisplayMediaRoute;
  readonly #platform: unknown;
  #active: ActiveRequest<T> | undefined;
  #generation = 0;
  #shuttingDown = false;
  #deliveringCallback = false;

  public constructor(private readonly dependencies: DisplayMediaCoordinatorDependencies<T>) {
    this.#route = selectDisplayMediaRoute(dependencies.environment);
    try {
      const descriptor = dependencies.environment !== null && typeof dependencies.environment === "object"
        ? Object.getOwnPropertyDescriptor(dependencies.environment, "platform")
        : undefined;
      this.#platform = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    } catch {
      this.#platform = undefined;
    }
  }

  public handle(input: unknown, callback: (streams: CaptureStreams<T>) => void): void {
    const request = authorizeDisplayMediaRequestSnapshot(input);
    if (
      request.kind === "deny" || this.#shuttingDown || this.#route === "deny" ||
      this.#active !== undefined || this.#deliveringCallback || !this.frameUsable(request.frame)
    ) {
      this.callCallback(callback, Object.freeze({}));
      return;
    }

    const active: ActiveRequest<T> = {
      generation: ++this.#generation,
      frame: request.frame,
      systemAudioAvailable: request.audioRequested && this.#platform === "win32",
      callback,
      settled: false,
      catalog: undefined,
      picker: undefined,
      stopWatching: undefined,
      stopOperationTimeout: undefined
    };
    this.#active = active;
    try {
      const stop = this.dependencies.watchFrame(active.frame, () => this.finish(active));
      if (this.#active === active) active.stopWatching = stop;
      else this.safeAction(stop);
    } catch {
      this.finish(active, undefined, "request-denied");
      return;
    }
    if (!this.isCurrent(active)) return;

    if (!this.armOperationTimeout(active)) return;

    let pending: Promise<readonly CaptureSourceCandidate<T>[]>;
    try {
      pending = this.dependencies.getSources();
    } catch {
      this.finish(active, undefined, "source-error");
      return;
    }
    void Promise.resolve(pending).then(
      (sources) => { this.clearOperationTimeout(active); this.sourcesReady(active, sources); },
      () => { this.clearOperationTimeout(active); this.finish(active, undefined, "source-error"); }
    );
  }

  public shutdown(): void {
    this.#shuttingDown = true;
    if (this.#active !== undefined) this.finish(this.#active);
  }

  private sourcesReady(active: ActiveRequest<T>, value: unknown): void {
    if (!this.isCurrent(active) || !this.frameUsable(active.frame)) { this.finish(active); return; }
    const sources = safeArray<CaptureSourceCandidate<T>>(value);
    if (sources === undefined) { this.finish(active, undefined, "source-error"); return; }
    if (this.#route === "wayland-portal") {
      const selected = sources.length === 1 ? snapshotCandidate<T>(sources[0]) : undefined;
      if (selected === undefined) { this.finish(active); return; }
      this.finish(active, selected.source);
      return;
    }

    const catalog = createOpaqueSourceCatalog<T>(active.generation, sources, this.dependencies.createToken);
    active.catalog = catalog;
    if (catalog.sources.length === 0) { this.finish(active); return; }
    const presentation = Object.freeze({
      generation: active.generation,
      sources: catalog.sources,
      systemAudioAvailable: active.systemAudioAvailable
    });
    try {
      const picker = this.dependencies.presentPicker(presentation, (decision) => this.pickerDecision(active, decision));
      if (this.isCurrent(active)) active.picker = picker;
      else this.safeAction(() => picker.destroy());
    } catch {
      this.finish(active, undefined, "picker-error");
    }
  }

  private pickerDecision(active: ActiveRequest<T>, decision: unknown): void {
    if (!this.isCurrent(active)) return;
    const snapshot = snapshotPickerDecision(decision);
    const selected = snapshot === undefined ? undefined : active.catalog?.resolve(snapshot);
    if (snapshot === undefined || selected === undefined || !this.frameUsable(active.frame)) { this.finish(active); return; }
    const catalog = active.catalog;
    active.catalog = undefined;
    catalog?.clear();
    if (!this.armOperationTimeout(active)) return;
    let pending: Promise<CaptureSourceCandidate<T> | undefined>;
    try {
      pending = this.dependencies.refreshSource(selected);
    } catch {
      this.finish(active, undefined, "source-error");
      return;
    }
    void Promise.resolve(pending).then(
      (refreshed) => {
        this.clearOperationTimeout(active);
        this.finish(active, snapshotCandidate<T>(refreshed)?.source, undefined, snapshot.includeSystemAudio);
      },
      () => { this.clearOperationTimeout(active); this.finish(active, undefined, "source-error"); }
    );
  }

  private finish(active: ActiveRequest<T>, source?: T, logCode?: ScreenShareLogCode, includeSystemAudio = false): void {
    if (!this.isCurrent(active)) return;
    active.settled = true;
    const catalog = active.catalog;
    active.catalog = undefined;
    catalog?.clear();
    this.clearOperationTimeout(active);
    const stopWatching = active.stopWatching;
    active.stopWatching = undefined;
    this.safeAction(stopWatching);
    const picker = active.picker;
    active.picker = undefined;
    this.safeAction(() => picker?.destroy());
    if (logCode !== undefined) this.safeLog(logCode);
    const streams: CaptureStreams<T> = source !== undefined && this.frameUsable(active.frame)
      ? Object.freeze({ video: source, ...(active.systemAudioAvailable && includeSystemAudio ? { audio: "loopback" as const } : {}) })
      : Object.freeze({});
    this.callCallback(active.callback, streams);
    if (this.#active === active) this.#active = undefined;
  }

  private armOperationTimeout(active: ActiveRequest<T>): boolean {
    let stop: () => void;
    try {
      stop = this.dependencies.watchOperationTimeout(() => this.finish(active, undefined, "source-error"));
    } catch {
      this.finish(active, undefined, "source-error");
      return false;
    }
    if (this.isCurrent(active)) active.stopOperationTimeout = stop;
    else this.safeAction(stop);
    return this.isCurrent(active);
  }

  private clearOperationTimeout(active: ActiveRequest<T>): void {
    const stop = active.stopOperationTimeout;
    active.stopOperationTimeout = undefined;
    this.safeAction(stop);
  }

  private isCurrent(active: ActiveRequest<T>): boolean {
    return this.#active === active && !active.settled;
  }

  private frameUsable(frame: object): boolean {
    try { return this.dependencies.isFrameUsable(frame) === true; } catch { return false; }
  }

  private callCallback(callback: (streams: CaptureStreams<T>) => void, streams: CaptureStreams<T>): void {
    const previous = this.#deliveringCallback;
    this.#deliveringCallback = true;
    try { callback(streams); } catch { this.safeLog("callback-error"); } finally { this.#deliveringCallback = previous; }
  }

  private safeLog(code: ScreenShareLogCode): void {
    try { this.dependencies.log(code); } catch { /* logging is never a control-flow dependency */ }
  }

  private safeAction(action: (() => void) | undefined): void {
    if (action === undefined) return;
    try { action(); } catch { /* lifecycle cleanup is best effort */ }
  }
}
