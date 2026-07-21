# HIPPOCAMPUS_CONTROL_PLANE_HACT2

## Stato

- `ACTIVATION_GATE_READY`
- `CONTROL_PLANE_READY`
- `DEFAULT_MODE_OFF`
- `REAL_RUNNER_NOT_WIRED`
- `REAL_RUNTIME_DISABLED`

## Implementazione

HACT-2 aggiunge:

- controller applicativo volatile `OFF | SHADOW | LIVE`;
- lifecycle chiuso da `IDLE` a `SUCCEEDED | FAILED | ABORTED`;
- snapshot HACT-1 immutabile per ogni run;
- preflight HACT-1 iniettato e fail-closed;
- un solo runner concorrente;
- interruzione cooperativa con `AbortSignal`;
- risultato ristretto a reason code e contatori sanitizzati;
- dispatcher HTTP chiuso per status, mode, run e stop.

Il runner e il preflight usati dai test sono fake. Le capability LIVE restano
server-side e non vengono mai serializzate, accettate dal client o passate al
runner. HACT-2 non esegue commit.

## Scope e diff

File creati:

- `core/hippocampus/HippocampusActivationController.js`;
- `core/hippocampus/HippocampusControlPlaneHttpRouter.js`;
- `test/hippocampus/hippocampus-activation-control-plane.test.js`;
- `docs/contracts/HIPPOCAMPUS_CONTROL_PLANE_V1.md`;
- `docs/HIPPOCAMPUS_CONTROL_PLANE_HACT2.md`.

File aggiornati append-only:

- `docs/MEMORIA_ORBITALE_EVOLUTION.md`;
- `docs/MEMORIA_ORBITALE_ROADMAP.md`.

Non sono stati modificati entrypoint HTTP, frontend, daemon, scheduler,
provider, storage, processing state, commit transaction o configurazione
environment.

## Mount HTTP

Il dispatcher implementa e verifica i quattro endpoint richiesti, ma non è
montato nell'entrypoint corrente.

L'ispezione ha trovato un solo entrypoint HTTP:
`apps/orbitale-cockpilot/server.ts`. È il server auto-avviante dell'app
frontend, non espone autenticazione o user context riutilizzabili e modificarlo
è fuori dallo scope esplicito HACT-2. Un mount in quel file allargherebbe il
FIX al frontend e renderebbe raggiungibile il control plane senza un confine
autorizzativo verificato. Non è stato creato un server parallelo.

Il blocker residuo è quindi circoscritto: serve un composition root backend
autorizzato, separato dal frontend, che inietti controller, autorizzazione,
preflight e runner e monti il dispatcher. Il runner reale resta comunque fuori
scope e disabilitato.

## Verifiche

| Verifica | Risultato |
| --- | --- |
| `node --check` nuovi file | PASS |
| test HACT-2 isolati | 16/16 PASS |
| regressione HACT-1 | 19/19 PASS |
| regressioni BC/BC-8/daemon rilevanti | 176/176 PASS |
| regressioni EC/Qdrant rilevanti | 162/162 PASS |
| suite completa serializzata, una esecuzione | 711/711 PASS |
| fail / cancelled / skipped / todo | 0 / 0 / 0 / 0 |
| privacy, whitespace e import check | PASS |

Tutte le prove HACT-2 sono locali e fake. Sono rimasti a zero:

- rete e provider reali;
- letture e scritture storage;
- accessi a ricordi o processing state;
- commit;
- cleanup e delete.

## Runtime

Ogni nuova istanza parte `OFF / IDLE`. Nessuna selezione avvia un run. Nessun
runner reale è collegato e il runtime Ippocampo reale resta disabilitato.

## Verdetto

`HIPPOCAMPUS_CONTROL_PLANE_BLOCKED_HTTP_MOUNT`
