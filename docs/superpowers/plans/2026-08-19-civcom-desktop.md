# CivCom Desktop implementation plan

## Global constraints

- The production renderer loads only `https://civcom.soia.info/` in a persistent `persist:civcom` session.
- The remote renderer has no preload, no Node.js, no IPC, and no `window.electron`; it must remain Element Web's `WebPlatform`.
- Navigation, permissions, downloads, screen capture, external links, updates, tray, and autostart are controlled in the Electron main process with deny-by-default policies.
- `.cred.env` is local-only, mode `0600`, ignored by Git, never logged or used by CI, and only supports interactive manual testing.
- Automated production checks are anonymous and non-mutating. Authenticated production testing is manual with the local account and a second human tester.
- Public releases require Windows signing and macOS signing/notarization. Unsigned pilot output remains a workflow artifact, never a public release.
- Product metadata: `CivCom`, app id `info.soia.civcom.desktop`, repository `KGPSP/civcom-desktop`, license EUPL-1.2.
- Targets: Windows 10/11 x64 NSIS, macOS 13+ universal DMG/ZIP, Linux x64 AppImage/DEB.
- Use strict TypeScript, Electron 43.4.1, electron-builder 26.15.3, electron-updater 6.8.9, Vitest, and Playwright Electron. New behavior follows red-green-refactor TDD.

## Task 1: Foundation and repository safeguards

Create the Node/TypeScript/Electron project skeleton, exact dependency versions, scripts, lint/type/test configuration, EUPL-1.2 license, product metadata, safe asset pipeline, README, `.cred.env.example`, and tests for the credential metadata validator. Keep `.cred.env` ignored and unread by production code. Verify Electron's binary after installation.

## Task 2: Security and URL policy

Implement pure TypeScript policies for production/dev URL selection, exact origin validation, top-level navigation, external protocols, permission checks, redaction, and safe test-credential metadata parsing. Start with failing unit tests covering hostile lookalike domains, query/userinfo/port rejection, same-origin room fragments, production URL immutability, and secret redaction.

## Task 3: Desktop shell and lifecycle

Implement the Electron main process: secure persistent BrowserWindow without preload, single instance, fixed title, bounds persistence, close-to-tray, Polish menus, first-run autostart prompt, platform login startup, offline/retry page, safe external navigation, deny-by-default permissions, trusted downloads, local redacted logs, and update scheduling. Add testable adapters and tests before implementation.

## Task 4: Screen sharing

Implement `setDisplayMediaRequestHandler` with origin/user-gesture checks, macOS 15 system picker, Wayland portal path, and a local sandboxed source picker for Windows/X11/older macOS. The picker has its own minimal preload and IPC; thumbnails are ephemeral and the remote CivCom renderer receives no bridge. Write policy/state tests first.

## Task 5: Packaging, updates, CI, and download page

Configure electron-builder for NSIS x64, universal macOS DMG/ZIP, Linux AppImage/DEB, generic GitHub latest-download updater metadata, signing/notarization environment gates, checksums, SBOM/attestation hooks, hardened Electron fuses, Dependabot, CI, pilot artifact workflow, protected production release workflow, and a Polish no-analytics GitHub Pages download page with OS detection and manual alternatives.

## Task 6: Automated and manual test support

Add local harness fixtures for negative cases and anonymous live smoke tests for `/`, `/version`, `/config.json`, `/manifest.json`, `/sw.js`, welcome/login UI, service worker, WebPlatform, lack of Node/window.electron/IPC, and fatal console errors. Do not log in or mutate Matrix automatically. Add a local-only manual test checklist/helper that validates `.cred.env` metadata without printing values and opens the saved same-origin room route only after interactive login.

## Task 7: Whole-project verification and publication

Run unit, lint, typecheck, build, Electron smoke, anonymous live smoke, packaging checks, secret/history checks, and security review. Perform the manual macOS production login/session/download/notification/call/screen-share checks that are possible with the local account; record anything requiring the second tester or other operating systems as an explicit acceptance gate. Create and push the public `KGPSP/civcom-desktop` repository only after local verification. Do not create a public unsigned release.
