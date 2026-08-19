import type { App } from "electron";

export function installClientCertificateDenyHandler(target: Pick<App, "on">): void {
  target.on("select-client-certificate", (event, _contents, _url, _certificateList, callback) => {
    event.preventDefault();
    callback();
  });
}
