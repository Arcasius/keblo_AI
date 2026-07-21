# HIPPOCAMPUS_BOUNDED_CLUSTERING_BC7_AUDIT

## Stato e perimetro

Data audit: 2026-07-16, Europe/Rome.

BC-7 ha riesaminato in modo indipendente BC-1→BC-6 tramite lettura diretta di
codice, contratti, report, log, diff manifest, test e harness. L'audit è stato
read-only sul codice. L'unica modifica prodotta è questo report.

La coda legacy `automation/fix_queue.json` termina a `fix-022` e non contiene
BC-7. Non è stata inventata alcuna transizione e nessun fix è stato marcato
automaticamente `completed`. L'Evolution Log non è stato modificato perché
l'autorizzazione di scrittura era limitata esclusivamente alla creazione di
questo report.

Non sono stati usati rete, dati reali, Qdrant reale, BGE-M3, Qwen, storage,
daemon, provisioning, SuperMemory, wiring o commit. Non sono stati modificati
runtime, provider, contract, test o artifact BC-1→BC-6.

## Sintesi severity

| Classe | Attivi | Rischi futuri | Gate di wiring | Esito |
| --- | ---: | ---: | ---: | --- |
| P0 | 0 | 0 | 0 | nessuna perdita, corruzione o esposizione critica osservata |
| P1 | 0 | 0 | 1 | il wiring reale non può essere autorizzato senza discovery certificabile |
| P2 | 0 | 1 | 1 | il futuro provider esatto deve avere un envelope di risposta realmente bounded |
| P3 | 0 | 2 | 0 | limiti di evidenza/telemetria non bloccanti per il dry-run sintetico |

Non sono stati trovati difetti attivi P0/P1/P2 nella pipeline isolata
BC-1→BC-6 verificata con provider sintetici conformi. I blocker riguardano il
wiring reale, non vengono risolti cambiando la semantica e non autorizzano
alcuna promozione di Qdrant a fonte autorevole.

## Finding

### BC7-GATE-P1-001 — Provider reale non certificabile

**Classe:** P1, gate di wiring reale.

L'attuale percorso Qdrant espone `searchPoints` e `searchNeighbors` top-k:

- `searchNeighbors` richiede un `limit`, applica overfetch 4× con massimo
  provider 4.000 e restituisce soltanto `queryPointId`, `neighbors`,
  `discardedStaleCount` e `truncated`;
- `searchPoints` invia a Qdrant `limit` e `score_threshold` e restituisce un
  array di point, senza continuation o prova di exhaustion;
- nessuno dei due espone `discoverNeighbors`, snapshot fingerprint, conteggio
  dell'universo eleggibile o certificato
  `EXACT_ABOVE_THRESHOLD_ENUMERATION_V1`;
- `truncated:false`, un result count inferiore al limit e l'assenza di
  continuation non costituiscono certificazione BC-3.

Di conseguenza l'attuale provider reale non può emettere onestamente il
certificato richiesto. Un adapter che convertisse `truncated:false` in
`COMPLETE_ABOVE_THRESHOLD` violerebbe il contratto e verrebbe comunque
degradato a `INCOMPLETE_UNCERTIFIED` in assenza del certificato completo.

Questo gate blocca il wiring Qdrant reale ma non il dry-run sintetico con fake
provider che controlla integralmente il dataset.

### BC7-GATE-P2-002 — Bound della risposta del futuro provider esatto

**Classe:** P2, rischio futuro e gate di wiring.

Il candidate graph limita numero di query, edge conservati e tempo totale, ma
normalizza e ordina l'intero array `hits` restituito da una singola chiamata
prima di applicare `maxCandidateEdges`. L'interfaccia `discoverNeighbors` non
riceve oggi un limite massimo di hit e non valida una dimensione massima della
risposta.

Nel benchmark BC-6 il fake provider ha grado bounded e il requisito è
soddisfatto. Per un futuro provider esatto, specialmente su un vicinato denso,
la memoria transiente e il costo di ordinamento dipenderebbero invece dal
numero di hit consegnati dal provider. Prima del wiring reale servirà quindi
una prova contrattuale di enumerazione bounded/paginata o un envelope
equivalente che preservi la completezza sopra soglia. Non è ammesso risolvere
il gate con top-k, truncation silenziosa o modifica della semantica.

### BC7-RISK-P3-003 — Contatori di preparazione diagnostici

**Classe:** P3, osservabilità.

I contatori `globalOrderingCount` e
`globalFingerprintCalculationCount` vengono inizializzati a uno dal contesto
preparato; non sono hook strumentali dentro le primitive di sort/hash. La
lettura del call graph conferma comunque che il builder chiama
`prepareThresholdDiscoveryContext` una sola volta prima del loop e che le
query usano lookup nelle Map private. Il limite riguarda la forza della
telemetria, non la correttezza osservata.

### BC7-RISK-P3-004 — Artifact benchmark non machine-readable separato

**Classe:** P3, tracciabilità.

Il run pesante BC-6 è documentato nel report e nel log, ma non è presente un
artifact JSON separato con tutti i digest e i sample del run 100/1k/10k/40k.
Harness, formule, conteggi e valori riportati sono coerenti e i test ridotti
sono riproducibili; la mancanza limita soltanto una futura verifica bit-per-bit
del run storico. Il benchmark 40k non è stato rilanciato.

## Controlli obbligatori

| # | Controllo | Esito | Evidenza |
| ---: | --- | --- | --- |
| 1 | semantica `complete-link-greedy-v1` preservata | PASS | policy BC-1 importata; seed canonico, nessuna riassegnazione, ammissione verso ogni membro |
| 2 | threshold 0.70 inclusiva e `minClusterSize=3` | PASS | costanti chiuse, validator e test esatto 0.70 |
| 3 | catena A-B-C esclusa | PASS | BC-4 rifiuta il cluster di tre quando A-C è sotto soglia |
| 4 | snapshot/fingerprint una volta per build | PASS | preparazione prima del loop; diagnostica 1/1/1/1 e N lookup |
| 5 | nessuna ricostruzione globale per query | PASS nel builder | query BC-2 usano lookup O(1); l'API standalone BC-3 resta deliberatamente standalone |
| 6 | candidate graph bounded | PASS sintetico / GATE reale | query, edge e timeout bounded; risposta hit del futuro provider esatto da vincolare |
| 7 | componenti incomplete integralmente deferred | PASS | un solo membro uncertified rinvia l'intera componente |
| 8 | una sola componente di vettori in RAM | PASS | una Map, retrieve sequenziale, `clear()` e riferimento `null` in `finally` |
| 9 | `minimumPairSimilarity` ricalcolata | PASS | tutte le coppie del cluster finale vengono ricalcolate e contate |
| 10 | `recordedAt` distinto da `eventTime` | PASS | `eventTime` resta unknown salvo evidenza strutturata esplicita |
| 11 | `lastAccess` escluso dalla cronologia | PASS | accettato solo per provarne l'esclusione; assente dagli output |
| 12 | “più recente” non equivale ad “attualmente” | PASS | `currentStateSupported:false` senza evidenza esplicita |
| 13 | nessun testo/vettore/centroide/segreto negli output tecnici | PASS | shape chiuse, output vectorless e test privacy |
| 14 | equivalenza V1 sui dataset piccoli | PASS | reference indipendente a 100 e test unitari semantici |
| 15 | risultati e budget BC-6 100/1k/10k/40k | PASS documentale | harness e metriche coerenti; nessun rerun 40k |
| 16 | nessun collegamento a daemon, storage, Qwen o commit | PASS | import graph limitato a contratti puri e `node:crypto` |

## Correttezza e determinismo

La policy è congelata a confronto `GREATER_THAN_OR_EQUAL`, soglia `0.70` e
minimo tre. Il refiner ordina le identità con il comparatore BC-1, usa il primo
non assegnato come seed, verifica ogni candidato contro tutti i membri del
gruppo corrente e non riassegna gli esclusi.

La catena sintetica usa A-B e B-C sopra soglia ma A-C sotto soglia. Essa
produce gruppi sotto il minimo, mai il cluster `{A,B,C}`. Il confronto esatto
0.70 è incluso. Per ogni cluster finale tutte le coppie vengono ricalcolate e
il minimo reale viene scritto in `minimumPairSimilarity`.

Input diretto/inverso, direzione degli edge, ordine degli hit e latenze async
diverse producono identità semantiche uguali. Metriche, RSS, tempo e label
batch non partecipano a cluster ID o membership.

## Boundedness e complessità

Per una build con N identità:

- snapshot: validazione, copia, ordinamento e fingerprint una volta,
  `O(N log N)` tempo e `O(N)` memoria;
- discovery: N query al massimo, lookup identità `O(1)` per hit, ordinamento
  per risposta `O(h_q log h_q)`, union-find
  `O((N + E) α(N))`;
- grafo conservato: `O(N + E)`, con `E <= maxCandidateEdges`;
- refinement di una componente autorizzata di dimensione m: al massimo m
  vettori della sola componente corrente, nessuna matrice `O(m²)` e numero di
  cosine limitato da `maxPairwiseComparisons`;
- componenti oltre vector, pairwise, timeout, RSS o cluster-size budget sono
  deferred senza truncation semantica.

La complessità sparse osservata da BC-6 è coerente con
`O(N log N + Σ h_q log h_q + E α(N))`. Non viene più eseguita la precedente
ricostruzione `N × O(N log N)`.

Il bound sugli hit della singola risposta non è però imposto dal builder:
questa dipendenza dal provider è il gate P2 per il wiring reale, non un
fallimento del benchmark sintetico bounded-degree.

## Component closure e deferred

BC-3 autorizza una componente soltanto quando ogni membro ha una query
certificata sullo stesso snapshot, threshold, modello e revisione. Certificato
assente, invalido, stale, truncated, failed o query non completata produce
`DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY` per l'intera componente. Non vengono
estratti sotto-cluster da componenti incomplete.

Edge budget rende il grafo localmente truncated e forza tutte le componenti a
deferred. Query budget e timeout possono preservare soltanto componenti
disgiunte già integralmente certificate.

## Tempo e privacy

`recordedAt` proviene soltanto dal timestamp numerico del source contract
flat. Non viene copiato in `eventTime`. `lastAccess` non entra in ordine,
output, identità o request synthesis. La recency non abilita lo stato attuale:
`currentStateEvidence` resta `NOT_PROVIDED` e
`currentStateSupported:false`.

Piani, grafi, certificazioni pubbliche, provenance temporale e request
synthesis non contengono testo, embedding, vettori, centroidi, payload
provider, endpoint, API key o segreti. Il certificato raw non viene esposto:
rimane soltanto il fingerprint del certificato valido.

Qdrant non diventa memoria autorevole. Il suo neighbor output contiene solo
identificatori tecnici e score, è verificato contro l'indice di identità
correnti e non è collegato a storage, daemon, synthesis o commit.
`AUD-P2-004` resta quindi **contenuto e storico**, ma torna a essere un gate
obbligatorio se un futuro vector path tenta hydration o scrittura senza
rilettura della memoria autorevole e verifica del content hash.

## Risultati BC-6 recuperati

Budget dichiarati:

| Budget | Valore |
| --- | ---: |
| timeout complessivo per livello | 180.000 ms |
| timeout candidate graph | 120.000 ms |
| timeout refinement | 120.000 ms |
| RSS delta massimo | 536.870.912 byte |
| vettori componente in RAM | 32 |
| confronti pairwise | 10.000 |
| dimensione cluster | 8 |
| candidate edge | 3 × identityCount |
| neighbor query | identityCount |

Risultati del run unico BC-6:

| Identità | Query | Osservazioni candidate | Edge canonici | Componenti | Cluster | Deferred | Pairwise | Max componente | Max vettori | Tempo ms | RSS delta byte |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 100 | 194 | 96 | 7 | 3 | 2 | 21 | 84 | 3 | 407,61 | 9.973.760 |
| 1.000 | 1.000 | 2.003 | 996 | 7 | 3 | 2 | 21 | 984 | 3 | 1.343,70 | 15.728.640 |
| 10.000 | 10.000 | 20.096 | 9.996 | 7 | 3 | 2 | 21 | 9.984 | 3 | 11.457,10 | 62.554.112 |
| 40.000 | 40.000 | 80.405 | 39.996 | 7 | 3 | 2 | 21 | 39.984 | 3 | 47.747,54 | 180.752.384 |

La struttura del dataset e le formule spiegano i valori:

- tre clique da tre producono i tre cluster;
- chain, coppia sparse, coppia incomplete e componente grande producono sette
  componenti candidate totali;
- la componente grande è bounded-degree e viene rinviata prima del retrieve
  per vector budget;
- la componente incomplete viene rinviata integralmente;
- solo 14 vettori vengono risolti sequenzialmente;
- i 21 confronti derivano dalle tre clique più chain e coppia sparse;
- a 100 le disposition coincidono con la reference globale V1;
- a 100 e 1.000 i digest diretto/inverso coincidono.

I valori rispettano i budget dichiarati. Il 40k è completo e coerente con
harness, log e report, quindi non è stato rilanciato.

## Verifiche eseguite

| Verifica | Risultato |
| --- | --- |
| BC-1→BC-6 mirati, serializzati | 115/115 PASS |
| EC-1→EC-8, serializzati | 148/148 PASS |
| suite repository completa, unica esecuzione serializzata | 651/651 PASS |
| fail / cancelled / skipped / todo | 0 / 0 / 0 / 0 |
| `node --check` su moduli, provider, harness e test in scope | PASS |
| privacy e shape chiuse | PASS |
| import runtime vietati nei moduli BC | PASS |
| whitespace nello scope BC-7 | PASS |
| `git diff --check` globale | segnala solo whitespace preesistente in `chat_orbitale_ollama.js` |
| benchmark bounded clustering 40k | non rilanciato; artifact BC-6 validato |

La suite completa corrente contiene un test in più rispetto al conteggio
storico BC-6 (651 contro 650); l'esecuzione è interamente verde e non sono
state apportate modifiche ai test. La suite ha eseguito il proprio benchmark
repository `test/performance/hippocampus-scale-benchmark.js`, distinto
dall'harness bounded-clustering BC-6. Quest'ultimo non è stato rilanciato a
40.000 identità.

## Readiness sintetica

**READY.**

BC-1→BC-6 è pronto per un BC-8 esclusivamente sintetico/dry-run, usando un
provider fake che:

- controlla integralmente l'universo sintetico;
- può assumersi realmente la responsabilità della mode esatta;
- emette certificati legati allo snapshot;
- mantiene bounded il numero di hit per query;
- non usa rete, storage, daemon, Qdrant, BGE, Qwen o dati reali.

Questa readiness non autorizza persistenza, runtime wiring o provider reali.

## Readiness Qdrant reale

**BLOCKED.**

L'attuale `QdrantEmbeddingCacheProvider.searchPoints` e
`HippocampusEmbeddingCacheAdapter.searchNeighbors` sono primitive top-k
bounded, utili alla cache EC-6 ma non equivalenti a enumerazione completa sopra
soglia. Non possono certificare `EXACT_ABOVE_THRESHOLD_ENUMERATION_V1`.

Blocker residui precisi:

1. manca un provider reale `discoverNeighbors` compatibile con la shape BC-2;
2. manca una prova reale di enumerazione di tutti i vicini correnti sopra
   0.70 sullo stesso snapshot;
3. mancano certificate mode, snapshot binding, eligible count, exhaustion e
   observed-count binding prodotti dal provider reale;
4. `truncated:false` e top-k non possono essere promossi a certificazione;
5. il futuro provider esatto deve dimostrare anche il bound della risposta,
   senza perdere completezza;
6. Qdrant deve restare non autorevole e ogni futura hydration deve rispettare
   il contenimento storico `AUD-P2-004`;
7. nessun wiring può essere eseguito finché questi gate non sono verificati in
   un fix separato.

## Diff e riproducibilità

Diff BC-7 autorizzato:

- aggiunto soltanto
  `docs/HIPPOCAMPUS_BOUNDED_CLUSTERING_BC7_AUDIT.md`;
- nessun altro file modificato da BC-7.

Comandi principali eseguiti:

```text
node --test --test-concurrency=1 test/clustering/hippocampus-bounded-clustering-plan.test.js test/clustering/hippocampus-candidate-graph-builder.test.js test/clustering/hippocampus-discovery-completeness.test.js test/clustering/hippocampus-bounded-complete-link-refiner.test.js test/clustering/hippocampus-temporal-provenance.test.js test/clustering/hippocampus-bounded-clustering-benchmark.test.js
node --test --test-concurrency=1 test/hippocampus/embedding-cache-record.test.js test/providers/qdrant-embedding-cache-provider.test.js test/hippocampus/embedding-cache-collection-lifecycle.test.js test/hippocampus/embedding-cache-exact-operations.test.js test/hippocampus/bge-m3-embedding-cache-coordinator.test.js test/hippocampus/embedding-cache-neighbor-search.test.js test/hippocampus/embedding-cache-provisioning-scripts.test.js test/providers/bge-m3-embedding-provider.test.js
node --test --test-concurrency=1
```

## Verdetto unico

`BLOCKED_REAL_DISCOVERY_CERTIFICATION`
