# HIPPOCAMPUS_CONTROL_PLANE_V1

## Scopo

HACT-2 definisce un control plane backend volatile per il gate HACT-1. Il
controller non è un runner Ippocampo, non compone provider e non possiede una
capability commit. Ogni nuova istanza parte in `OFF / IDLE`.

Stato architetturale:

- `ACTIVATION_GATE_READY`;
- `CONTROL_PLANE_READY`;
- `DEFAULT_MODE_OFF`;
- `REAL_RUNNER_NOT_WIRED`;
- `REAL_RUNTIME_DISABLED`.

## Controller applicativo

```js
createHippocampusActivationController({
  createGate,
  evaluatePreflight,
  runner,
  commitCapability,
  storageCapability,
  now,
  createAbortController
})
```

Tutte le dipendenze sono iniettate. Il modulo non legge `process.env`.
`commitCapability` e `storageCapability` servono esclusivamente a ricreare la
decisione HACT-1 server-side. Non vengono passate al runner.

L'API applicativa è:

- `getStatus()`;
- `setMode(request)`;
- `runOnce(request)`;
- `stop(request)`.

`setMode` accetta soltanto `mode` e l'eventuale `liveConfirmation`.
`runOnce` e `stop` accettano esclusivamente un oggetto vuoto.

## Stato volatile

Gli stati ammessi sono:

- `IDLE`;
- `PREFLIGHT`;
- `RUNNING`;
- `STOPPING`;
- `SUCCEEDED`;
- `FAILED`;
- `ABORTED`.

Lo status pubblico è chiuso e profondamente immutabile:

```js
{
  mode,
  lifecycleState,
  runId,
  runStartedAt,
  runFinishedAt,
  stopRequested,
  lastResult
}
```

`lastResult` può contenere soltanto `status`, `reasonCode` e i contatori
interi non negativi `clusterCount`, `deferredComponentCount` e
`simulatedSuperMemoryCount`. Il risultato completo del runner non viene
conservato.

## Modalità e run

OFF rifiuta `runOnce`. SHADOW richiede una selezione esplicita e non autorizza
commit. LIVE viene accettato soltanto se il gate HACT-1 autorizza token,
capability commit e attestazione storage iniettati server-side.

La selezione della modalità non esegue preflight e non avvia un ciclo. Ogni
run ricrea uno snapshot immutabile del gate, valuta un report preflight HACT-1
valido e invoca il runner fake/iniettato una sola volta con:

```js
{
  gateSnapshot,
  preflightSnapshot,
  signal
}
```

Il runner non riceve capability commit o storage. Non esistono retry,
fallback o promozioni di modalità. Un runner assente produce
`RUNNER_UNAVAILABLE`.

È ammesso un solo run attivo per controller. `stop` invoca `abort()` una sola
volta, passa a `STOPPING` e termina soltanto dopo l'uscita cooperativa del
runner. Solo allora lo stato finale diventa `ABORTED`.

## Reason code applicativi

- `ACTIVATION_OFF`;
- `MODE_UPDATED`;
- `MODE_CHANGE_REJECTED_RUN_ACTIVE`;
- `PREFLIGHT_NOT_READY`;
- `RUNNER_UNAVAILABLE`;
- `RUN_ALREADY_ACTIVE`;
- `RUN_STARTED`;
- `RUN_SUCCEEDED`;
- `RUN_FAILED`;
- `STOP_REQUESTED`;
- `NO_ACTIVE_RUN`;
- `RUN_ABORTED`;
- `INVALID_REQUEST`;
- `LIVE_NOT_AUTHORIZED`.

Gli errori di validazione sono tipizzati, non retryable e sanitizzati.

## Contratto HTTP

`HippocampusControlPlaneHttpRouter` è un dispatcher HTTP framework-neutral:

- `GET /api/hippocampus/status`;
- `POST /api/hippocampus/mode`;
- `POST /api/hippocampus/run`;
- `POST /api/hippocampus/stop`.

Richiede un'autorizzazione server-side iniettata. I POST richiedono
`application/json`, applicano il limite di 100 KiB coerente con il default
Express dell'entrypoint esistente e rifiutano proprietà sconosciute. Le
risposte sono JSON chiuse; metodi, path, body, content type e autorizzazione
invalidi falliscono deterministicamente.

Il dispatcher non è montato nell'entrypoint attuale. L'unico server HTTP
rinvenuto è `apps/orbitale-cockpilot/server.ts`: appartiene all'app frontend,
si auto-avvia e non espone un contesto di autenticazione/autorizzazione
riutilizzabile. Montare qui il control plane violerebbe lo scope HACT-2 che
vieta modifiche frontend e introdurrebbe un endpoint operativo senza un
confine autorizzativo verificato. Non è stato creato un server parallelo.

## Privacy e side effect

Controller e dispatcher:

- non importano frontend, daemon, runner BC-8 o provider;
- non usano rete, filesystem o environment;
- non leggono ricordi o processing state;
- non eseguono storage read/write, commit, cleanup o delete;
- non espongono testo, vettori, payload, endpoint, API key, user ID,
  capability, stack trace o errori raw.

HACT-2 è verificato esclusivamente con gate, preflight, runner,
autorizzazione e clock fake.
