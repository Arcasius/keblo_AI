# HIPPOCAMPUS_BOUNDED_CLUSTERING_BC4

## Stato e scope

BC-4 è `VERIFIED`. Il fix implementa esclusivamente refinement bounded delle
componenti BC-3 `AUTHORIZED_FOR_REFINEMENT`. Non esegue tempo BC-5, synthesis,
SuperMemory, daemon, storage, wiring, provisioning, smoke o commit.

La coda `automation/fix_queue.json` termina a `fix-022` e non contiene una voce
BC-4: non è stata quindi inventata alcuna transizione nella queue e il fix non
è stato marcato automaticamente `completed`.

## File creati

- `core/clustering/HippocampusBoundedCompleteLinkRefiner.js`;
- `test/clustering/hippocampus-bounded-complete-link-refiner.test.js`;
- `docs/contracts/HIPPOCAMPUS_BOUNDED_COMPLETE_LINK_REFINEMENT_V1.md`;
- `docs/HIPPOCAMPUS_BOUNDED_CLUSTERING_BC4.md`;
- `automation/logs/BC-4.log.md`;
- `automation/logs/BC-4.diff.md`.

## File modificati

- `core/clustering/HippocampusBoundedClusteringPlan.js`: export del comparatore
  canonico e del validator policy/budget; `maximumComponentSize` rappresenta
  ora la componente candidata sorgente, bounded tra massima disposition e
  identity count, per supportare più gruppi disgiunti nella stessa componente;
- `docs/contracts/HIPPOCAMPUS_BOUNDED_CLUSTERING_PLAN_V1.md`: chiarimento della
  sola semantica della metrica precedente;
- `docs/MEMORIA_ORBITALE_EVOLUTION.md`: append-only BC-4.

Nessun file vietato o modulo runtime è stato modificato.

## Algoritmo greedy preservato

Il refiner importa policy, algoritmo, reason code, comparator e builder del
piano BC-1. `complete-link-greedy-v1` resta invariato: seed primo non assegnato,
candidati canonici, ammissione soltanto se ogni cosine è `>= 0.70`,
short-circuit dopo il primo confronto sotto soglia, nessuna riassegnazione e
`minClusterSize=3`. Non esistono limite implicito di cinque, gerarchia o
truncation.

Il chain test A-B >= 0.70, B-C >= 0.70 e A-C < 0.70 dimostra che `{A,B,C}` non
viene prodotto.

## Vettori massimi simultanei

Le componenti autorizzate sono ordinate per point ID minimo. Il resolver viene
chiamato sequenzialmente nell'ordine canonico; non esiste `Promise.all`. È
mantenuta una sola `Map` di componente con massimo `memberCount` vettori e
comunque non oltre `maxComponentVectorsInMemory`. La `Map` viene svuotata e il
riferimento azzerato in `finally` prima della componente successiva.

I test osservano massimo resolver concurrency 1, massimo 3 vettori per due
componenti da 3 e ordine canonico completo. Una componente oltre vector budget
produce `DEFERRED_DENSE_COMPONENT` con zero retrieve.

## Budget e deferred

- vector bound: `DEFERRED_DENSE_COMPONENT`, controllo pre-retrieve;
- pairwise: ogni cosine reale è contata e il confronto successivo oltre budget
  produce `DEFERRED_PAIRWISE_BUDGET` per l'intera componente, senza risultati
  parziali;
- cluster size: `DEFERRED_OVERSIZED_CLUSTER` sul gruppo integrale, mai
  troncato;
- timeout totale: `DEFERRED_TIMEOUT` con abort del resolver cooperativo;
- RSS: reader iniettato e deterministico, con
  `DEFERRED_RSS_BUDGET` oltre delta;
- caller abort: errore sanitizzato fail-closed, senza piano parziale;
- componente uncertified: `DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY` e zero
  retrieve.

Stale identity, content hash, point ID, modello, revisione, cache schema o
snapshot fingerprint incompatibili falliscono chiusi. Sono rifiutati shape
inattese, dimensione diversa da 1024, NaN/Infinity, zero vector e vettori non
normalizzati.

## minimumPairSimilarity

Il greedy non conserva una matrice O(m²). Per ogni cluster eleggibile tutte le
coppie vengono ricalcolate con cosine completa; ogni ricalcolo rientra nel
budget e il minimo reale viene scritto in `minimumPairSimilarity`. Il test
dedicato osserva minimo 0.75 e 6 confronti totali per un cluster di tre; il test
di soglia verifica inclusione esatta di 0.70.

## Determinismo e cross-batch

Snapshot diretto/inverso, edge direction equivalente e latenze async diverse
producono lo stesso `planId`, cluster ID, membership e minimo. Le metriche non
partecipano al cluster ID. Etichette sintetiche di batch 1 e 50 non entrano
nell'API o nell'output e il cluster cross-batch resta identico.

L'output viene costruito tramite BC-1, è profondamente immutabile, vectorless e
con coverage completa/disgiunta. I campi temporali usano soltanto
`NOT_EVALUATED`, source unresolved canoniche e range null.

## Test e regressioni

- `node --check` sui file JavaScript BC-4 e BC-1 modificato: PASS;
- test BC-4 isolati: 22/22 PASS;
- regressioni BC-1/BC-2/BC-3: 65/65 PASS;
- regressioni EC-1–EC-8 disponibili: 148/148 PASS;
- suite completa serializzata, eseguita una sola volta: 623/623 PASS, zero
  fail, skip o cancellazioni;
- privacy, whitespace, shape chiusa e import runtime vietati: PASS.

Tutte le verifiche BC-4 hanno usato provider fake, clock/RSS reader iniettati e
dipendenze locali. Non sono stati usati rete reale, Qdrant, BGE-M3, Qwen,
storage, daemon, dati reali, provisioning, smoke, SuperMemory, wiring o commit.

Comandi riproducibili principali:

```text
node --check core/clustering/HippocampusBoundedClusteringPlan.js
node --check core/clustering/HippocampusBoundedCompleteLinkRefiner.js
node --check test/clustering/hippocampus-bounded-complete-link-refiner.test.js
node --test --test-concurrency=1 test/clustering/hippocampus-bounded-complete-link-refiner.test.js
node --test --test-concurrency=1 test/clustering/hippocampus-bounded-clustering-plan.test.js test/clustering/hippocampus-candidate-graph-builder.test.js test/clustering/hippocampus-discovery-completeness.test.js
node --test --test-concurrency=1 test/hippocampus/embedding-cache-record.test.js test/providers/qdrant-embedding-cache-provider.test.js test/hippocampus/embedding-cache-collection-lifecycle.test.js test/hippocampus/embedding-cache-exact-operations.test.js test/hippocampus/bge-m3-embedding-cache-coordinator.test.js test/hippocampus/embedding-cache-neighbor-search.test.js test/hippocampus/embedding-cache-provisioning-scripts.test.js test/providers/bge-m3-embedding-provider.test.js
node --test --test-concurrency=1
```

## Verdetto unico

`BC4_PASSED`
