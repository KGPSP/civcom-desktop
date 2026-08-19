# CivCom 0.1.0

Pierwsze wydanie desktopowego klienta komunikatora CivCom.

## Pliki do pobrania

- Windows 10/11 x64: `CivCom-Windows-x64.exe` — instalacja na profil użytkownika bez uprawnień administratora.
- macOS 13+ Intel/Apple Silicon: `CivCom-macOS-universal.dmg`.
- Ubuntu/Debian x86_64: `CivCom-Linux-x86_64.deb`.
- Linux x86_64 bez instalacji: `CivCom-Linux-x86_64.AppImage`.

## Najważniejsze funkcje

- osobne okno aplikacji uruchamiające wyłącznie `https://civcom.soia.info/`;
- trwała sesja, powiadomienia, tray/menu bar i opcjonalny autostart;
- obsługa wiadomości, załączników, połączeń audio/wideo i bezpiecznego wyboru udostępnianego ekranu;
- domyślne blokowanie nieznanych originów, schematów i uprawnień;
- brak telemetrii i zdalnego raportowania awarii.

## Weryfikacja

Pobierz `SHA256SUMS` i porównaj sumę SHA-256 przed instalacją. `MD5SUMS` służy wyłącznie do wykrywania błędów kopiowania. Wydanie zawiera także SPDX dla zależności npm i łańcucha budowy oraz atestacje GitHub.

Wydanie produkcyjne jest publikowane dopiero po natywnej weryfikacji paczek, sprawdzeniu podpisów Windows/macOS, notaryzacji macOS i akceptacji kompletnego draftu.
