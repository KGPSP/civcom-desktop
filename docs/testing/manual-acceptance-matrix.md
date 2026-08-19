# CivCom Desktop — macierz ręcznego odbioru

Ta checklista dotyczy wyłącznie zatwierdzonego pokoju testowego. Nie wolno wchodzić do pokojów operacyjnych, przeglądać danych innych użytkowników ani używać rzeczywistych treści służbowych. Helper tylko sprawdza lokalny plik `.cred.env`, uruchamia prawdziwy klient i po ręcznym logowaniu otwiera zapisaną trasę. Nie wpisuje loginu ani hasła.

Zakres obejmuje między innymi potwierdzenie wysłania i odbioru zaszyfrowanej wiadomości oraz zaszyfrowanego pliku, bez ujawniania ich treści lub nazwy.

## Zasady zapisu wyniku

- Dopuszczalne statusy to dokładnie `PASS/FAIL/BLOCKED/N/A`. `PASS` oznacza wykonany test i pozytywny wynik, a nie gotowość do wykonania.
- Brak systemu lub właściwej architektury oznacza `BLOCKED`, nigdy `PASS`.
- Brak wymaganego uprawnienia, podpisu, notaryzacji albo drugiego testera oznacza `BLOCKED`.
- Brak poprzedniej podpisanej wersji do testu aktualizacji oznacza `BLOCKED`.
- Dowód zredagowany może zawierać datę, system, numer wersji, kod wyniku, SHA-256, build SHA oraz wynik systemowego sprawdzenia podpisu. Nie może zawierać nazwy użytkownika, identyfikatora ani nazwy pokoju, treści wiadomości, nazwy pliku, URL ani parametrów, tokenu, danych logowania ani zrzutu ekranu zalogowanej sesji.
- Każdy `FAIL` opisuje wyłącznie bezpieczny kod/objaw i krok odtworzenia, bez surowego komunikatu mogącego zawierać dane sesji.
- Tester kończy rozmowy i udostępnianie, redaguje lub usuwa treści testowe, jeśli ma uprawnienia, oraz wylogowuje zbędne urządzenia.

## Macierz platform i artefaktów

Każdy wiersz platformy należy połączyć z odpowiednimi przypadkami z następnej tabeli. Pola SHA nie mogą pozostać puste przy `PASS`.

| ID | system/arch | artefakt SHA-256 | build SHA | warunki | czynność | wynik oczekiwany | dowód zredagowany | PASS/FAIL/BLOCKED/N/A | wymagany drugi tester | uwagi |
|---|---|---|---|---|---|---|---|---|---|---|
| P-W10 | Windows 10 x64 | wpisać | wpisać | podpisany NSIS | wykonać pełny zestaw W/C | instalacja per-user i klient działają bez podnoszenia uprawnień | SHA, build, wynik Authenticode | wpisać | zależnie od przypadku | tylko x64 |
| P-W11 | Windows 11 x64 | wpisać | wpisać | podpisany NSIS | wykonać pełny zestaw W/C | jak dla Windows 10 | SHA, build, wynik Authenticode | wpisać | zależnie od przypadku | tylko x64 |
| P-M13-I | macOS 13 Intel | wpisać | wpisać | podpisany/notarized DMG; local picker | wykonać pełny zestaw M/C | klient Intel i lokalny selektor działają | SHA, build, codesign/notarization/stapling | wpisać | zależnie od przypadku | bez system pickera |
| P-M13-A | macOS 13 Apple Silicon | wpisać | wpisać | podpisany/notarized DMG; local picker | wykonać pełny zestaw M/C | klient arm64 i lokalny selektor działają | SHA, build, codesign/notarization/stapling | wpisać | zależnie od przypadku | bez system pickera |
| P-M14-I | macOS 14 Intel | wpisać | wpisać | podpisany/notarized DMG; local picker | wykonać pełny zestaw M/C | klient i lokalny selektor działają | SHA, build, wynik bramek macOS | wpisać | zależnie od przypadku | — |
| P-M14-A | macOS 14 Apple Silicon | wpisać | wpisać | podpisany/notarized DMG; local picker | wykonać pełny zestaw M/C | klient i lokalny selektor działają | SHA, build, wynik bramek macOS | wpisać | zależnie od przypadku | — |
| P-M15-I | macOS 15+ Intel | wpisać | wpisać | sprzęt dostępny; system picker | wykonać pełny zestaw M/C | użyty jest systemowy picker | SHA, build, wersja systemu, kod wyniku | wpisać | zależnie od przypadku | jeśli sprzętu brak: BLOCKED |
| P-M15-A | macOS 15+ Apple Silicon | wpisać | wpisać | system picker | wykonać pełny zestaw M/C | użyty jest systemowy picker | SHA, build, wersja systemu, kod wyniku | wpisać | zależnie od przypadku | — |
| P-U22-W-D | Ubuntu 22.04 x64 Wayland | wpisać | wpisać | DEB; portal aktywny | wykonać pełny zestaw L/C | instalacja DEB i portal działają | SHA, build, pakiet, sesja Wayland | wpisać | zależnie od przypadku | — |
| P-U22-W-A | Ubuntu 22.04 x64 Wayland | wpisać | wpisać | AppImage bez FUSE2; portal | wykonać pełny zestaw L/C | AppImage startuje bez FUSE2 | SHA, build, kod startu | wpisać | zależnie od przypadku | — |
| P-U22-X-D | Ubuntu 22.04 x64 X11 | wpisać | wpisać | DEB; local picker | wykonać pełny zestaw L/C | DEB i lokalny selektor działają | SHA, build, sesja X11 | wpisać | zależnie od przypadku | — |
| P-U22-X-A | Ubuntu 22.04 x64 X11 | wpisać | wpisać | AppImage bez FUSE2; local picker | wykonać pełny zestaw L/C | AppImage i lokalny selektor działają | SHA, build, kod startu | wpisać | zależnie od przypadku | — |
| P-U24-W-D | Ubuntu 24.04 x64 Wayland | wpisać | wpisać | DEB; portal | wykonać pełny zestaw L/C | instalacja i portal działają | SHA, build, sesja Wayland | wpisać | zależnie od przypadku | — |
| P-U24-W-A | Ubuntu 24.04 x64 Wayland | wpisać | wpisać | AppImage bez FUSE2; portal | wykonać pełny zestaw L/C | AppImage i portal działają | SHA, build, kod startu | wpisać | zależnie od przypadku | — |
| P-U24-X-D | Ubuntu 24.04 x64 X11 | wpisać | wpisać | DEB; local picker | wykonać pełny zestaw L/C | DEB i lokalny selektor działają | SHA, build, sesja X11 | wpisać | zależnie od przypadku | — |
| P-U24-X-A | Ubuntu 24.04 x64 X11 | wpisać | wpisać | AppImage bez FUSE2; local picker | wykonać pełny zestaw L/C | AppImage i lokalny selektor działają | SHA, build, kod startu | wpisać | zależnie od przypadku | — |
| P-D12-D | Debian 12 x64 | wpisać | wpisać | DEB | wykonać pełny zestaw L/C | instalacja DEB działa | SHA, build, wynik dpkg | wpisać | zależnie od przypadku | Wayland/X11 wpisać w uwagach |
| P-D12-A | Debian 12 x64 | wpisać | wpisać | AppImage bez FUSE2 | wykonać pełny zestaw L/C | AppImage działa | SHA, build, kod startu | wpisać | zależnie od przypadku | — |
| P-FED-A | Fedora current x64 | wpisać | wpisać | AppImage compatibility; brak FUSE2 | wykonać zgodność L oraz C | AppImage działa z sandboxem | SHA, build, wersja Fedora | wpisać | zależnie od przypadku | nie jest docelowym DEB |

Legenda zestawów: `W` — Windows, `M` — macOS, `L` — Linux, `C` — przypadki wspólne.

## Przypadki odbiorowe

| ID | system/arch | artefakt SHA-256 | build SHA | warunki | czynność | wynik oczekiwany | dowód zredagowany | PASS/FAIL/BLOCKED/N/A | wymagany drugi tester | uwagi |
|---|---|---|---|---|---|---|---|---|---|---|
| W-01 | Windows 10/11 x64 | z P-* | z P-* | signed NSIS | sprawdzić podpis i zainstalować per-user | Authenticode ważny, timestamp obecny, brak elevation helpera | kod weryfikacji podpisu | wpisać | nie | — |
| M-01 | macOS 13/14/15+ Intel/Apple Silicon | z P-* | z P-* | Developer ID | sprawdzić codesign, notarization i stapling; otworzyć DMG | wszystkie trzy bramki pozytywne, brak ostrzeżenia Gatekeepera | stałe wyniki codesign/notarization/stapling | wpisać | nie | — |
| L-01 | Ubuntu/Debian/Fedora x64 | z P-* | z P-* | właściwy DEB lub AppImage | zainstalować/uruchomić na czystym systemie bez FUSE2 | start bez `--no-sandbox`; AppImage nie wymaga FUSE2 | wersja systemu i kod startu | wpisać | nie | Fedora tylko AppImage |
| C-01 | każda pozycja P-* | z P-* | z P-* | finalny artefakt | zweryfikować final fuses, integralny ASAR i brak luźnego kodu | dziewięć fuses zgodnych; ASAR zgodny z bramką platformy | bezpieczny raport fuse/ASAR | wpisać | nie | integralność kryptograficzna ASAR tylko Windows/macOS |
| C-02 | każda pozycja P-* | z P-* | z P-* | sieć z poprawnym TLS | uruchomić bez flag debug | certyfikat zaakceptowany; WebPlatform; brak Node, IPC, preload i `window.electron` | kod capability, wersja Electron/CivCom | wpisać | nie | bez surowego URL |
| C-03 | każda pozycja P-* | z P-* | z P-* | konto testowe i `.cred.env` 0600 | uruchomić helper; samodzielnie wykonać direct/OIDC manual login | helper niczego nie wpisuje; logowanie przez `auth.soia.info` kończy się w CivCom | kod ręcznego potwierdzenia | wpisać | nie | login/hasło nigdy w dowodzie |
| C-04 | każda pozycja P-* | z P-* | z P-* | zalogowana sesja testowa | zamknąć jawnie, uruchomić ponownie na tym samym profilu | trwałość sesji po restarcie | kod sesji bez identyfikatora | wpisać | nie | — |
| C-05 | każda pozycja P-* | z P-* | z P-* | konto testowe | wykonać wylogowanie i ponowne logowanie ręczne | obie operacje kończą się poprawnie | dwa stałe kody wyniku | wpisać | nie | — |
| C-06 | każda pozycja P-* | z P-* | z P-* | istniejący zatwierdzony pokój testowy | po logowaniu pozwolić helperowi otworzyć zapisaną trasę | właściwy pokój testowy otwarty bez ujawnienia trasy | kod `MANUAL_ROUTE_READY` | wpisać | nie | brak nazwy/id pokoju |
| C-07 | każda pozycja P-* | z P-* | z P-* | drugi tester w tym samym pokoju | wysłać i odebrać zaszyfrowaną wiadomość testową | obie strony potwierdzają odszyfrowanie | dwa kody kierunku, bez treści | wpisać | tak | brak drugiego testera = BLOCKED |
| C-08 | każda pozycja P-* | z P-* | z P-* | drugi tester i neutralny plik testowy | wykonać upload i download zaszyfrowanego pliku | odbiór i lokalny zapis w Pobrane; plik nie uruchamia się automatycznie | rozmiar/kod, bez nazwy pliku | wpisać | tak | usunąć plik po teście |
| C-09 | każda pozycja P-* | z P-* | z P-* | powiadomienia dozwolone; okno schowane | drugi tester wysyła neutralną wiadomość | powiadomienie pojawia się w tle bez ujawnienia treści | kod powiadomienia, bez screenshotu | wpisać | tak | — |
| C-10 | każda pozycja P-* | z P-* | z P-* | kamera/mikrofon i drugi tester | wykonać rozmowę audio i wideo | dwukierunkowy dźwięk i obraz; zakończenie zwalnia urządzenia | kody audio/wideo | wpisać | tak | zakończyć połączenia |
| C-11 | Windows/X11/macOS 13–14 | z P-* | z P-* | local picker i drugi tester | udostępnić jednego okna, potem całego monitora; za każdym razem wybrać źródło | nigdy nie wybiera automatycznie; widoczne tylko wybrane źródło | kody picker-window/picker-monitor | wpisać | tak | miniatur bez dowodu |
| C-12 | Wayland/macOS 15+ | z P-* | z P-* | portal/system picker i drugi tester | udostępnić jednego okna, potem całego monitora | wybór odbywa się w systemowym selektorze | kody system-window/system-monitor | wpisać | tak | — |
| C-13 | każda pozycja P-* | z P-* | z P-* | kamera/mikrofon/ekran | wykonać odmowa uprawnienia, potem ponowne nadanie w systemie | odmowa nie uruchamia urządzenia; ponowne nadanie przywraca funkcję | kody deny/regrant | wpisać | zależnie od funkcji | brak prawa zmiany = BLOCKED |
| C-14 | każda pozycja P-* | z P-* | z P-* | aktywna sesja testowa | zasymulować utrata sieci, potem ją przywrócić | stan offline bez wycieku; automatyczne odzyskanie połączenia | czas i kody offline/recovered | wpisać | nie | bez błędnego certyfikatu w produkcji |
| C-15 | każda pozycja P-* | z P-* | z P-* | tray/menu bar dostępny | zamknąć okno, pokazać z tray, potem wybrać jawne „Zakończ CivCom” | close-to-tray działa; jawne zakończenie kończy proces | trzy kody lifecycle | wpisać | nie | jeśli brak tray: oczekiwane jawne zamknięcie |
| C-16 | każda pozycja P-* | z P-* | z P-* | możliwość zmiany autostartu | włączyć autostart, sprawdzić start w tle, potem wyłączyć | oba stany odwracalne; brak innych zmian systemowych | kody enable/start/disable | wpisać | nie | brak uprawnienia = BLOCKED |
| C-17 | każda pozycja P-* | z P-* | z P-* | działająca aplikacja | uruchomić drugi egzemplarz | pojedyncza instancja pozostaje, pierwsze okno zostaje pokazane | liczba procesów/okien bez nazw sesji | wpisać | nie | — |
| C-18 | Windows/macOS/AppImage | z P-* | z P-* | opublikowany podpisany update | sprawdzić aktualizację automatycznie i ręcznie; zaakceptować restart | pobranie, propozycja i restart do nowej wersji | wersje przed/po, kod updatera | wpisać | nie | brak wydania = BLOCKED |
| C-19 | DEB | z P-* | z P-* | aktualny pakiet dostępny | wybrać „Sprawdź aktualizacje” | otwiera stronę aktualnego pakietu; zero apt/dpkg/sudo uruchomionych przez klienta | kod manual-DEB | wpisać | nie | bez automatycznej instalacji |
| C-20 | Windows/macOS/AppImage | z P-* | z P-* | poprzednia podpisana wersja | zainstalować poprzednią podpisaną wersję i zaktualizować | profil i sesja zachowane, finalna wersja podpisana | wersje i kody podpisu | wpisać | nie | brak poprzedniej podpisanej wersji = BLOCKED |
| C-21 | każda pozycja P-* | z P-* | z P-* | testy C-07–C-13 zakończone | zakończyć połączenia i udostępnianie, usunąć/zredagować treści, wylogować zbędne urządzenia | brak aktywnych mediów i zbędnych urządzeń; dane testowe uporządkowane | kody cleanup bez identyfikatorów | wpisać | tak, jeśli uczestniczył | nie dotykać danych innych osób |

## Decyzja wydaniowa

Produkcja może być zaakceptowana dopiero wtedy, gdy wszystkie wymagane wiersze mają `PASS` lub uzasadnione `N/A`, a każdy `BLOCKED` jest jawnie zamknięty przed publikacją. Pilot niepodpisany nie może zastąpić wyników podpisanego instalatora ani testu aktualizacji z poprzedniej podpisanej wersji.

Wyjątek bootstrapowy: wyłącznie dla pierwszego stabilnego wydania `v0.1.0` przypadki `C-18` i `C-20` mogą otrzymać `N/A`, ponieważ nie istnieje wcześniejsza podpisana wersja. Decyzję trzeba jawnie zatwierdzić i zapisać w dowodzie wydania; nie zwalnia ona z pozostałych testów aktualizatora możliwych bez poprzedniej wersji.

Obowiązkowe zamknięcie wyjątku: przed publikacją `v0.1.1` przypadki `C-18` i `C-20` muszą otrzymać `PASS` dla aktualizacji z podpisanego `v0.1.0`. Wyjątku nie wolno przenosić na kolejne wydania.
