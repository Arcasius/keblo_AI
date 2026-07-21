# HIPPOCAMPUS_ACTIVATION_HACT3

## Stato

- `ACTIVATION_GATE_READY`
- `CONTROL_PLANE_READY`
- `HTTP_MOUNT_DEFERRED_TO_KEBLO_SERVER`
- `STANDALONE_CLI_READY`
- `DEFAULT_MODE_OFF`
- `LIVE_RUNTIME_DISABLED`
- `REAL_SHADOW_RUN_NOT_EXECUTED`

## Implementazione

HACT-3 aggiunge:

- composition root core completamente iniettato;
- export pubblico ristretto e immutabile;
- CLI manuale con parsing chiuso;
- status OFF senza composizione provider;
- preflight SHADOW reale futuro, separato dalla lettura ricordi;
- runner SHADOW bounded costruito sui componenti BC/EC verificati;
- storage autorevole read-only;
- cache embedding come unica write possibile e dichiarata separatamente;
- stop cooperativo SIGINT/SIGTERM;
- output JSON unico e sanitizzato;
- exit code deterministici;
- LIVE sempre disabilitato.

Non sono stati modificati provider, storage autorevole, processing state,
commit transaction, daemon, frontend, backend Keblo o API HTTP.

## File

Creati:

- `core/hippocampus/HippocampusRuntimeComposition.js`;
- `core/hippocampus/index.js`;
- `scripts/hippocampus-run.js`;
- `test/hippocampus/hippocampus-runtime-composition.test.js`;
- `docs/contracts/HIPPOCAMPUS_STANDALONE_RUNTIME_V1.md`;
- `docs/HIPPOCAMPUS_ACTIVATION_HACT3.md`.

Aggiornati append-only:

- `docs/MEMORIA_ORBITALE_EVOLUTION.md`;
- `docs/MEMORIA_ORBITALE_ROADMAP.md`.

## Verifiche

| Verifica | Risultato |
| --- | --- |
| Node disponibile | v18.19.1 |
| `node --check` nuovi file | PASS |
| test HACT-3 isolati | 19/19 PASS |
| regressioni HACT-1/HACT-2 | 35/35 PASS |
| regressioni BC/BC-8/daemon | 176/176 PASS |
| regressioni EC/Qdrant/BGE/Qwen | 180/180 PASS |
| suite completa serializzata, una esecuzione | 730/730 PASS |
| fail / cancelled / skipped / todo | 0 / 0 / 0 / 0 |
| privacy, whitespace, export e import-boundary | PASS |

Tutti i test HACT-3 usano dati sintetici, fake o directory temporanee. Nessuna
preflight reale e nessun ciclo SHADOW reale sono stati eseguiti.

## Confini

- authoritative memory writes: 0;
- processing-state writes: 0;
- commit calls: 0;
- chiamate reali Qdrant/BGE/Qwen: 0;
- cleanup/delete: 0.

## Runtime

Ogni invocazione CLI costruisce una nuova istanza OFF. Il futuro backend Keblo
potrà importare lo stesso `core/hippocampus/index.js` senza duplicare il
wiring. Il mount HTTP HACT-2B resta rinviato al server Keblo.

## Verdetto

`HIPPOCAMPUS_STANDALONE_SHADOW_CLI_READY`
