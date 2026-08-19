# Współtworzenie CivCom Desktop

## Zasady podstawowe

- Używaj Node.js 24 LTS i zależności z `package-lock.json` poprzez `npm ci`.
- Nie commituj `.cred.env`, danych logowania, tokenów, tras pokoi ani treści komunikacji.
- Automaty nie mogą logować się do produkcyjnego CivCom ani tworzyć wiadomości, pokoi, plików lub połączeń.
- Zmiany uprawnień, nawigacji, protokołów lokalnych, aktualizatora, podpisów i workflowów wymagają testu negatywnego oraz podejścia fail-closed.
- Nie dodawaj Node.js, IPC, preloada ani `window.electron` do głównego renderera CivCom.

## Przygotowanie zmiany

```sh
npm ci
npm run verify
npm run test:electron:local
git diff --check
```

Pull request powinien opisywać zakres, ryzyko, wykonane testy i platformy, których nie dało się sprawdzić. Wynik cross-buildu nie zastępuje testu na natywnym systemie. Zmiana paczkowania musi zostać zweryfikowana przez `npm run package:verify -- --mode pilot --target <windows|macos|linux>` na odpowiednim systemie.

## Testy produkcyjne

Anonimowy smoke test działa tylko w dedykowanym workflow po merge do `main` i przed wydaniem. Zalogowane funkcje sprawdza człowiek zgodnie z `docs/testing/manual-acceptance-matrix.md`. Dane z `.cred.env` nie trafiają do GitHub Secrets ani CI.

## Wydania

Pilot pozostaje niepodpisanym, krótkotrwałym artefaktem workflow. Publiczne wydanie wymaga podpisu Authenticode, podpisu i notaryzacji macOS, natywnych bramek paczek, zatwierdzonej macierzy odbioru oraz chronionego tagu osiągalnego z `origin/main`.
