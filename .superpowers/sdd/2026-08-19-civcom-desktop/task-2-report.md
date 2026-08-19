# Task 2 — security and URL policy report

Commit: `feat: add CivCom security policies` (this report is committed with the implementation).

## Scope delivered

- Added pure TypeScript URL/origin policy in `src/security/url-policy.ts`; it has no Electron, environment, or filesystem dependency.
- The packaged path always resolves to the literal `https://civcom.soia.info/`. A development URL is considered only while `isPackaged === false`, and only if it is HTTP(S), has no userinfo, and targets `127.0.0.1`, `[::1]`, or `localhost`.
- Trusted origins are exact default-port HTTPS CivCom, auth, Matrix, and Element Call origins. Top-level navigation is restricted to CivCom/auth; Matrix and Call remain service origins only. External protocol handling permits only HTTPS and `mailto:`.
- Added deny-by-default permission and display-media authorization policies. CivCom and Element Call may request only `media`, `notifications`, `fullscreen`, and `clipboard-sanitized-write`; display media also requires a user gesture.
- Extended the credential metadata module with a pure parser for exactly `adres_test`, `login`, and `pass`. It rejects invalid metadata, malformed/duplicate/extra fields, empty secrets, non-CivCom routes, and any query. Secrets and route identifiers have safe `String`, JSON, and Node inspect representations; only the explicit route resolver returns the validated navigation URL.
- Added a log-safe redaction boundary which accepts only allowlisted event names/error codes, records at most an origin (never a path/query/fragment), and ignores any message body. It cannot throw on malformed or hostile input.

## TDD evidence

Each behavior group was introduced RED before its production implementation:

| Cycle | RED command and observed failure | GREEN command |
| --- | --- | --- |
| URL/origin/top-level/external protocol | `npm test -- test/url-policy.test.ts` — 7 expected `TypeError: policy.* is not a function` failures | `npm test -- test/url-policy.test.ts` — 7 passed; then `npm run typecheck` passed after the discriminated-navigation return correction |
| Permission/display media | `npm test -- test/url-policy.test.ts` — 4 expected missing-policy failures | `npm test -- test/url-policy.test.ts && npm run typecheck` — 11 passed and typecheck passed |
| Manual credential parser | `npm test -- test/credential-metadata.test.ts` — 4 expected missing-parser/resolver failures | `npm test -- test/credential-metadata.test.ts && npm run typecheck` — 8 passed; lint then identified and the implementation removed the unused-private-field warning without exposing the value |
| Redaction | `npm test -- test/redaction.test.ts` — 3 expected missing-redactor failures | `npm test -- test/redaction.test.ts && npm run typecheck && npm run lint` — all passed |
| Malformed metadata/backslash normalization hardening | `npm test -- test/credential-metadata.test.ts test/url-policy.test.ts` — expected failures: malformed metadata threw and `https://civcom.soia.info\\evil` normalized to a trusted URL | same command after the minimal guards — 20 passed |

## Test coverage

- URL tests cover production immutability, all permitted loopback forms, non-loopback/userinfo dev rejection, exact service origins, Unicode/punycode/lookalikes, `civcom.soia.info.evil`, both userinfo forms, custom ports, encoded authority, backslash normalization, malformed URLs, top-level restrictions, external protocols, all permitted permissions, denied origins/unknown permissions, and user-gesture display media.
- Credential tests cover owner-only local/manual metadata, exact key set, duplicate/extra/empty fields, query rejection, same-origin room fragments, and safe string/JSON/inspect behavior for login/password/room identifier.
- Redaction tests demonstrate that a sample login, password, bearer/JWT token, Matrix room id/alias, message body, query key/value, and fragment do not survive serializable log output; malformed URL/proxy/null input never throws.

## Final verification

Executed successfully:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:electron
git diff --check 02db3fd9f993d20fc267b359a83ef93a47851174
```

Results: lint clean; strict typecheck clean; Vitest `4` files / `37` tests passed; build passed; Electron `v43.4.1` binary verification passed; diff check clean.

`gitleaks` is not installed in this workspace. A fallback tracked/working-tree scan excluding `.cred.env` and `.cred.env.*` found no populated `login=`, `pass=`, or `adres_test=` credential records. The production policy source also contains no Electron import, `process.env`, filesystem API, or `.cred.env` reference. No credentials were read.

## Self-review and follow-up risk

- The policies are intentionally pure and are not wired into Electron yet; Task 3 must consume the navigation/permission/external-link decisions and Task 4 the display-media decision.
- `auth.soia.info`, `matrix.soia.info`, and `call.soia.info` are fixed exact origins. The public CivCom config confirmed Matrix/Call, and an anonymous HTTPS reachability check confirmed the auth host; Task 6 should still observe the real OIDC redirect in the controlled manual flow before a release claim.
- `resolveValidatedRoute` deliberately exposes the validated route only for the later manual navigation consumer; neither the parser nor its returned safe representations log or persist it. Task 6 must keep that value out of logs and durable state.
