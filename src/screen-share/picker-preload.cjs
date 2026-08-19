/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- sandboxed Electron preloads require one self-contained CommonJS file */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const channels = Object.freeze({
  list: "civcom-screen-picker:list",
  choose: "civcom-screen-picker:choose",
  cancel: "civcom-screen-picker:cancel"
});
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const pngDataUrlPattern = /^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
let generation;
let pendingGeneration;

function ownValue(input, key) {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
}

function parsePayload(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const nextGeneration = ownValue(value, "generation");
    const inputSources = ownValue(value, "sources");
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= 0 || !Array.isArray(inputSources) || inputSources.length > 100) return undefined;
    const sources = [];
    for (let index = 0; index < inputSources.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(inputSources, String(index));
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return undefined;
      const item = descriptor.value;
      if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
      const token = ownValue(item, "token");
      const name = ownValue(item, "name");
      const kind = ownValue(item, "kind");
      const thumbnailDataUrl = ownValue(item, "thumbnailDataUrl");
      if (
        typeof token !== "string" || !tokenPattern.test(token) || typeof name !== "string" || [...name].length > 120 ||
        (kind !== "screen" && kind !== "window") ||
        (thumbnailDataUrl !== undefined && (typeof thumbnailDataUrl !== "string" || thumbnailDataUrl.length > 512000 || !pngDataUrlPattern.test(thumbnailDataUrl)))
      ) return undefined;
      sources.push(Object.freeze({ token, name, kind, ...(thumbnailDataUrl === undefined ? {} : { thumbnailDataUrl }) }));
    }
    return Object.freeze({ generation: nextGeneration, sources: Object.freeze(sources) });
  } catch {
    return undefined;
  }
}

const api = Object.freeze({
  async getSources() {
    const pendingPayload = Promise.resolve().then(() => ipcRenderer.invoke(channels.list)).then(parsePayload);
    const currentPendingGeneration = pendingPayload.then((payload) => payload?.generation, () => undefined);
    pendingGeneration = currentPendingGeneration;
    let payload;
    try { payload = await pendingPayload; } finally {
      if (pendingGeneration === currentPendingGeneration) pendingGeneration = undefined;
    }
    generation = payload?.generation;
    return payload?.sources ?? Object.freeze([]);
  },
  async choose(token) {
    const current = generation;
    if (current === undefined || typeof token !== "string" || !tokenPattern.test(token)) return false;
    const accepted = await ipcRenderer.invoke(channels.choose, Object.freeze({ generation: current, token })) === true;
    if (accepted && generation === current) generation = undefined;
    return accepted;
  },
  async cancel() {
    const current = generation ?? await pendingGeneration;
    if (current === undefined) return false;
    const accepted = await ipcRenderer.invoke(channels.cancel, Object.freeze({ generation: current })) === true;
    if (accepted && generation === current) generation = undefined;
    return accepted;
  }
});

contextBridge.exposeInMainWorld("civcomScreenPicker", api);
