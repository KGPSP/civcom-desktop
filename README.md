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
npm run verify
```

The project pins Electron `43.4.1`, electron-builder `26.15.3`, electron-updater `6.8.9`, and `@electron/fuses` `2.1.3`.

## Packaging and verification

The native package commands are `npm run package:win`, `npm run package:mac`, and `npm run package:linux`. Set exactly one build mode before invoking one on its native operating system. For example, a local macOS pilot and its packaged verification are:

```sh
CIVCOM_BUILD_MODE=pilot npm run package:mac
npm run package:verify -- --mode pilot --target macos
```

Every package command invokes electron-builder with `--publish never`. The local `release/` directory is ignored. An unsigned pilot may be retained only as a local ignored output or a short-lived `UNSIGNED-PILOT-*` workflow artifact. Never turn an unsigned pilot into a public GitHub Release.

The protected production workflow builds all three targets from a protected version tag whose commit is reachable from `origin/main`. Production Windows and macOS artifacts are signed, and macOS is notarized; the workflow verifies those identities, signatures, hardened runtime, universal helpers, notarization ticket, checksums, SBOM, and attestations before a draft-first release can be published. It requires externally managed values rather than checked-in identities:

- Windows: `CIVCOM_WINDOWS_PUBLISHER_DN`, `CSC_LINK`, and `CSC_KEY_PASSWORD`.
- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
- Linux DEB ownership: `CIVCOM_LINUX_MAINTAINER`.

Missing production or package ownership inputs fail the relevant job. The values belong in the protected GitHub environment as repository variables or secrets; this README intentionally supplies no certificate, Apple team, key, or maintainer value.

Windows, macOS, and AppImage packages use the validated update feed. A DEB always uses a manual update link and never initializes the in-app updater; install DEB updates through the administrator-approved package process.

## Asset provenance

`assets/civcom.svg` is the vendored CivCom mark copied from `https://civcom.soia.info/znak.svg`. The build never fetches it: it validates the checked-in local file and rejects active SVG content, external resources, and symbolic links.

## Local test credentials

`.cred.env` is ignored, must be local-only with mode `0600`, and is reserved for a future interactive manual check. Production application code and CI do not read it. Copy `.cred.env.example` only when that future manual procedure explicitly calls for it; do not paste credential values into issues, logs, tests, or commits.

## License

This project is licensed under [EUPL-1.2](LICENSE).
