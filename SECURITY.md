# Polityka bezpieczeństwa

## Wspierane wersje

Poprawki bezpieczeństwa są przygotowywane dla najnowszego stabilnego wydania CivCom Desktop. Niepodpisane artefakty pilotażowe nie są wydaniami produkcyjnymi.

## Prywatne zgłoszenie podatności

Podatności zgłaszaj przez funkcję **Report a vulnerability** w zakładce **Security** repozytorium. Przed publikacją repozytorium administrator musi włączyć GitHub Private Vulnerability Reporting.

Nie zgłaszaj podatności w publicznym Issue. Nie dołączaj danych logowania, tokenów, identyfikatorów lub nazw pokoi, treści wiadomości, plików służbowych, zrzutów zalogowanej sesji ani pełnych adresów zawierających fragment pokoju.

Zgłoszenie powinno zawierać wersję CivCom Desktop, system i architekturę, minimalne kroki odtworzenia oraz ocenę wpływu. Jeśli dowód wymaga danych wrażliwych, najpierw opisz problem bez ich przekazywania i poczekaj na uzgodnienie bezpiecznego kanału.

## Zakres

W zakresie są kod klienta, instalatory, proces aktualizacji, konfiguracja Electron, granice nawigacji i uprawnień oraz pipeline wydawniczy. Sama usługa `civcom.soia.info` i serwer Matrix mogą wymagać odrębnej ścieżki obsługi; zgłoszenie dotyczące klienta nie upoważnia do testowania kont, pokoi ani infrastruktury innych użytkowników.
