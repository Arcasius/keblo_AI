# HIPPOCAMPUS_ACTIVATION_HACT7

## Scope e stato

HACT-7 implementa esclusivamente il bounded SuperMemory commit bridge isolato.
La coda legacy `automation/fix_queue.json` termina a `fix-022` e non contiene
HACT-7: non è stata inventata alcuna transizione di stato e il fix non viene
marcato `completed` automaticamente.

File nuovi:

- `core/hippocampus/HippocampusBoundedCommitBridge.js`;
- `test/hippocampus/hippocampus-bounded-commit-bridge.test.js`;
- `docs/contracts/HIPPOCAMPUS_BOUNDED_COMMIT_BRIDGE_V1.md`;
- `docs/HIPPOCAMPUS_ACTIVATION_HACT7.md`.

Aggiornamenti append-only:

- `docs/MEMORIA_ORBITALE_EVOLUTION.md`;
- `docs/MEMORIA_ORBITALE_ROADMAP.md`.

Nessun export aggiuntivo è risultato indispensabile: il modulo dispone di un
path CommonJS stabile diretto. Nessun altro file è stato modificato da HACT-7.

## Ispezione pre-modifica

- `SuperMemoryRecord` V1 crea record core consolidati, valida synthesis e
  cluster, conserva source hash e usa un ID storico deterministico.
- `SynthesisEngine` costruisce request chiuse, valida output/provenance e non è
  invocato dal bridge: HACT-7 riceve un `SynthesisResult` già validato.
- `ConsolidationTransaction` V1 costruisce il piano, rilegge le source sotto
  lock, verifica content hash e optimistic precondition, scrive SuperMemory e
  tutte le transition con un singolo `saveMemories`, verifica post-write e
  gestisce replay/conflitto/rollback circoscritto.
- `JsonMemoryStorage` dichiara read/write-all, atomic commit e user lock
  supported/verified; `AtomicJsonCommit` usa file temporaneo e rename.
- `ProcessingState` V1 definisce soltanto raw, candidate, synthesizing,
  consolidated e failed. Non è stata aggiunta alcuna tassonomia.
- `HippocampusJournal` è append-only JSONL sanitizzato; `RecoveryManager` e il
  daemon riconciliano finestre commit/journal. Il bridge delega questo confine
  al coordinator e non crea journal o recovery paralleli.
- `StorageCapabilityContract` richiede read-all, write-all, atomic commit e
  lock per la transazione esistente.
- `RecallRouter` riconosce SuperMemory core e sopprime source coperte, ma non è
  collegato da HACT-7.
- `HippocampusDaemon` conserva il percorso storico, journal/recovery e bounded
  adapter laterale; non è stato modificato o importato.
- BC-4 produce cluster complete-link bounded canonici; BC-5 aggiunge temporal
  provenance vectorless; BC-8 valida in RAM cluster record, synthesis e
  SuperMemory senza commit.
- `LegacyFlatMemoryShadowProjection` attribuisce `raw` soltanto come stato
  tecnico SHADOW non persistito; il bridge non lo promuove ad autorevole.

## Implementazione

`prepare` è read-only, canonico e deeply frozen. Rivalida i tre artifact,
costruisce transition tramite il contratto processing iniettato, riusa factory
e transaction plan storici e produce identity/fingerprint vectorless. SHADOW
restituisce `COMMIT_NOT_AUTHORIZED_IN_SHADOW` e non raggiunge storage o
capability.

`commit` richiede gate LIVE immutabile, autorizzazioni doppie, capability
server-side e conferma esatta futura. Prima del coordinator rilegge e verifica
tutte le source; dopo la transazione le rilegge di nuovo. Il coordinator fake
dei test invoca la vera `ConsolidationTransaction`, includendo SuperMemory e
tutte le source in un'unica mutazione RAM atomica. Il boundary journal/recovery
è osservato sullo stesso coordinator, senza nuova implementazione.

HACT-7 non rende risolvibile la precondizione legacy reale mancante: la
projection SHADOW non viene scritta. La futura orchestrazione dovrà usare le
primitive claim e journal esistenti prima di presentare transition
`synthesizing→terminal`; nessuna write reale è autorizzata qui.

## Matrice di verifica HACT-7

I test isolati coprono:

1. prepare SHADOW e rifiuto commit zero-write;
2. capability/conferma LIVE;
3. determinismo diretto/inverso e cross-batch;
4. source mancante, modificata e cross-user;
5. processing conflict e synthesis provenance incompatibile;
6. `SuperMemoryRecord` valida;
7. transazione esistente con SuperMemory e tutte le source;
8. atomic failure senza stato parziale e post-verification obbligatoria;
9. replay identico e conflitto no-overwrite;
10. preservazione source e zero delete;
11. reuse coordinator journal/recovery e AbortSignal;
12. receipt/log sanitizzati e import vietati;
13. assenza di daemon/chat/RecallRouter wiring.

## Log operativo e diff riproducibile

Il log del fix è questo documento. Il diff HACT-7 è limitato ai quattro file
nuovi sopra e ai due append documentali. Comandi di verifica:

```text
node --check core/hippocampus/HippocampusBoundedCommitBridge.js
node --check test/hippocampus/hippocampus-bounded-commit-bridge.test.js
node --test --test-concurrency=1 test/hippocampus/hippocampus-bounded-commit-bridge.test.js
node --test --test-concurrency=1 test/consolidation/transactional-consolidation-commit.test.js test/consolidation/processing-state-contract.test.js test/storage/json-atomic-commit.test.js test/storage/storage-capability-contract.test.js test/recall/recall-router-read-only.test.js test/recall/recall-router-integration.test.js
node --test --test-concurrency=1 test/hippocampus/hippocampus-activation-gate.test.js test/hippocampus/legacy-flat-memory-shadow-projection.test.js test/hippocampus/hippocampus-bounded-pipeline-adapter.test.js test/clustering/hippocampus-bounded-clustering-plan.test.js test/clustering/hippocampus-bounded-complete-link-refiner.test.js test/clustering/hippocampus-temporal-provenance.test.js
node --test --test-concurrency=1
```

Nessun test usa rete, provider o dati reali. Non sono stati eseguiti daemon,
chat, CLI LIVE, smoke, Qdrant, BGE, Qwen, cleanup, delete o commit Git.

## Verdetto

Risultati conclusivi:

- HACT-7 isolato: 11/11 PASS;
- commit/storage/processing/RecallRouter: 123/123 PASS;
- HACT/BC/synthesis/daemon/journal/recovery pertinenti: 248/248 PASS;
- suite completa serializzata, eseguita una volta: 773/773 PASS;
- fail, cancelled, skipped e todo: 0;
- node check, privacy, whitespace, import e diff check: PASS;
- rete, dati reali, write reali e commit reali: 0.

`HIPPOCAMPUS_BOUNDED_COMMIT_BRIDGE_READY_NO_REAL_COMMIT`
