# Regole operative per Codex

Questo repository deve essere preparato e modificato con fix controllati, piccoli e verificabili.

## Regole obbligatorie

- Eseguire un solo fix alla volta.
- Applicare patch minime e strettamente legate al fix corrente.
- Evitare refactor massivi, riscritture estese o riorganizzazioni non richieste.
- Non cambiare API contract, payload, nomi di endpoint o formato dati senza autorizzazione esplicita.
- Non cancellare moduli legacy o codice storico senza autorizzazione esplicita.
- Ogni modifica deve produrre log, diff e verifica riproducibile.
- Se il comportamento atteso non e chiaro, fermarsi oppure lasciare un TODO esplicito e circoscritto.

## File vietati salvo autorizzazione

- UI e componenti visuali non direttamente coinvolti dal fix corrente.
- `server.js`
- `package.json`, salvo necessita reale, motivata e documentata nel log del fix.

## Processo

1. Leggere il fix corrente dalla coda.
2. Confermare scope, file ammessi, file vietati e acceptance criteria.
3. Applicare solo la patch minima necessaria.
4. Salvare log e diff del lavoro.
5. Eseguire una verifica coerente con il fix.
6. Aggiornare lo stato del fix solo dopo verifica.

## Ciclo di vita dei fix

Stati ammessi:

- `pending`: il fix e in attesa e non e ancora stato preparato.
- `prepared`: il prompt e stato generato e gli artifact sono pronti.
- `running`: il fix e in esecuzione da parte di Codex.
- `verified`: il fix e stato applicato e ha superato le verifiche.
- `completed`: il fix e stato approvato e chiuso.
- `failed`: il fix ha fallito verifiche o e stato interrotto.

Un fix non puo saltare stati senza una motivazione esplicita nel log del fix.
Ogni transizione deve essere coerente con il ciclo di vita dichiarato nella coda e
non deve marcare automaticamente un fix come `completed`.
