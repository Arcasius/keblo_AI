# HIPPOCAMPUS_BOUNDED_CLUSTERING_BC5

## Stato e scope

BC-5 è `VERIFIED`. Il fix aggiunge esclusivamente provenance temporale e un
request contract synthesis vectorless ai cluster BC-4 già verificati. Non
modifica membership, clustering, cluster ID, `SynthesisContract` V1 o runtime.

La coda legacy `automation/fix_queue.json` non contiene BC-5: non è stata
inventata alcuna transizione e il fix non è marcato automaticamente
`completed`.

## Schema temporale realmente osservato

L'ispezione è stata esclusivamente read-only su codice, documenti e fixture
sintetiche. Non sono stati aperti file memoria reali.

- `JsonMemoryStorage` conserva e restituisce oggetti JSON senza migrazione o
  validazione temporale.
- Il flat operativo documentato usa `timestamp` number in millisecondi epoch;
  le fixture coprono valori positivi, `0` e storici negativi.
- Una variante legacy usa `timestamp` come stringa numerica.
- Il nested teorico usa `meta.timestamp` ISO 8601 e presenta anche
  `orbital.birth` ISO.
- `lastAccess` è number nel flat e `orbital.last_access` ISO nel nested.
- `CandidateSelector` trasporta una proiezione `timestamp` senza validarla;
  `ConsolidationPlan` la conserva nelle decisioni senza semantica narrativa.
- Nessun campo strutturato `eventTime` è stato osservato nel flat operativo o
  nelle fixture.

BC-5 accetta come `recordedAt` soltanto il `timestamp` numerico safe-integer di
un source contract esattamente `flat`. Stringhe non vengono parsate. Nested,
hybrid e unknown restano undated con stato
`UNSUPPORTED_SOURCE_CONTRACT`; nessuna precedenza tecnica preesistente viene
promossa ad autorità temporale.

## recordedAt, eventTime e lastAccess

- `recordedAt` descrive il momento di registrazione e conserva esattamente il
  numero epoch millisecondi, incluso zero o valori negativi.
- `eventTime` resta `null/UNKNOWN`; può essere valorizzato solo da una evidenza
  strutturata esplicita V1 con authority
  `EXPLICIT_STRUCTURED_EVENT_TIME`. Non deriva da recordedAt o testo.
- `lastAccess` è accettato nell'input tecnico per rendere verificabile la sua
  esclusione, ma viene ignorato e non entra in output, cronologia o identità.

Campi narrativi sono vietati dalla shape input: un evento menzionato nel testo
non viene analizzato e non può produrre eventTime. Nessun timestamp è corretto,
sostituito o inventato.

## Source cronologiche e undated

Il contratto [HIPPOCAMPUS_TEMPORAL_PROVENANCE_V1.md](contracts/HIPPOCAMPUS_TEMPORAL_PROVENANCE_V1.md)
produce:

- `chronologicalSourceIds`: sole source con recordedAt valido, ordinate per
  timestamp crescente e poi memory ID;
- `undatedSourceIds`: missing, invalid o unsupported, ordinate per memory ID;
- `temporalStart/temporalEnd`: minimo e massimo dei soli recordedAt validi,
  entrambi null senza valori utilizzabili;
- descrittori per source con memory ID, content hash e stati distinti di
  recordedAt/eventTime.

La somma dei due insiemi è completa e disgiunta rispetto alla membership BC-4.
Piano BC-1/BC-4 e snapshot vengono rivalidati; `contentHash` stale, source
duplicate, mancanti o estranee falliscono chiusi. Membership e cluster ID non
cambiano.

## timestampQuality

- `COMPLETE`: tutti validi;
- `PARTIAL_MISSING`: almeno un missing/unsupported, nessun invalid e almeno un
  valido;
- `PARTIAL_INVALID`: almeno un invalid e almeno un valido;
- `UNKNOWN`: nessun recordedAt utilizzabile, con range null.

## Policy “attualmente”

Il request contract contiene una policy esplicita:

- recordedAt non è eventTime;
- lastAccess è escluso;
- il più recente non implica lo stato attuale;
- cambiamenti, contraddizioni e supersessioni devono essere preservati.

`currentStateEvidence` è versionato ma BC-5 lo produce soltanto come
`NOT_PROVIDED`, `currentStateSupported:false` ed evidence references vuote.
Nessuna recency abilita automaticamente la parola “attualmente”.

## Contratto synthesis vectorless

[HippocampusTemporalSynthesisRequest.js](../core/synthesis/HippocampusTemporalSynthesisRequest.js)
costruisce soltanto un request immutabile, senza provider invocation. Contiene
esattamente due sezioni:

1. `RECORDED_AT_CHRONOLOGY`;
2. `UNDATED_SOURCES`.

Ogni reference contiene soltanto memory ID, content hash e provenance
temporale. Il futuro runtime deve rileggere le source autorevoli, verificare
memory ID e content hash e fallire chiuso su mismatch. Non contiene testo,
vettori, embedding, centroidi, payload o user ID.

`SynthesisContract` V1 non è stato modificato e Qwen non è stato chiamato.

## File creati

- `core/clustering/HippocampusTemporalProvenance.js`;
- `core/synthesis/HippocampusTemporalSynthesisRequest.js`;
- `test/clustering/hippocampus-temporal-provenance.test.js`;
- `docs/contracts/HIPPOCAMPUS_TEMPORAL_PROVENANCE_V1.md`;
- `docs/HIPPOCAMPUS_BOUNDED_CLUSTERING_BC5.md`;
- `automation/logs/BC-5.log.md`;
- `automation/logs/BC-5.diff.md`.

File modificato esclusivamente append-only:

- `docs/MEMORIA_ORBITALE_EVOLUTION.md`.

## Test e regressioni

- `node --check` sui moduli e test BC-5: PASS;
- test BC-5 isolati: 19/19 PASS;
- regressioni BC-1→BC-4: 87/87 PASS;
- regressioni EC-1→EC-8 disponibili: 148/148 PASS;
- suite completa serializzata, eseguita una sola volta: 642/642 PASS, zero
  fail, skip o cancellazioni;
- privacy, whitespace, shape chiusa e import runtime vietati: PASS.

Comandi riproducibili principali:

```text
node --check core/clustering/HippocampusTemporalProvenance.js
node --check core/synthesis/HippocampusTemporalSynthesisRequest.js
node --check test/clustering/hippocampus-temporal-provenance.test.js
node --test --test-concurrency=1 test/clustering/hippocampus-temporal-provenance.test.js
node --test --test-concurrency=1 test/clustering/hippocampus-bounded-clustering-plan.test.js test/clustering/hippocampus-candidate-graph-builder.test.js test/clustering/hippocampus-discovery-completeness.test.js test/clustering/hippocampus-bounded-complete-link-refiner.test.js
node --test --test-concurrency=1 test/hippocampus/embedding-cache-record.test.js test/providers/qdrant-embedding-cache-provider.test.js test/hippocampus/embedding-cache-collection-lifecycle.test.js test/hippocampus/embedding-cache-exact-operations.test.js test/hippocampus/bge-m3-embedding-cache-coordinator.test.js test/hippocampus/embedding-cache-neighbor-search.test.js test/hippocampus/embedding-cache-provisioning-scripts.test.js test/providers/bge-m3-embedding-provider.test.js
node --test --test-concurrency=1
```

Non sono stati eseguiti rete reale, Qdrant, BGE-M3, Qwen, storage reale,
daemon, dati reali, provisioning, smoke, SuperMemory, wiring o commit.

## Verdetto unico

`BC5_PASSED`
