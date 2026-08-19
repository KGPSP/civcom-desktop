import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

type RouteCapability = object;
type Accepted = Readonly<{ kind: "accepted"; route: RouteCapability }>;
type Rejected = Readonly<{ kind: "rejected"; code: string }>;
type Result = Accepted | Rejected;
type Stat = Readonly<{
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
}>;
type FileSystem = Readonly<{
  constants: Readonly<{ O_RDONLY: number; O_NOFOLLOW?: number }>;
  lstatSync(path: string): Stat;
  openSync(path: string, flags: number): number;
  fstatSync(descriptor: number): Stat;
  readSync(descriptor: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(descriptor: number): void;
}>;
type CredentialModule = Readonly<{
  parseManualCredentialText?: (text: string) => Result;
  readManualCredentialFile?: (input: Readonly<{ filePath: string; platform: string; uid: number; fileSystem: FileSystem }>) => Result;
  navigateCredentialRoute?: (route: unknown, browser: Readonly<{ navigate(url: string): Promise<void> }>) => Promise<Readonly<{ kind: "accepted" | "rejected"; code: string }>>;
}>;

async function loadModule(): Promise<CredentialModule> {
  return await import(new URL("../scripts/manual/credential-file.mjs", import.meta.url).href).catch(() => Object.freeze({})) as CredentialModule;
}

const FAKE_TEXT = "adres_test=https://civcom.soia.info/#/room/!FAKE-PLACEHOLDER:soia.info\nlogin=FAKE_OPERATOR\npass=FAKE_PASSWORD\n";

function stat(overrides: Partial<Stat> = {}): Stat {
  return Object.freeze({
    dev: 10,
    ino: 20,
    mode: 0o100600,
    nlink: 1,
    uid: 501,
    size: Buffer.byteLength(FAKE_TEXT),
    mtimeMs: 1000,
    ctimeMs: 1000,
    isFile: () => true,
    ...overrides
  });
}

function fakeFileSystem(options: Readonly<{ before?: Stat; opened?: Stat; after?: Stat; text?: string; readError?: boolean }> = {}): Readonly<{ fileSystem: FileSystem; openedBuffers: Buffer[]; calls: string[] }> {
  const calls: string[] = [];
  const openedBuffers: Buffer[] = [];
  const text = options.text ?? FAKE_TEXT;
  let fstatCount = 0;
  const fileSystem: FileSystem = Object.freeze({
    constants: Object.freeze({ O_RDONLY: 0, O_NOFOLLOW: 0x100 }),
    lstatSync: () => { calls.push("lstat"); return options.before ?? stat({ size: Buffer.byteLength(text) }); },
    openSync: (_path, flags) => { calls.push(`open:${flags}`); return 9; },
    fstatSync: () => { calls.push("fstat"); fstatCount += 1; return fstatCount === 1 ? (options.opened ?? options.before ?? stat({ size: Buffer.byteLength(text) })) : (options.after ?? options.opened ?? options.before ?? stat({ size: Buffer.byteLength(text) })); },
    readSync: (_descriptor, buffer, offset, length, position) => {
      calls.push("read");
      openedBuffers.push(buffer);
      if (options.readError === true) throw new Error(`fake-secret:${text}`);
      const source = Buffer.from(text);
      source.copy(buffer, offset, 0, Math.min(length, source.length));
      expect(position).toBe(0);
      return Math.min(length, source.length);
    },
    closeSync: () => { calls.push("close"); }
  });
  return Object.freeze({ fileSystem, openedBuffers, calls });
}

describe("safe local manual credential file", () => {
  it("returns only a redacted non-forgeable room-route capability and zeroes the read buffer", async () => {
    const module = await loadModule();
    expect(typeof module.readManualCredentialFile).toBe("function");
    const fixture = fakeFileSystem();
    const result = module.readManualCredentialFile!({ filePath: "/fixed/repository/.cred.env", platform: "darwin", uid: 501, fileSystem: fixture.fileSystem });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(Object.keys(result)).toEqual(["kind", "route"]);
    expect(String(result.route)).toBe("[CivCom route]");
    expect(JSON.stringify(result)).not.toContain("FAKE_OPERATOR");
    expect(inspect(result)).not.toContain("FAKE_PASSWORD");
    expect(fixture.openedBuffers).toHaveLength(1);
    expect([...fixture.openedBuffers[0]!].every((byte) => byte === 0)).toBe(true);
    expect(fixture.calls).toEqual(["lstat", "open:256", "fstat", "read", "fstat", "close"]);
  });

  it("opens owner-only regular single-link files with no-follow and rejects file metadata hazards", async () => {
    const read = (await loadModule()).readManualCredentialFile;
    expect(typeof read).toBe("function");
    const cases: readonly Readonly<{ before: Stat; opened?: Stat; after?: Stat }>[] = [
      { before: stat({ mode: 0o100644 }) },
      { before: stat({ nlink: 2 }) },
      { before: stat({ uid: 502 }) },
      { before: stat({ size: 0 }) },
      { before: stat({ size: 16 * 1024 + 1 }) },
      { before: stat({ isFile: () => false }) },
      { before: stat(), opened: stat({ ino: 21 }) },
      { before: stat(), opened: stat(), after: stat({ mtimeMs: 1001 }) },
      { before: stat(), opened: stat(), after: stat({ ctimeMs: 1001 }) },
      { before: stat(), opened: stat(), after: stat({ size: Buffer.byteLength(FAKE_TEXT) - 1 }) }
    ];
    for (const fixture of cases) {
      const result = read!({ filePath: "/fixed/repository/.cred.env", platform: "linux", uid: 501, fileSystem: fakeFileSystem(fixture).fileSystem });
      expect(result.kind).toBe("rejected");
      expect(JSON.stringify(result)).not.toContain("/fixed/repository");
    }
  });

  it("fails closed on Windows before filesystem access", async () => {
    const read = (await loadModule()).readManualCredentialFile;
    expect(typeof read).toBe("function");
    const fixture = fakeFileSystem();
    expect(read!({ filePath: "C:\\repo\\.cred.env", platform: "win32", uid: 501, fileSystem: fixture.fileSystem })).toEqual({ kind: "rejected", code: "WINDOWS_ACL_UNSUPPORTED" });
    expect(fixture.calls).toEqual([]);
  });

  it("rejects format and exact-route hazards without retaining login or password", async () => {
    const parse = (await loadModule()).parseManualCredentialText;
    expect(typeof parse).toBe("function");
    const badRoutes = [
      "https://civcom.soia.info/",
      "https://civcom.soia.info/#/login",
      "https://civcom.soia.info/#/room/",
      "https://civcom.soia.info/?q=1#/room/fake",
      "https://user@civcom.soia.info/#/room/fake",
      "https://civcom.soia.info:444/#/room/fake",
      "https://civcom.soia.info.evil.invalid/#/room/fake",
      " https://civcom.soia.info/#/room/fake"
    ];
    for (const route of badRoutes) {
      const result = parse!(`adres_test=${route}\nlogin=FAKE_OPERATOR\npass=FAKE_PASSWORD\n`);
      expect(result.kind).toBe("rejected");
      expect(JSON.stringify(result)).not.toContain("FAKE_");
    }
    for (const text of [
      "adres_test=https://civcom.soia.info/#/room/fake\nlogin=one\nlogin=two\npass=fake",
      "adres_test=https://civcom.soia.info/#/room/fake\nlogin=one\npass=fake\nextra=x",
      "# comment\nadres_test=https://civcom.soia.info/#/room/fake\nlogin=one\npass=fake",
      "adres_test=https://civcom.soia.info/#/room/fake\nlogin=\npass=fake",
      "adres_test=https://civcom.soia.info/#/room/fake\nlogin=one\npass=fake\u0000"
    ]) expect(parse!(text).kind).toBe("rejected");
  });

  it("maps read failures to a constant code, closes the descriptor, and wipes the buffer", async () => {
    const read = (await loadModule()).readManualCredentialFile;
    expect(typeof read).toBe("function");
    const fixture = fakeFileSystem({ readError: true });
    const result = read!({ filePath: "/fixed/repository/.cred.env", platform: "darwin", uid: 501, fileSystem: fixture.fileSystem });
    expect(result).toEqual({ kind: "rejected", code: "CREDENTIAL_FILE_REJECTED" });
    expect(JSON.stringify(result)).not.toContain("fake-secret");
    expect(fixture.calls.at(-1)).toBe("close");
    expect([...fixture.openedBuffers[0]!].every((byte) => byte === 0)).toBe(true);
  });

  it("consumes a valid route exactly once through a navigate-only adapter", async () => {
    const module = await loadModule();
    expect(typeof module.parseManualCredentialText).toBe("function");
    expect(typeof module.navigateCredentialRoute).toBe("function");
    const parsed = module.parseManualCredentialText!(FAKE_TEXT);
    expect(parsed.kind).toBe("accepted");
    if (parsed.kind !== "accepted") return;
    const visited: string[] = [];
    const browser = Object.freeze({ navigate: async (url: string) => { visited.push(url); } });
    await expect(module.navigateCredentialRoute!(parsed.route, browser)).resolves.toEqual({ kind: "accepted", code: "ROUTE_NAVIGATED" });
    await expect(module.navigateCredentialRoute!(parsed.route, browser)).resolves.toEqual({ kind: "rejected", code: "ROUTE_REJECTED" });
    expect(visited).toEqual(["https://civcom.soia.info/#/room/!FAKE-PLACEHOLDER:soia.info"]);
  });

  it("keeps the checked-in example syntactically valid while clearly fake", async () => {
    const parse = (await loadModule()).parseManualCredentialText;
    expect(typeof parse).toBe("function");
    const example = await readFile(new URL("../.cred.env.example", import.meta.url), "utf8");
    expect(example).toContain("FAKE_PLACEHOLDER");
    expect(parse!(example).kind).toBe("accepted");
  });
});
