import { describe, expect, it, vi } from "vitest";
import { watchFrameLifetime, type FrameLifetimeEvent } from "../src/screen-share/frame-lifetime.js";

function fixture() {
  const listeners = new Map<FrameLifetimeEvent, () => void>();
  let poll: (() => void) | undefined;
  let usable = true;
  const clearEvery = vi.fn();
  const onGone = vi.fn();
  const stop = watchFrameLifetime({
    listen: (event, listener) => { listeners.set(event, listener); },
    unlisten: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); },
    isUsable: () => usable,
    every: (check) => { poll = check; return { timer: true }; },
    clearEvery
  }, onGone);
  return {
    listeners,
    onGone,
    clearEvery,
    poll: () => poll?.(),
    setUsable(value: boolean) { usable = value; },
    stop
  };
}

describe("display-media frame lifetime watcher", () => {
  it("polls for a detached frame and tears all observations down exactly once", () => {
    const f = fixture();
    expect([...f.listeners.keys()].sort()).toEqual([
      "destroyed",
      "did-start-navigation",
      "render-process-gone"
    ]);
    f.poll();
    expect(f.onGone).not.toHaveBeenCalled();
    f.setUsable(false);
    f.poll();
    f.poll();
    f.listeners.get("destroyed")?.();
    expect(f.onGone).toHaveBeenCalledOnce();
    expect(f.clearEvery).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
  });

  it("fails closed when liveness checking or watcher setup throws", () => {
    const checkingGone = vi.fn();
    let poll: (() => void) | undefined;
    expect(() => watchFrameLifetime({
      listen: vi.fn(),
      unlisten: vi.fn(),
      isUsable: () => { throw new Error("detached proxy"); },
      every: (check) => { poll = check; return 1; },
      clearEvery: vi.fn()
    }, checkingGone)).not.toThrow();
    poll?.();
    expect(checkingGone).toHaveBeenCalledOnce();

    const setupGone = vi.fn();
    expect(() => watchFrameLifetime({
      listen: () => { throw new Error("native listener failed"); },
      unlisten: vi.fn(),
      isUsable: () => true,
      every: vi.fn(),
      clearEvery: vi.fn()
    }, setupGone)).not.toThrow();
    expect(setupGone).toHaveBeenCalledOnce();
  });
});
