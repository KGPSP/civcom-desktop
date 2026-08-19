export type FrameLifetimeEvent = "destroyed" | "render-process-gone" | "did-start-navigation";

export type FrameLifetimeDependencies = Readonly<{
  listen(event: FrameLifetimeEvent, listener: () => void): void;
  unlisten(event: FrameLifetimeEvent, listener: () => void): void;
  isUsable(): boolean;
  every(check: () => void): unknown;
  clearEvery(handle: unknown): void;
}>;

const EVENTS: readonly FrameLifetimeEvent[] = Object.freeze([
  "destroyed",
  "render-process-gone",
  "did-start-navigation"
]);

export function watchFrameLifetime(
  dependencies: FrameLifetimeDependencies,
  onGone: () => void
): () => void {
  const installed: FrameLifetimeEvent[] = [];
  let stopped = false;
  let pollHandle: unknown;
  let hasPollHandle = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const event of installed) {
      try { dependencies.unlisten(event, gone); } catch { /* teardown remains fail closed */ }
    }
    installed.length = 0;
    if (hasPollHandle) {
      try { dependencies.clearEvery(pollHandle); } catch { /* teardown remains fail closed */ }
      hasPollHandle = false;
      pollHandle = undefined;
    }
  };
  const gone = (): void => {
    if (stopped) return;
    stop();
    try { onGone(); } catch { /* coordinator owns final callback safety */ }
  };
  const check = (): void => {
    if (stopped) return;
    const usable = (() => {
      try { return dependencies.isUsable() === true; } catch { return false; }
    })();
    if (!usable) gone();
  };

  try {
    for (const event of EVENTS) {
      if (stopped) break;
      dependencies.listen(event, gone);
      installed.push(event);
    }
    if (!stopped) {
      const createdHandle = dependencies.every(check);
      pollHandle = createdHandle;
      hasPollHandle = true;
      if (stopped) {
        try { dependencies.clearEvery(createdHandle); } catch { /* already failed closed */ }
        hasPollHandle = false;
        pollHandle = undefined;
      } else {
        check();
      }
    }
  } catch {
    gone();
  }
  return stop;
}
