import { createSafeLogEvent } from "../security/redaction.js";

export type LogStorage = Readonly<{
  now: () => Date;
  read: (name: string) => string | undefined;
  write: (name: string, contents: string) => void;
  remove: (name: string) => void;
}>;

export class RotatingSafeLogger {
  public constructor(private readonly storage: LogStorage & Readonly<{ maxBytes: number; maxFiles: number }>) {}

  public write(input: unknown): void {
    try {
      const safe = createSafeLogEvent(input);
      this.append(safe.event, safe.code);
    } catch { /* logging must never affect the shell */ }
  }

  public lifecycle(event: unknown, code: unknown = "OK"): void {
    try {
      const safe = this.safeLifecycle(event, code);
      this.append(safe.event, safe.code);
    } catch { /* logging must never affect the shell */ }
  }

  private safeLifecycle(event: unknown, code: unknown): Readonly<{ event: string; code: string }> {
    if (event === "startup" || event === "ready" || event === "hide" || event === "stop") return Object.freeze({ event, code: "OK" });
    if (event === "version" && typeof code === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(code)) return Object.freeze({ event, code });
    if (event === "download-progress" && typeof code === "string" && /^(?:[0-9]|10):(progressing|interrupted)$/.test(code)) return Object.freeze({ event, code });
    if (event === "update-error" && (code === "ERR" || code === "UNCLASSIFIED")) return Object.freeze({ event, code });
    return Object.freeze({ event: "security-event", code: "UNCLASSIFIED" });
  }

  private append(event: string, code: string): void {
    const record = JSON.stringify({ schema: 1, timestamp: this.storage.now().toISOString(), event, code }) + "\n";
    const current = this.storage.read("civcom.log") ?? "";
    if (Buffer.byteLength(current, "utf8") + Buffer.byteLength(record, "utf8") > this.storage.maxBytes) this.rotate();
    this.storage.write("civcom.log", (this.storage.read("civcom.log") ?? "") + record);
  }

  private rotate(): void {
    for (let index = Math.max(1, this.storage.maxFiles - 1); index >= 1; index -= 1) {
      const source = index === 1 ? "civcom.log" : `civcom.${index - 1}.log`;
      const target = `civcom.${index}.log`;
      const contents = this.storage.read(source);
      if (contents !== undefined) this.storage.write(target, contents);
    }
    this.storage.remove("civcom.log");
  }
}
