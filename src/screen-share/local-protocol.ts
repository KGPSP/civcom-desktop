import { readFile as readFileFromDisk } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const PICKER_SCHEME = "civcom-local";
export const PICKER_DOCUMENT_URL = "civcom-local://picker/index.html";

const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), display-capture=(), geolocation=(), usb=(), serial=(), hid=()",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; manifest-src 'none'; frame-ancestors 'none'; object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"
});

const ROUTES = Object.freeze({
  "civcom-local://picker/index.html": Object.freeze({ filename: "picker.html", contentType: "text/html; charset=utf-8" }),
  "civcom-local://picker/picker.css": Object.freeze({ filename: "picker.css", contentType: "text/css; charset=utf-8" }),
  "civcom-local://picker/picker-renderer.js": Object.freeze({ filename: "picker-renderer.js", contentType: "text/javascript; charset=utf-8" })
});

function generic(status: 404 | 405): Response {
  return new Response(status === 404 ? "Not found" : "Method not allowed", {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" }
  });
}

export function registerLocalScheme(registrar: Pick<Electron.Protocol, "registerSchemesAsPrivileged">): void {
  registrar.registerSchemesAsPrivileged([{ scheme: PICKER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

export function createPickerProtocolHandler(input: Readonly<{
  rootDirectory: string;
  readFile?: typeof readFileFromDisk;
}>): (request: Readonly<{ url: string; method: string }>) => Promise<Response> {
  if (typeof input.rootDirectory !== "string" || !isAbsolute(input.rootDirectory)) throw new Error("invalid-picker-resource-root");
  const root = resolve(input.rootDirectory);
  const readFile = input.readFile ?? readFileFromDisk;
  const files = new Map<string, Readonly<{ location: string; contentType: string }>>();
  for (const [url, route] of Object.entries(ROUTES)) {
    const location = resolve(root, route.filename);
    const fromRoot = relative(root, location);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) throw new Error("invalid-picker-resource-map");
    files.set(url, Object.freeze({ location, contentType: route.contentType }));
  }

  return async (request): Promise<Response> => {
    try {
      const method = request.method;
      const url = request.url;
      if (method !== "GET" && method !== "HEAD") return generic(405);
      if (typeof url !== "string" || [...url].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; })) return generic(404);
      const resource = files.get(url);
      if (resource === undefined) return generic(404);
      const contents = await readFile(resource.location);
      return new Response(method === "HEAD" ? null : contents, { status: 200, headers: { ...SECURITY_HEADERS, "Content-Type": resource.contentType } });
    } catch {
      return generic(404);
    }
  };
}

export function installPickerProtocol(input: Readonly<{
  sessions: Readonly<{ fromPartition(partition: string): Readonly<{ protocol: Readonly<{
    isProtocolHandled(scheme: string): boolean;
    handle(scheme: string, handler: (request: Readonly<{ url: string; method: string }>) => Promise<Response>): void;
  }> }> }>;
  rootDirectory: string;
  readFile?: typeof readFileFromDisk;
}>): unknown {
  const pickerSession = input.sessions.fromPartition("civcom-picker");
  if (pickerSession.protocol.isProtocolHandled(PICKER_SCHEME)) throw new Error("picker-protocol-already-installed");
  pickerSession.protocol.handle(PICKER_SCHEME, createPickerProtocolHandler({ rootDirectory: input.rootDirectory, ...(input.readFile === undefined ? {} : { readFile: input.readFile }) }));
  return pickerSession;
}
