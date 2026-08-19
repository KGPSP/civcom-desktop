# CivCom Desktop — procedura publikacji w GitHub

Ta procedura rozdziela opublikowanie kodu źródłowego od opublikowania stabilnych instalatorów. Kod można udostępnić po przejściu lokalnych bramek. Publiczne wydanie binarne wymaga dodatkowo podpisów, notaryzacji i natywnego odbioru.

## 1. Bramka lokalna

Na czystym drzewie i Node.js 24:

```sh
npm ci
npm run verify
npm run test:electron:local
git diff --check
```

Potwierdź bez odczytywania zawartości `.cred.env`, że plik jest ignorowany, ma `0600` i nie występuje w indeksie ani historii:

```sh
git check-ignore .cred.env
stat -f '%Sp %N' .cred.env
git ls-files .cred.env
git log --all -- .cred.env
```

## 2. Utworzenie repozytorium

Wykonaj dopiero po zatwierdzeniu publicznej publikacji kodu:

```sh
git branch -M main
gh repo create KGPSP/civcom-desktop --public --source=. --remote=origin --push
```

Nie twórz jeszcze tagu wydania. Najpierw ustaw ochronę repozytorium.

## 3. Ustawienia GitHub

- `main` jako default branch; wymagany pull request i zielony CI; blokada force-push oraz usuwania.
- Ruleset dla tagów `v*` ograniczający ich tworzenie i usuwanie.
- Environment `production-release` z wymaganymi recenzentami, bez self-review i bez admin bypass.
- GitHub Pages ze źródła `main` i katalogu `/docs`.
- Private vulnerability reporting, Dependabot alerts/security updates, secret scanning i push protection.
- Immutable releases.

Zmienne environment:

```text
CIVCOM_WINDOWS_PUBLISHER_DN
CIVCOM_APPLE_TEAM_ID
CIVCOM_LINUX_MAINTAINER
```

Sekrety environment:

```text
CIVCOM_WINDOWS_CSC_LINK
CIVCOM_WINDOWS_CSC_KEY_PASSWORD
CIVCOM_MACOS_CSC_LINK
CIVCOM_MACOS_CSC_KEY_PASSWORD
CIVCOM_APPLE_API_KEY
CIVCOM_APPLE_API_KEY_ID
CIVCOM_APPLE_API_ISSUER
```

Nie kopiuj do GitHub `.cred.env`, loginu, hasła ani tokenu Matrix.

## 4. Przygotowanie odbioru produkcyjnego

Wyznacz testerów i systemy dla `docs/testing/manual-acceptance-matrix.md`, ale nie wpisuj jeszcze wyników ani SHA. Dokładne podpisane artefakty powstaną dopiero z chronionego tagu. Cross-build nie zastępuje testu natywnego. Dla pierwszego `v0.1.0` tylko przypadki aktualizacji `C-18` i `C-20` mogą otrzymać kontrolowane `N/A`; muszą przejść jako `PASS` przed `v0.1.1`.

## 5. Tag oraz budowa podpisanego kandydata

Sprawdź, że `package.json`, `package-lock.json` i `RELEASE_NOTES.md` opisują tę samą wersję. Następnie utwórz chroniony tag:

```sh
git switch main
git pull --ff-only origin main
git tag -a v0.1.0 -m 'CivCom 0.1.0'
git push origin v0.1.0
```

Workflow `.github/workflows/release.yml` wykonuje natywne buildy, weryfikację podpisów i paczek, generuje SPDX, `SHA256SUMS`, `MD5SUMS` i atestacje. Po zakończeniu jobów `assemble` i `attest` job `publish` musi pozostać niezatwierdzony w chronionym environment do czasu ręcznego odbioru dokładnie tego zestawu plików.

Nie przesyłaj ręcznie plików z głównego katalogu `release/`. Jedynym dopuszczalnym zestawem jest dokładnie zweryfikowane `release/assembled` z 13 plikami kontraktu.

## 6. Odbiór dokładnych artefaktów i zgoda na publikację

Pobierz artefakt `PRODUCTION-assembled` z tego samego uruchomienia workflow, podstawiając jego identyfikator:

```sh
gh run download RUN_ID --repo KGPSP/civcom-desktop --name PRODUCTION-assembled --dir release/assembled
npm run release:verify
```

Zapisz SHA-256 i build SHA w macierzy, a następnie wykonaj wymagane testy na natywnych systemach. Wynik pilota lub wcześniejszego builda nie może być wpisany jako wynik tego kandydata. Dopiero gdy wszystkie wymagane pozycje mają `PASS` albo jawnie dopuszczone `N/A`, recenzent zatwierdza oczekujący job `publish` w environment `production-release`.

Job `publish` tworzy draft, wysyła dokładnie 13 zweryfikowanych plików, pobiera je ponownie, sprawdza metadane i zgodność bajtową, a dopiero potem publikuje wydanie jako `latest`.

Jeżeli workflow zatrzyma się po utworzeniu draftu, ponowna próba nie może nadpisywać istniejącego wydania. Recenzent najpierw sprawdza, że wydanie ma właściwy tag i nadal jest draftem:

```sh
gh release view v0.1.0 --repo KGPSP/civcom-desktop --json tagName,isDraft,isPrerelease,assets
```

Po potwierdzeniu, że draft pochodzi z nieudanego uruchomienia i nie został opublikowany, recenzent usuwa sam draft bez `--cleanup-tag` i zatwierdza interaktywne pytanie:

```sh
gh release delete v0.1.0 --repo KGPSP/civcom-desktop
```

Następnie można ponowić ten sam chroniony workflow. Nie usuwaj ani nie przesuwaj chronionego tagu.

## 7. Kontrola po publikacji

```sh
gh release view v0.1.0 --repo KGPSP/civcom-desktop
gh attestation verify release/assembled/* --repo KGPSP/civcom-desktop
```

Sprawdź stronę Pages na Windows, macOS, Linux i urządzeniu mobilnym oraz każdy link `releases/latest/download/...`. Pobierz `SHA256SUMS` i porównaj SHA-256. `MD5SUMS` jest jedynie dodatkową kontrolą błędów transmisji.

## Stan przed pierwszą publikacją

| Element | Wymagany stan |
|---|---|
| kod, licencja, dokumentacja i workflowy | zielone lokalne bramki |
| repozytorium `KGPSP/civcom-desktop` | utworzone i publiczne |
| `origin/main` | obecny i chroniony |
| podpis Windows | Authenticode z timestampem |
| podpis macOS | Developer ID, hardened runtime, notarization i stapling |
| Linux | natywny smoke DEB i AppImage z aktywnym sandboxem |
| macierz odbioru | zatwierdzona |
| tag `v0.1.0` | chroniony i osiągalny z `origin/main` |
