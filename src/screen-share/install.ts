import { selectDisplayMediaRoute } from "./policy.js";

export function installDisplayMediaRequestHandler(input: Readonly<{
  session: Pick<Electron.Session, "setDisplayMediaRequestHandler">;
  environment: unknown;
  handle(request: Electron.DisplayMediaRequestHandlerHandlerRequest, callback: (streams: Electron.Streams) => void): void;
}>): void {
  const useSystemPicker = selectDisplayMediaRoute(input.environment) === "system-picker";
  input.session.setDisplayMediaRequestHandler(
    (request, callback) => input.handle(request, callback),
    Object.freeze({ useSystemPicker })
  );
}
