import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/packaged-command.mjs", import.meta.url).href;

type PackagedCommandModule = Readonly<{
  runPackagedCommand(command: string, args: readonly string[], options?: Readonly<{
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    timeout?: number;
  }>): string;
}>;

async function loadModule(): Promise<PackagedCommandModule> {
  return await import(moduleUrl) as PackagedCommandModule;
}

describe("packaged verifier command diagnostics", () => {
  it("reports a bounded status and category without echoing child output or local paths", async () => {
    const { runPackagedCommand } = await loadModule();
    const sensitive = "username=operator token=secret-room-token https://civcom.soia.info/#/room/private";
    let error: unknown;
    try {
      runPackagedCommand(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(`Failed to move to new namespace: Operation not permitted ${sensitive}`)}); process.exit(17);`]);
    } catch (value) {
      error = value;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/^Packaged verification command failed: node; status=17; category=user-namespace-denied$/);
    expect(message).not.toContain("operator");
    expect(message).not.toContain("secret-room-token");
    expect(message).not.toContain("civcom.soia.info");
    expect(message.length).toBeLessThan(256);
  });

  it("distinguishes a timeout without exposing the command body", async () => {
    const { runPackagedCommand } = await loadModule();
    expect(() => runPackagedCommand(process.execPath, ["-e", "setTimeout(() => {}, 10_000)", "sensitive-marker"], { timeout: 20 }))
      .toThrow(/^Packaged verification command failed: node; status=none; error=ETIMEDOUT; category=timeout$/);
  });

  it("preserves successful stdout and stderr for the verifier's strict parsers", async () => {
    const { runPackagedCommand } = await loadModule();
    expect(runPackagedCommand(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err');"]))
      .toBe("outerr");
  });
});
