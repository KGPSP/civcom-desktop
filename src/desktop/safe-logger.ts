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
    const safe = createSafeLogEvent(input);
    // Origin is safe in Task 2, but a lifecycle log does not need it at all.
    const record = JSON.stringify({ timestamp: this.storage.now().toISOString(), event: safe.event, code: safe.code }) + "\n";
    const current = this.storage.read("civcom.log") ?? "";
    if (current.length + record.length > this.storage.maxBytes) this.rotate();
    this.storage.write("civcom.log", (this.storage.read("civcom.log") ?? "") + record);
  }

  private rotate(): void {
    for (let index = this.storage.maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? "civcom.log" : `civcom.${index - 1}.log`;
      const target = `civcom.${index}.log`;
      const contents = this.storage.read(source);
      if (contents !== undefined) this.storage.write(target, contents);
    }
    this.storage.remove("civcom.log");
  }
}
