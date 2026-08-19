import { describe, expect, it, vi } from "vitest";
import { createPermissionCallbacks } from "../src/desktop/electron-adapters.js";

type TestFrame = Readonly<{
  detached: boolean;
  frameTreeNodeId: number;
  framesInSubtree: readonly TestFrame[];
  origin: string;
  processId: number;
  routingId: number;
  url: string;
  isDestroyed(): boolean;
}>;

type TestContents = Readonly<{ mainFrame: TestFrame }>;

type MediaPrompt = (request: Readonly<{
  mediaTypes: readonly ("audio" | "video")[];
}>, contents: TestContents) => Promise<boolean>;

type ConsentCallbacks = Readonly<{
  check(permission: unknown, requestingOrigin: unknown, details: unknown, contents: TestContents | null): boolean;
  request(permission: unknown, details: unknown, contents: TestContents): boolean | Promise<boolean>;
}>;

function frame(overrides: Partial<Omit<TestFrame, "framesInSubtree">> = {}): TestFrame {
  const candidate = {
    detached: false,
    frameTreeNodeId: 17,
    origin: "https://civcom.soia.info",
    processId: 31,
    routingId: 47,
    url: "https://civcom.soia.info/#/call",
    isDestroyed: () => false,
    ...overrides
  };
  return Object.freeze({ ...candidate, framesInSubtree: Object.freeze([]) });
}

function callbacks(confirmMedia: MediaPrompt): ConsentCallbacks {
  const create = createPermissionCallbacks as unknown as (dependencies: Readonly<{ confirmMedia: MediaPrompt }>) => ConsentCallbacks;
  return create({ confirmMedia });
}

const requestDetails = Object.freeze({
  isMainFrame: true,
  mediaTypes: Object.freeze(["audio", "video"] as const),
  requestingUrl: "https://civcom.soia.info/#/call",
  securityOrigin: "https://civcom.soia.info"
});

describe("native camera and microphone consent", () => {
  it("does not turn a trusted-origin media check into an automatic grant", () => {
    const mainFrame = frame();
    const handlers = callbacks(vi.fn(async () => true));

    expect(handlers.check("media", "https://civcom.soia.info", {
      isMainFrame: true,
      mediaType: "audio",
      requestingUrl: mainFrame.url,
      securityOrigin: mainFrame.origin
    }, { mainFrame })).toBe(false);
  });

  it("asks once and grants only the exact current frame's audio/video request", async () => {
    const mainFrame = frame();
    const contents = Object.freeze({ mainFrame });
    const confirmMedia = vi.fn<MediaPrompt>(async () => true);
    const handlers = callbacks(confirmMedia);

    await expect(Promise.resolve(handlers.request("media", requestDetails, contents))).resolves.toBe(true);
    expect(confirmMedia).toHaveBeenCalledOnce();
    expect(confirmMedia).toHaveBeenCalledWith({ mediaTypes: ["audio", "video"] }, contents);
  });

  it("denies when the user rejects the native prompt", async () => {
    const mainFrame = frame();
    const handlers = callbacks(vi.fn(async () => false));

    await expect(Promise.resolve(handlers.request("media", requestDetails, { mainFrame }))).resolves.toBe(false);
  });

  it("fails closed before prompting for a mismatched or ambiguous requesting frame", async () => {
    const callA = frame({ frameTreeNodeId: 18, origin: "https://call.soia.info", routingId: 48, url: "https://call.soia.info/room" });
    const callB = frame({ frameTreeNodeId: 19, origin: "https://call.soia.info", routingId: 49, url: "https://call.soia.info/room" });
    const main = frame();
    const mainFrame = Object.freeze({ ...main, framesInSubtree: Object.freeze([main, callA, callB]) });
    const confirmMedia = vi.fn<MediaPrompt>(async () => true);
    const handlers = callbacks(confirmMedia);

    await expect(Promise.resolve(handlers.request("media", {
      isMainFrame: false,
      mediaTypes: ["video"],
      requestingUrl: "https://call.soia.info/room",
      securityOrigin: "https://call.soia.info"
    }, { mainFrame }))).resolves.toBe(false);
    expect(confirmMedia).not.toHaveBeenCalled();
  });

  it("rejects a security-origin value carrying a path, query, or fragment", async () => {
    const mainFrame = frame();
    const confirmMedia = vi.fn<MediaPrompt>(async () => true);
    const handlers = callbacks(confirmMedia);

    await expect(Promise.resolve(handlers.request("media", {
      ...requestDetails,
      securityOrigin: "https://civcom.soia.info/?not-an-origin=1"
    }, { mainFrame }))).resolves.toBe(false);
    expect(confirmMedia).not.toHaveBeenCalled();
  });

  it("revokes an approval if the exact frame changes while the prompt is open", async () => {
    let currentUrl = "https://civcom.soia.info/#/call";
    const base = frame();
    const mainFrame = Object.freeze({
      ...base,
      get url(): string { return currentUrl; }
    });
    const confirmMedia = vi.fn<MediaPrompt>(async () => {
      currentUrl = "https://civcom.soia.info/#/different-document";
      return true;
    });
    const handlers = callbacks(confirmMedia);

    await expect(Promise.resolve(handlers.request("media", requestDetails, { mainFrame }))).resolves.toBe(false);
  });
});
