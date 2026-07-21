# HACT-3B — Real standalone composition and diagnostic preflight

## Stato

- `HACT3_CLI_CONTRACT_VERIFIED`;
- `HACT3_REAL_COMPOSITION_PREVIOUSLY_NOT_WIRED=false`;
- `HACT3_REAL_COMPOSITION_FIXED`;
- `HIPPOCAMPUS_REAL_SHADOW_PREFLIGHT_BLOCKED_CONFIGURATION`;
- `REAL_SHADOW_RUN_NOT_EXECUTED`;
- `LIVE_RUNTIME_DISABLED`.

## Diagnosi HACT-3

Il CLI iniettava già `createRealPreflightEvaluator`. Per `--run-once` iniettava
anche `createRealShadowRunner`; per `--preflight-only` il runner non veniva
costruito né invocato. Il runner reale era già composto con storage autorevole
read-only, cache embedding dedicata, exact discovery Qdrant, bounded clustering
BC-1→BC-6, provenance temporale BC-5, provider Qwen/Ollama e SuperMemory
temporanea in RAM, senza capability commit.

Il fallimento in pochi millisecondi nasceva da `runtimeEnvironment.complete ===
false`: l'evaluator restituiva immediatamente un preflight HACT-1 tutto-false,
senza rete, mentre il composition root riduceva la causa al solo `FAIL`. Non
era quindi una preflight reale completata, né un placeholder runner: era il
ramo fail-closed non diagnostico della configurazione incompleta.

## Correzione

Il composition root accetta ora, oltre al report HACT-1 invariato, un envelope
diagnostico chiuso. Il report pubblico espone soltanto reason code, stati dei
componenti, nomi delle configurazioni mancanti e contatori zero. Endpoint,
hostname, chiavi, path storage, user ID, testi, vettori, point ID, payload,
output Qwen, errori raw e stack non sono serializzati.

La preflight reale è sequenziale e fail-fast:

1. validazione locale della configurazione;
2. apertura read-only della directory storage senza enumerare ricordi;
3. health Qdrant;
4. ispezione della collection dedicata con `allowCreate:false`;
5. health e provenance BGE-M3 esatte;
6. tags Ollama e mini-inference JSON tramite `OllamaSynthesisProvider`.

La configurazione usa soltanto nomi già presenti nel repository:

- `HIPPOCAMPUS_EMBEDDING_URL`;
- `HIPPOCAMPUS_EMBEDDING_API_KEY`;
- `HIPPOCAMPUS_QDRANT_URL`;
- `HIPPOCAMPUS_QDRANT_API_KEY`, opzionale per endpoint privato verificato;
- `HIPPOCAMPUS_MEMORY_DATA_DIR`;
- `HIPPOCAMPUS_QWEN_TIMEOUT_MS`;
- `PRIMARY_OLLAMA_URL`;
- `PRIMARY_MODEL`.

Modello, revisione, dimensione e normalizzazione BGE, nonché la collection
embedding, restano i valori autorevoli dei provider e record EC esistenti. Non
sono stati inventati nuovi nomi environment. `.env` non è stata modificata.

## Unica preflight reale autorizzata

È stato eseguito una sola volta il comando `--preflight-only`. È terminato
localmente con exit code 3, `CONFIGURATION_INCOMPLETE`, durata 11 ms, tutti i
check di rete `NOT_RUN` e tutti i contatori di lettura/scrittura/commit a zero.

Quella esecuzione ha anche evidenziato che il primo parser HACT-3B trattava
erroneamente l'oggetto speciale `process.env` come plain object e riportava
tutti i nomi come mancanti. Il parser è stato corretto e verificato localmente,
senza una seconda preflight. La proiezione post-fix individua soltanto:

- `HIPPOCAMPUS_MEMORY_DATA_DIR`;
- `HIPPOCAMPUS_QWEN_TIMEOUT_MS`;
- `PRIMARY_MODEL`;
- `PRIMARY_OLLAMA_URL`.

Poiché la configurazione è incompleta, non sono state effettuate chiamate a
Qdrant, BGE-M3 o Qwen. Non è stata eseguita alcuna SHADOW run sui ricordi.

## Verifiche

- HACT-3B post-fix: 12/12 PASS;
- HACT-3 + HACT-3B prima dell'ultima correzione locale: 30/30 PASS;
- regressioni mirate HACT-1→3, BC/EC/provider e smoke BC-8: 367/367 PASS;
- suite completa serializzata, eseguita una sola volta: 741/741 PASS;
- syntax, import, privacy e whitespace: PASS;
- commit Git: non eseguito.

## Verdetto

`HIPPOCAMPUS_REAL_SHADOW_PREFLIGHT_BLOCKED_CONFIGURATION`
