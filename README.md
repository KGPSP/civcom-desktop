# CivCom Desktop

Thin Electron client for [CivCom](https://civcom.soia.info/). The remote CivCom page will remain a web-platform renderer: no preload, Node.js, IPC, or `window.electron` bridge.

## Development

Requires Node.js 24 LTS and npm 11 or newer. Install the locked dependencies, then use:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The foundation pins Electron `43.4.1`, electron-builder `26.15.3`, and electron-updater `6.8.9`. Packaging and Electron lifecycle behavior are intentionally deferred to later tasks.

## Asset provenance

`assets/civcom.svg` is the vendored CivCom mark copied from `https://civcom.soia.info/znak.svg`. The build never fetches it: it validates the checked-in local file and rejects active SVG content, external resources, and symbolic links.

## Local test credentials

`.cred.env` is ignored, must be local-only with mode `0600`, and is reserved for a future interactive manual check. Production application code and CI do not read it. Copy `.cred.env.example` only when that future manual procedure explicitly calls for it; do not paste credential values into issues, logs, tests, or commits.

## License

This project is licensed under [EUPL-1.2](LICENSE).
