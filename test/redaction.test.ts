import * as redaction from "../src/security/redaction.js";
import { describe, expect, test } from "vitest";

type RedactedValue = Readonly<{ kind: "redacted"; value: string }>;
type SafeLogEvent = Readonly<{
  event: "navigation-denied" | "permission-denied" | "load-failed" | "download-denied" | "security-event";
  code: "ERR_FAILED" | "ERR_CONNECTION_REFUSED" | "ERR_INTERNET_DISCONNECTED" | "ERR_ABORTED" | "UNCLASSIFIED";
  url?: string;
}>;

type Redaction = Readonly<{
  redactForLog(input: unknown): RedactedValue;
  createSafeLogEvent(input: unknown): SafeLogEvent;
}>;

const policy = redaction as unknown as Redaction;

describe("log redaction", () => {
  test("does not retain credentials, Matrix identifiers, message bodies, URLs queries, or fragments", () => {
    const login = "operator@example.org";
    const password = "correct-horse-battery-staple";
    const token = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.signature";
    const roomId = "!room-secret:soia.info";
    const roomAlias = "#dowodztwo:soia.info";
    const message = "Tresc prywatnej wiadomosci nie moze trafic do logu";
    const url = `https://civcom.soia.info/#/room/${roomId}?access_token=matrix-token`;

    const output = JSON.stringify([
      policy.redactForLog(`login=${login} password=${password} Authorization: ${token} ${roomId} ${roomAlias} ${message}`),
      policy.redactForLog(url),
      policy.createSafeLogEvent({
        event: "load-failed",
        code: "ERR_FAILED",
        url: "https://civcom.soia.info/path?access_token=matrix-token#fragment-secret",
        message
      })
    ]);

    for (const forbidden of [
      login,
      password,
      "eyJhbGciOiJIUzI1NiJ9",
      roomId,
      roomAlias,
      message,
      "access_token",
      "fragment-secret"
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });

  test("emits only allowlisted structured event data and maps unknown values safely", () => {
    expect(
      policy.createSafeLogEvent({
        event: "permission-denied",
        code: "ERR_ABORTED",
        url: "https://call.soia.info/room/opaque?token=secret#fragment"
      })
    ).toEqual({
      event: "permission-denied",
      code: "ERR_ABORTED",
      url: "https://call.soia.info/"
    });
    expect(
      policy.createSafeLogEvent({ event: "message-body", code: "DATABASE_PASSWORD=secret", message: "private" })
    ).toEqual({ event: "security-event", code: "UNCLASSIFIED" });
  });

  test("never throws when passed malformed or hostile values", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("do not inspect me");
        }
      }
    );
    expect(() => policy.redactForLog(hostile)).not.toThrow();
    expect(() => policy.redactForLog("https://%zz")).not.toThrow();
    expect(() => policy.createSafeLogEvent(hostile)).not.toThrow();
    expect(() => policy.createSafeLogEvent(null)).not.toThrow();
  });
});
