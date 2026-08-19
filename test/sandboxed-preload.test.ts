import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("packaged sandboxed picker preload", () => {
  it("is a self-contained CommonJS bridge with only get, choose, and cancel operations", async () => {
    const source = readFileSync(new URL("../src/screen-share/picker-preload.cjs", import.meta.url), "utf8");
    let exposedName: string | undefined;
    let exposedApi: Record<string, (...args: unknown[]) => Promise<unknown>> | undefined;
    let listPayload: unknown = { generation: 5, sources: [{ token: "P".repeat(43), name: "Monitor", kind: "screen" }] };
    let decisionResult: unknown = true;
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      void payload;
      if (channel.endsWith(":list")) return listPayload;
      if (decisionResult instanceof Error) throw decisionResult;
      return decisionResult;
    });
    const requireModule = vi.fn((name: string) => {
      if (name !== "electron") throw new Error(`unexpected module: ${name}`);
      return {
        contextBridge: { exposeInMainWorld: (nameValue: string, api: Record<string, (...args: unknown[]) => Promise<unknown>>) => { exposedName = nameValue; exposedApi = api; } },
        ipcRenderer: { invoke }
      };
    });
    runInNewContext(source, { require: requireModule });
    expect(requireModule).toHaveBeenCalledOnce();
    expect(exposedName).toBe("civcomScreenPicker");
    expect(Object.keys(exposedApi ?? {}).sort()).toEqual(["cancel", "choose", "getSources"]);
    expect(Object.isFrozen(exposedApi)).toBe(true);
    if (exposedApi === undefined) throw new Error("preload API not exposed");
    expect(JSON.stringify(await exposedApi.getSources?.())).toBe(JSON.stringify([{ token: "P".repeat(43), name: "Monitor", kind: "screen" }]));
    await exposedApi.choose?.("P".repeat(43));
    expect(invoke.mock.calls[1]?.[0]).toBe("civcom-screen-picker:choose");
    expect(JSON.stringify(invoke.mock.calls[1]?.[1])).toBe(JSON.stringify({ generation: 5, token: "P".repeat(43) }));
    listPayload = {
      generation: 6,
      sources: [{
        token: "P".repeat(43),
        name: "Monitor",
        kind: "screen",
        thumbnailDataUrl: "data:image/png;base64,not base64!"
      }]
    };
    expect(JSON.stringify(await exposedApi.getSources?.())).toBe("[]");

    let resolvePendingList: ((value: unknown) => void) | undefined;
    listPayload = new Promise<unknown>((resolve) => { resolvePendingList = resolve; });
    const pendingSources = exposedApi.getSources?.();
    const pendingCancel = exposedApi.cancel?.();
    resolvePendingList?.({ generation: 7, sources: [] });
    await pendingSources;
    await pendingCancel;
    expect(invoke.mock.calls.at(-1)?.[0]).toBe("civcom-screen-picker:cancel");
    expect(JSON.stringify(invoke.mock.calls.at(-1)?.[1])).toBe(JSON.stringify({ generation: 7 }));

    listPayload = { generation: 8, sources: [{ token: "P".repeat(43), name: "Monitor", kind: "screen" }] };
    await exposedApi.getSources?.();
    decisionResult = false;
    await expect(exposedApi.choose?.("P".repeat(43))).resolves.toBe(false);
    decisionResult = true;
    await expect(exposedApi.choose?.("P".repeat(43))).resolves.toBe(true);
    const chooseCalls = invoke.mock.calls.filter(([channel]) => channel === "civcom-screen-picker:choose");
    expect(chooseCalls).toHaveLength(3);
    expect(JSON.stringify(chooseCalls.at(-1)?.[1])).toBe(JSON.stringify({ generation: 8, token: "P".repeat(43) }));
  });
});
