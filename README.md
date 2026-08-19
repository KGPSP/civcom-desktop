# CivCom Desktop

CivCom Desktop to cienki, utwardzony klient Electron dla [CivCom](https://civcom.soia.info/). Aplikacja zawsze uruchamia adres `https://civcom.soia.info/` w osobnym oknie i zachowuje zdalny komunikator jako czystą platformę webową — bez Node.js, IPC, preloada i `window.electron` w głównym rendererze.

Opiekun projektu: Komenda Główna Państwowej Straży Pożarnej — Biuro Informatyki i Łączności. Projekt jest udostępniany na licencji [EUPL-1.2](LICENSE).

## Pobieranie i wymagania

Po opublikowaniu stabilnego wydania pliki będą dostępne na [stronie pobierania](https://kgpsp.github.io/civcom-desktop/) oraz w [GitHub Releases](https://github.com/KGPSP/civcom-desktop/releases/latest).

| System | Plik | Architektura | Uprawnienia |
|---|---|---|---|
| Windows 10/11 | `CivCom-Windows-x64.exe` | x64 | instalacja na profil użytkownika, bez uprawnień administratora |
| macOS 13+ | `CivCom-macOS-universal.dmg` | Intel i Apple Silicon | standardowe przeniesienie aplikacji do katalogu Aplikacje |
| Ubuntu/Debian | `CivCom-Linux-x86_64.deb` | x86_64 | instalacja systemowa wymaga uprawnień administratora |
| Linux | `CivCom-Linux-x86_64.AppImage` | x86_64 | uruchomienie bez instalacji i bez uprawnień administratora |

### Instalacja

Windows: pobierz plik `.exe` i uruchom go. Instalator jest jednoużytkownikowy (`per-user`) i nie powinien żądać konta administratora.

macOS: otwórz `.dmg`, a następnie przeciągnij CivCom do katalogu Aplikacje. Publiczne wydanie musi być podpisane Developer ID i notaryzowane przez Apple.

Ubuntu/Debian:

```sh
sudo apt install ./CivCom-Linux-x86_64.deb
```

AppImage — wariant bez instalacji:

```sh
chmod +x CivCom-Linux-x86_64.AppImage
./CivCom-Linux-x86_64.AppImage
```

AppImage najlepiej przechowywać w stałym katalogu użytkownika, ponieważ ta ścieżka jest używana przez autostart i aktualizator. Aktualizacja DEB jest ręczna; klient nie uruchamia samodzielnie `apt`, `dpkg`, `sudo` ani `pkexec`.

## Weryfikacja pobranego pliku

Każde wydanie zawiera `SHA256SUMS` oraz pomocniczy `MD5SUMS`. SHA-256 służy do właściwej weryfikacji integralności. MD5 jest udostępniany wyłącznie do wykrywania błędów kopiowania lub pobierania i nie stanowi zabezpieczenia kryptograficznego.

Windows PowerShell:

```powershell
Get-FileHash .\CivCom-Windows-x64.exe -Algorithm SHA256
Get-FileHash .\CivCom-Windows-x64.exe -Algorithm MD5
```

macOS:

```sh
shasum -a 256 CivCom-macOS-universal.dmg
md5 CivCom-macOS-universal.dmg
```

Linux — w katalogu zawierającym komplet plików wydania:

```sh
sha256sum -c SHA256SUMS
md5sum -c MD5SUMS
```

## Prywatność i bezpieczeństwo

- Brak telemetrii, Sentry i zdalnego raportowania awarii.
- Kamera i mikrofon wymagają każdorazowej zgody użytkownika.
- Udostępniane okno lub monitor jest zawsze wybierane przez użytkownika; dźwięk systemowy jest osobną, domyślnie wyłączoną opcją na Windows.
- Nieznane originy, schematy, błędy certyfikatu i uprawnienia są blokowane domyślnie.
- Lokalny profil zachowuje sesję, ale dane logowania nie są zapisywane w repozytorium ani wprowadzane automatycznie.

Podatności należy zgłaszać zgodnie z [SECURITY.md](SECURITY.md). Nie umieszczaj danych logowania, tokenów, identyfikatorów pokoi, treści wiadomości ani danych służbowych w publicznych Issues.

## Rozwój i testy

Wymagane są Node.js 24 LTS i npm 11 lub nowszy:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
npm run test:electron:local
```

Test anonimowy produkcyjnego CivCom jest osobną, jawną bramką. Zalogowany odbiór jest wyłącznie ręczny:

```sh
npm run test:manual:production
```

Helper sprawdza lokalny `.cred.env`, lecz nigdy nie wpisuje loginu ani hasła. Plik musi pozostać lokalny, ignorowany i mieć tryb `0600`. Szczegółowe zasady zawiera [macierz odbioru](docs/testing/manual-acceptance-matrix.md).

Projekt przypina Electron `43.4.1`, electron-builder `26.15.3`, electron-updater `6.8.9` i `@electron/fuses` `2.1.3`. Zasady zmian opisuje [CONTRIBUTING.md](CONTRIBUTING.md).

## Pakowanie lokalnego pilota

Komendy natywne to `npm run package:win`, `npm run package:mac` i `npm run package:linux`. Przed uruchomieniem należy ustawić dokładnie jeden tryb. Przykład dla macOS:

```sh
CIVCOM_BUILD_MODE=pilot npm run package:mac
npm run package:verify -- --mode pilot --target macos
```

Każda komenda buildera używa `--publish never`. Katalog `release/` jest ignorowany. Niepodpisany pilot może być wyłącznie lokalnym plikiem albo krótkotrwałym artefaktem workflow `UNSIGNED-PILOT-*`. Nigdy nie publikuj niepodpisanego pilota jako publicznego wydania GitHub.

## Wydanie produkcyjne w GitHub

Chroniony workflow buduje trzy platformy natywnie z chronionego tagu `v*`, którego commit należy do `origin/main`. Artefakty produkcyjne Windows i macOS są podpisane, a wydanie macOS jest dodatkowo notaryzowane. Pipeline weryfikuje podpisy, hardened runtime, notaryzację, fuses, integralność ASAR, metadane aktualizatora, SPDX, SHA-256, MD5 i atestacje, a następnie tworzy draft i publikuje go dopiero po ponownym pobraniu oraz porównaniu wszystkich plików.

Environment `production-release` wymaga następujących wartości zarządzanych poza repozytorium:

- zmienne: `CIVCOM_WINDOWS_PUBLISHER_DN`, `CIVCOM_APPLE_TEAM_ID`, `CIVCOM_LINUX_MAINTAINER`;
- sekrety Windows: `CIVCOM_WINDOWS_CSC_LINK`, `CIVCOM_WINDOWS_CSC_KEY_PASSWORD`;
- sekrety macOS: `CIVCOM_MACOS_CSC_LINK`, `CIVCOM_MACOS_CSC_KEY_PASSWORD`, `CIVCOM_APPLE_API_KEY`, `CIVCOM_APPLE_API_KEY_ID`, `CIVCOM_APPLE_API_ISSUER`.

Brak któregokolwiek wymaganego podpisu lub parametru zatrzymuje wydanie.

Kolejność utworzenia repozytorium, ustawień ochronnych, podpisanego tagu i kontroli draftu opisuje [procedura publikacji](docs/GITHUB-PUBLICATION.md).

## Pochodzenie znaku

`assets/civcom.svg` jest lokalną kopią znaku CivCom z `https://civcom.soia.info/znak.svg`. Build nie pobiera aktywów z sieci i odrzuca aktywny SVG, zasoby zewnętrzne oraz dowiązania symboliczne.
