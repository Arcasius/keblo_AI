# HIPPOCAMPUS_ACTIVATION_HACT8

## Scope

HACT-8 aggiunge esclusivamente un composition root background per Ippocampo e
verifica il confine storage/RecallRouter già usato dalla chat. Non modifica
chat, ranking, storage, processing state, daemon storico, HACT-7 o provider.

File creati:

- `scripts/hippocampus-daemon.js`;
- `test/hippocampus/hippocampus-background-daemon.test.js`;
- `docs/HIPPOCAMPUS_ACTIVATION_HACT8.md`.

Aggiornamenti append-only:

- `docs/MEMORIA_ORBITALE_EVOLUTION.md`;
- `docs/MEMORIA_ORBITALE_ROADMAP.md`.

`package.json` non è stato modificato: il file con shebang è il comando
dedicato stabile ed è invocabile direttamente con Node. Nessun frontend, API
HTTP o altro progetto è coinvolto.

## Ispezione e riuso

Il runtime standalone esistente garantisce già gate OFF/SHADOW, preflight,
bounded pipeline reale, metriche chiuse, AbortSignal e write boundary SHADOW a
zero. `HippocampusDaemon` storico possiede un scheduler dry-run e una guard,
ma appartiene al percorso di consolidamento legacy e non è il composition root
bounded standalone verificato da HACT-6/7. HACT-8 riusa quindi
`createDefaultRuntime()` di `scripts/hippocampus-run.js` senza duplicare
clustering, provider o synthesis.

La chat costruisce già:

```text
JsonMemoryStorage(dataDir)
→ KebloMemory.recallReadOnly
→ LegacyRecallAdapter
→ RecallRouter
```

`RecallRouter` classifica una `SuperMemory` con `memoryKind:super_memory` e
`storageTier:core` nel tier core, mentre le raw/episodiche restano warm o deep
secondo il contratto esistente. Non è necessario un adapter HACT-8 e nessuna
semantica di ranking è stata alterata.

## Comando background

Default e status:

```text
node scripts/hippocampus-daemon.js
node scripts/hippocampus-daemon.js --status
```

Entrambi producono OFF e terminano senza costruire supervisor/runtime,
inizializzare provider, leggere storage, registrare signal handler o effettuare
rete.

SHADOW run-once richiede tutti i limiti e la conferma esatta:

```text
node scripts/hippocampus-daemon.js \
  --mode SHADOW \
  --confirm RUN_HIPPOCAMPUS_SHADOW_V1 \
  --user-id <scope-tecnico> \
  --max-candidates <limite-esplicito> \
  --run-once
```

Modalità intervallo:

```text
node scripts/hippocampus-daemon.js \
  --mode SHADOW \
  --confirm RUN_HIPPOCAMPUS_SHADOW_V1 \
  --user-id <scope-tecnico> \
  --max-candidates <limite-esplicito> \
  --interval-ms <intervallo-esplicito>
```

Non esiste intervallo di default. Un ciclo viene eseguito subito e il
successivo viene pianificato soltanto dopo la conclusione del precedente; il
timer one-shot impedisce sovrapposizioni anche quando un ciclo dura più
dell'intervallo. La guard esplicita rifiuta inoltre invocazioni concorrenti.

HACT-8 non ha eseguito questi comandi con runtime reale.

## Sicurezza e lifecycle

- LIVE viene rifiutato dal parser prima di creare il supervisor.
- Non viene creato, accettato o simulato alcun token/capability LIVE.
- SHADOW usa il runtime esistente con `authoritativeMemoryWrites=0`,
  `processingStateWrites=0`, `commitCalls=0` e `realDataModified=false`.
- Il comando non importa HACT-7: il commit bridge non è invocabile in SHADOW.
- SIGINT e SIGTERM richiedono `runtime.stop()`, attendono il ciclo cooperativo e
  rimuovono i listener prima dell'uscita.
- Un ciclo fallito incrementa metriche sanitizzate e lascia attivo il
  supervisore interval; non esistono retry immediati o fallback nascosti.
- Stato ed errori contengono soltanto reason code allowlisted e contatori; non
  includono testi, source ID, user ID, vettori, payload, endpoint, path, stack o
  segreti.

## Storage condiviso e indipendenza della chat

Il processo Ippocampo e la chat devono essere configurati sul medesimo data
directory autorevole e sul medesimo scope tecnico. Per la chat corrente il
directory è `./orbitale_chat_data`; il runtime standalone richiede il path
assoluto equivalente in `HIPPOCAMPUS_MEMORY_DATA_DIR`. HACT-8 documenta il
vincolo ma non modifica `.env` né avvia i processi.

Una futura SuperMemory committata atomicamente da HACT-7 nello stesso memory
map è quindi visibile al RecallRouter al ciclo di recall successivo. Se non
esiste alcuna SuperMemory, il router continua a restituire le raw secondo il
comportamento corrente. La chat non importa il daemon, non ne controlla lo
stato e non attende il suo startup: assenza, stop o failure del processo
background non interrompono chat o recall.

## Test fake

I test HACT-8 usano esclusivamente runtime, scheduler, clock implicito,
provider e storage in-memory/fake. Coprono:

1. OFF lazy e zero side effect;
2. SHADOW run-once zero commit;
3. LIVE sempre rifiutato e conferma SHADOW esatta;
4. guard anti-overlap;
5. intervallo esplicito e deterministico;
6. SIGINT e SIGTERM cooperativi;
7. failure isolata dal supervisore;
8. metriche/errori sanitizzati;
9. HACT-7 non importato né invocato;
10. SuperMemory fake persistita recuperata nel core tier;
11. raw memory recuperata distintamente nel warm tier;
12. recall invariato con daemon assente/fallito;
13. zero provider initialization in OFF;
14. nessuna implementazione network/write nel nuovo command.

## Verifica riproducibile

```text
node --check scripts/hippocampus-daemon.js
node --check test/hippocampus/hippocampus-background-daemon.test.js
node --test --test-concurrency=1 test/hippocampus/hippocampus-background-daemon.test.js
node --test --test-concurrency=1 test/hippocampus/hippocampus-runtime-composition.test.js test/hippocampus/hippocampus-daemon-single-process.test.js test/recall/recall-router-read-only.test.js test/recall/recall-router-integration.test.js test/hippocampus/hippocampus-bounded-commit-bridge.test.js
node --test --test-concurrency=1
```

Risultati conclusivi:

- HACT-8 isolato: 10/10 PASS;
- runtime/daemon/RecallRouter/HACT-7/BC-8: 114/114 PASS;
- suite completa serializzata, eseguita una volta: 783/783 PASS;
- fail, cancelled, skipped e todo: 0;
- node check, privacy, whitespace, import e diff check: PASS;
- rete, storage reale, processing write e commit reali: 0.

`HIPPOCAMPUS_DAEMON_CHAT_INTEGRATION_READY_DEFAULT_OFF`
