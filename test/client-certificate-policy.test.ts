import { describe, expect, it, vi } from "vitest";

type CertificateCallback = (...certificate: readonly unknown[]) => void;
type CertificateListener = (
  event: Readonly<{ preventDefault(): void }>,
  contents: unknown,
  url: string,
  certificateList: readonly unknown[],
  callback: CertificateCallback
) => void;
type GuardModule = Readonly<{
  installClientCertificateDenyHandler?: (target: Readonly<{
    on(event: "select-client-certificate", listener: CertificateListener): unknown;
  }>) => void;
}>;

async function loadGuard(): Promise<GuardModule> {
  const moduleUrl = new URL("../src/security/client-certificate.js", import.meta.url).href;
  return await import(moduleUrl).catch(() => Object.freeze({}));
}

describe("client-certificate policy", () => {
  it("prevents Electron's default choice and returns no certificate exactly once", async () => {
    const guard = await loadGuard();
    expect(typeof guard.installClientCertificateDenyHandler).toBe("function");
    if (guard.installClientCertificateDenyHandler === undefined) return;

    let listener: CertificateListener | undefined;
    const target = Object.freeze({
      on: vi.fn((event: "select-client-certificate", next: CertificateListener) => {
        expect(event).toBe("select-client-certificate");
        listener = next;
      })
    });
    guard.installClientCertificateDenyHandler(target);
    expect(target.on).toHaveBeenCalledTimes(1);
    expect(listener).toBeTypeOf("function");

    const preventDefault = vi.fn();
    const callback = vi.fn<CertificateCallback>();
    listener?.(
      Object.freeze({ preventDefault }),
      Object.freeze({}),
      "https://certificate-request.invalid/",
      Object.freeze([Object.freeze({ fingerprint: "not-selected" })]),
      callback
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]).toEqual([]);
  });
});
