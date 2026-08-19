# CivCom Desktop

Thin Electron client for [CivCom](https://civcom.soia.info/). The remote CivCom page will remain a web-platform renderer: no preload, Node.js, IPC, or `window.electron` bridge.

## Development

Requires Node.js 22.12 or newer and npm. Install the locked dependencies, then use:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The foundation pins Electron `43.4.1`, electron-builder `26.15.3`, and electron-updater `6.8.9`. Packaging and Electron lifecycle behavior are intentionally deferred to later tasks.

## Local test credentials

`.cred.env` is ignored, must be local-only with mode `0600`, and is reserved for a future interactive manual check. Production application code and CI do not read it. Copy `.cred.env.example` only when that future manual procedure explicitly calls for it; do not paste credential values into issues, logs, tests, or commits.

## License

This project is licensed under [EUPL-1.2](LICENSE).
