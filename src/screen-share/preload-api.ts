import type { PickerSource } from "./source-catalog.js";

export type PickerPreloadBridge = Readonly<{
  list(): Promise<unknown>;
  choose(selection: Readonly<{ generation: number; token: string; includeSystemAudio: boolean }>): Promise<unknown>;
  cancel(request: Readonly<{ generation: number }>): Promise<unknown>;
}>;

export type PickerPreloadApi = Readonly<{
  getSources(): Promise<readonly PickerSource[]>;
  systemAudioAvailable(): boolean;
  choose(token: unknown, includeSystemAudio?: unknown): Promise<boolean>;
  cancel(): Promise<boolean>;
}>;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PNG_DATA_URL_PATTERN = /^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function ownValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function parseSources(value: unknown): Readonly<{
  generation: number;
  sources: readonly PickerSource[];
  systemAudioAvailable: boolean;
}> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const generation = ownValue(value, "generation");
    const inputSources = ownValue(value, "sources");
    const audioAvailable = ownValue(value, "systemAudioAvailable");
    if (
      !Number.isSafeInteger(generation) || (generation as number) <= 0 || !Array.isArray(inputSources) || inputSources.length > 100 ||
      (audioAvailable !== undefined && typeof audioAvailable !== "boolean")
    ) return undefined;
    const sources: PickerSource[] = [];
    for (let index = 0; index < inputSources.length; index += 1) {
      const itemDescriptor = Object.getOwnPropertyDescriptor(inputSources, String(index));
      if (itemDescriptor === undefined || !("value" in itemDescriptor)) return undefined;
      const item = itemDescriptor.value;
      if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
      const token = ownValue(item, "token");
      const name = ownValue(item, "name");
      const kind = ownValue(item, "kind");
      const thumbnailDataUrl = ownValue(item, "thumbnailDataUrl");
      if (
        typeof token !== "string" || !TOKEN_PATTERN.test(token) || typeof name !== "string" || [...name].length > 120 ||
        (kind !== "screen" && kind !== "window") ||
        (thumbnailDataUrl !== undefined && (typeof thumbnailDataUrl !== "string" || thumbnailDataUrl.length > 512_000 || !PNG_DATA_URL_PATTERN.test(thumbnailDataUrl)))
      ) return undefined;
      sources.push(Object.freeze({ token, name, kind, ...(thumbnailDataUrl === undefined ? {} : { thumbnailDataUrl }) }));
    }
    return Object.freeze({
      generation: generation as number,
      sources: Object.freeze(sources),
      systemAudioAvailable: audioAvailable === true
    });
  } catch {
    return undefined;
  }
}

export function createPickerPreloadApi(bridge: PickerPreloadBridge): PickerPreloadApi {
  let generation: number | undefined;
  let audioAvailable = false;
  let pendingGeneration: Promise<number | undefined> | undefined;
  return Object.freeze({
    async getSources(): Promise<readonly PickerSource[]> {
      const pendingPayload = Promise.resolve().then(() => bridge.list()).then(parseSources);
      const currentPendingGeneration = pendingPayload.then((payload) => payload?.generation, () => undefined);
      pendingGeneration = currentPendingGeneration;
      let payload: ReturnType<typeof parseSources>;
      try { payload = await pendingPayload; } finally {
        if (pendingGeneration === currentPendingGeneration) pendingGeneration = undefined;
      }
      generation = payload?.generation;
      audioAvailable = payload?.systemAudioAvailable === true;
      return payload?.sources ?? Object.freeze([]);
    },
    systemAudioAvailable(): boolean {
      return generation !== undefined && audioAvailable;
    },
    async choose(token: unknown, includeSystemAudio: unknown = false): Promise<boolean> {
      const current = generation;
      if (current === undefined || typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
      const accepted = await bridge.choose(Object.freeze({
        generation: current,
        token,
        includeSystemAudio: audioAvailable && includeSystemAudio === true
      })) === true;
      if (accepted && generation === current) {
        generation = undefined;
        audioAvailable = false;
      }
      return accepted;
    },
    async cancel(): Promise<boolean> {
      const current = generation ?? await pendingGeneration;
      if (current === undefined) return false;
      const accepted = await bridge.cancel(Object.freeze({ generation: current })) === true;
      if (accepted && generation === current) {
        generation = undefined;
        audioAvailable = false;
      }
      return accepted;
    }
  });
}
