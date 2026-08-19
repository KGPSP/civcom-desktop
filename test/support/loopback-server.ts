import { execFile } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TrafficPath = "root" | "fixture-script" | "service-worker" | "redirect-source" | "redirect-target" | "forbidden-post" | "forbidden-websocket" | "forbidden-service-worker" | "forbidden-subresource" | "download" | "other";
export type TrafficRecord = Readonly<{ method: "GET" | "HEAD" | "POST" | "OTHER"; path: TrafficPath }>;

const PATHS: Readonly<Record<string, TrafficPath>> = Object.freeze({
  "/": "root",
  "/fixture.js": "fixture-script",
  "/fixture-sw.js": "service-worker",
  "/redirect-source": "redirect-source",
  "/redirect-target": "redirect-target",
  "/forbidden-post": "forbidden-post",
  "/forbidden-ws": "forbidden-websocket",
  "/forbidden-sw": "forbidden-service-worker",
  "/forbidden-subresource": "forbidden-subresource",
  "/download": "download"
});

const HTML = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self' ws:; img-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>CivCom local harness</title></head><body><main><h1>CivCom local harness</h1><a id="download" href="/download" download>Download fixture</a><script src="/fixture.js"></script></main></body></html>`;
const SCRIPT = `"use strict";
void navigator.serviceWorker.register("/fixture-sw.js");
window.civcomFixture = Object.freeze({
  post: () => fetch("/forbidden-post", { method: "POST", body: "fixture" }).catch(() => undefined),
  websocket: () => { try { const socket = new WebSocket("ws://" + location.host + "/forbidden-ws"); socket.onerror = () => undefined; } catch {} },
  serviceWorkerPost: async () => { const registration = await navigator.serviceWorker.ready; registration.active?.postMessage("attempt"); },
  subresource: () => { const image = new Image(); image.src = "/forbidden-subresource?access_token=fixture"; document.body.append(image); },
  redirect: () => fetch("/redirect-source").catch(() => undefined),
  popup: (url) => { try { window.open(url); } catch {} },
  permission: () => Notification.requestPermission().catch(() => "denied")
});`;
const SERVICE_WORKER = `"use strict";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => undefined);
self.addEventListener("message", () => { void fetch("/forbidden-sw", { method: "POST", body: "fixture" }).catch(() => undefined); });`;

function method(value: string | undefined): TrafficRecord["method"] {
  return value === "GET" || value === "HEAD" || value === "POST" ? value : "OTHER";
}

function path(value: string | undefined): TrafficPath {
  if (value === undefined) return "other";
  let pathname: string;
  try { pathname = new URL(value, "http://127.0.0.1").pathname; } catch { return "other"; }
  return PATHS[pathname] ?? "other";
}

function createFixtureServer(records: TrafficRecord[], tls?: Readonly<{ key: Buffer; cert: Buffer }>): Server {
  const requestPort = (request: IncomingMessage): number => {
    const address = request.socket.address();
    return typeof address === "object" && address !== null && "port" in address && typeof address.port === "number" ? address.port : 0;
  };
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    const port = requestPort(request);
    if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(421).end(); return; }
    const record = Object.freeze({ method: method(request.method), path: path(request.url) });
    records.push(record);
    if (record.path === "root") response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(HTML);
    else if (record.path === "fixture-script") response.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" }).end(SCRIPT);
    else if (record.path === "service-worker") response.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store", "service-worker-allowed": "/" }).end(SERVICE_WORKER);
    else if (record.path === "redirect-source") response.writeHead(302, { location: "/redirect-target" }).end();
    else if (record.path === "download") response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=fixture.bin" }).end("fixture");
    else response.writeHead(204).end();
  };
  const server = tls === undefined ? createHttpServer(listener) : createHttpsServer(tls, listener);
  server.on("upgrade", (request, socket) => {
    const port = requestPort(request);
    if (request.headers.host === `127.0.0.1:${port}`) records.push(Object.freeze({ method: method(request.method), path: path(request.url) }));
    socket.destroy();
  });
  return server;
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolvePromise(); });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("LOOPBACK_START_FAILED");
  return address.port;
}

async function stop(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
}

export async function createLoopbackFixture(): Promise<Readonly<{
  origin: string;
  records(): readonly TrafficRecord[];
  stop(): Promise<void>;
  restart(): Promise<void>;
}>> {
  const records: TrafficRecord[] = [];
  let server = createFixtureServer(records);
  const port = await listen(server, 0);
  return Object.freeze({
    origin: `http://127.0.0.1:${port}`,
    records: () => Object.freeze([...records]),
    stop: async () => await stop(server),
    restart: async () => { await stop(server); server = createFixtureServer(records); await listen(server, port); }
  });
}

export async function createSelfSignedLoopbackFixture(): Promise<Readonly<{ origin: string; requests(): number; stopAndRemove(): Promise<void> }>> {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "civcom-local-cert-"));
  await chmod(directory, 0o700);
  const resolved = resolve(directory);
  if (!resolved.startsWith(`${temporaryRoot}${sep}`) || !basename(resolved).startsWith("civcom-local-cert-")) throw new Error("TEMP_BOUNDARY_REJECTED");
  const keyPath = join(resolved, "key.pem");
  const certPath = join(resolved, "cert.pem");
  let stage: "OPENSSL" | "READ" | "LISTEN" = "OPENSSL";
  try {
    await execFileAsync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
    stage = "READ";
    const records: TrafficRecord[] = [];
    const server = createFixtureServer(records, { key: await readFile(keyPath), cert: await readFile(certPath) });
    stage = "LISTEN";
    const port = await listen(server, 0);
    return Object.freeze({
      origin: `https://127.0.0.1:${port}`,
      requests: () => records.length,
      stopAndRemove: async () => { await stop(server); await rm(resolved, { recursive: true }); }
    });
  } catch {
    await rm(resolved, { recursive: true });
    throw new Error(`TLS_FIXTURE_REJECTED_${stage}`);
  }
}
