# HIPPOCAMPUS BOUNDED CLUSTERING PLAN V1

## 1. Scopo

BC-1 definisce il solo contratto puro, vectorless e versionato del futuro
bounded clustering planner Ippocampo. Il modulo costruisce e valida snapshot
globali delle identità e piani deterministici; non esegue candidate discovery,
neighbor search, complete-link, retrieve, synthesis o persistenza.

`algorithmVersion` è congelata a:

```text
hippocampus-bounded-complete-link-v1
```

Il contratto non sostituisce e non modifica `ClusterEngineAdapter` o
`ClusterRecord` V1. In particolare non persiste centroidi.

## 2. Non-obiettivi e isolamento

BC-1 non importa né accede a:

- Qdrant, BGE-M3 o altri provider;
- embedding cache o vector path storico;
- storage memoria o dati reali;
- `ClusterEngineAdapter` o `ClusterRecord`;
- RecallRouter o HippocampusDaemon;
- synthesis, Qwen/Ollama, super-memory o commit;
- rete, filesystem, ambiente globale, clock o casualità.

L'unica dipendenza è `node:crypto` per SHA-256. Il modulo non crea thread,
promise concorrenti, timer, callback o side effect.

## 3. Semantica congelata

La policy V1 è esattamente:

```js
{
  policyVersion: 1,
  clusterThreshold: 0.70,
  minClusterSize: 3,
  comparison: "GREATER_THAN_OR_EQUAL"
}
```

Il futuro refinement dovrà preservare `complete-link-greedy-v1`: identità
ordinate canonicamente, seed deterministico, candidato ammesso soltanto se la
similarità con ogni membro corrente è `>= clusterThreshold`, nessuna
riassegnazione e nessun nuovo partizionamento.

BC-1 non calcola similarità. Un cluster dichiarato finale deve però riportare
`minimumPairSimilarity >= 0.70` e discovery
`COMPLETE_ABOVE_THRESHOLD`. Questi claim saranno prodotti e verificati
matematicamente da un fix successivo. Una modifica a soglia, minimo o confronto
richiede una nuova policy/versione e non può entrare come opzione libera V1.

## 4. Snapshot globale autorevole

Input:

```js
{
  userIdHash,
  identities: [{
    memoryId,
    contentHash,
    pointId,
    model,
    revision
  }]
}
```

`userIdHash` e `contentHash` sono SHA-256 lowercase; `pointId` è UUID version 5.
Memory ID e point ID devono essere univoci. Modello e revisione devono essere
uguali per tutto lo snapshot.

Le identità vengono ordinate per point ID e poi memory ID. Il fingerprint è
SHA-256 di dominio, schema, user hash e manifest completo ordinato. L'output è:

```js
{
  schemaVersion: 1,
  snapshotFingerprint,
  userIdHash,
  identityCount,
  identities
}
```

Il validator ricalcola ordinamento, conteggio e fingerprint. Uno snapshot
parziale, riordinato, duplicato, con provenance mista o manomesso fallisce
chiuso. Il piano pubblico conserva soltanto fingerprint e conteggio, non lo
user hash o il manifest completo.

## 5. Discovery completeness

Il vocabolario chiuso è:

```text
COMPLETE_ABOVE_THRESHOLD
INCOMPLETE_TRUNCATED
INCOMPLETE_UNCERTIFIED
FAILED
```

Soltanto `COMPLETE_ABOVE_THRESHOLD` è ammesso per cluster finali e gruppi
terminalmente sotto la dimensione minima. Discovery troncata, non certificata o
fallita non può produrre un cluster finale.

`FAILED` è coerente soltanto con
`DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY`. Un componente può superare un budget
anche dopo discovery completa e in tal caso resta integralmente deferred.

## 6. Global barrier

La provenance dichiara `globalBarrierStatus: COMPLETE|INCOMPLETE`.

Con barriera `INCOMPLETE`:

- non sono ammessi cluster finali;
- non sono ammessi gruppi unclustered terminali;
- tutte le identità dello snapshot devono apparire in componenti deferred con
  `DEFERRED_GLOBAL_BARRIER`.

Con barriera `COMPLETE`, quel reason code è vietato. La barriera è un claim
contrattuale BC-1; la futura materializzazione globale appartiene ad altro fix.

## 7. Budget operativi

I budget hanno shape esatta:

```js
{
  neighborLimit,
  overfetchFactor,
  scoreThreshold,
  maxComponentVectorsInMemory,
  maxPairwiseComparisons,
  maxCandidateEdges,
  maxClusterSize,
  timeoutMs,
  maxRssDeltaBytes
}
```

Non esistono default o limite implicito cinque. Interi e byte budget devono
essere positivi. `scoreThreshold` è finito in `[-1, clusterThreshold]`.
`maxClusterSize` è `null` oppure intero almeno pari a `minClusterSize`: è un
safety gate e non autorizza truncation o split.

Le metriche devono restare entro i budget dichiarati. Budget e disposizioni
entrano nel `planId`, perché possono cambiare il risultato; le metriche
osservate non entrano né in `planId` né in `clusterId`.

## 8. Disposizioni complete e disgiunte

Ogni memory ID dello snapshot deve apparire esattamente una volta in uno dei
tre insiemi:

1. `clusters`: finalizzazione semantica certificata;
2. `deferredComponents`: componente integra non finalizzata;
3. `unclusteredComponents`: decisione terminale sotto `minClusterSize`.

Gli insiemi devono essere completi e mutuamente disgiunti. Non sono ammessi ID
estranei allo snapshot, duplicati, omissioni o sovrapposizioni. Un componente
deferred conserva tutti i propri `memberIds`; BC-1 non accetta sotto-cluster
dello stesso componente come finali.

La separazione `unclusteredComponents` evita di interpretare un normale gruppo
sotto soglia minima come lavoro retryable. Può quindi esistere un piano
`COMPLETE` con cluster finali e gruppi unclustered, purché non esistano
componenti deferred.

## 9. Status del piano

Lo status è derivato, mai scelto dal chiamante:

- `COMPLETE`: nessun componente deferred;
- `PARTIAL_DEFERRED`: almeno un cluster finale e almeno un componente deferred;
- `DEFERRED`: componenti deferred presenti e nessun cluster finale.

Una componente deferred non impedisce la finalizzazione di componenti
certificate e disgiunte. Nessun membro deferred può comparire in un cluster.

## 10. Cluster finale vectorless

Output cluster:

```js
{
  clusterId,
  memberIds,
  orderedSourceIds,
  unresolvedSourceIds,
  temporalStart,
  temporalEnd,
  timestampQuality,
  minimumPairSimilarity,
  discoveryCompleteness
}
```

`memberIds` è l'insieme canonico lessicografico usato per identità e coverage.
Deve contenere almeno tre ID e rispettare l'eventuale `maxClusterSize`.

Non sono presenti embedding, vector, centroid, density vettoriale, payload o
testo. `clusterId` è SHA-256 di dominio, algorithm version, policy, snapshot
fingerprint e member ID canonici. Sono esclusi:

- metriche e RSS;
- tempi di esecuzione;
- campi temporali;
- ordine input e batch;
- reason count operativi.

Lo stesso cluster semantico mantiene quindi lo stesso ID se cambiano telemetria
o futura rappresentazione temporale.

## 11. Componenti deferred e unclustered

Shape comune:

```js
{
  componentId,
  memberIds,
  memberCount,
  reasonCode,
  discoveryCompleteness
}
```

`componentId` dipende da snapshot fingerprint e membership canonica, non dal
reason code. `memberCount` è calcolato, non accettato dall'input.

Reason code deferred:

- `DEFERRED_GLOBAL_BARRIER`;
- `DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY`;
- `DEFERRED_DENSE_COMPONENT`;
- `DEFERRED_PAIRWISE_BUDGET`;
- `DEFERRED_EDGE_BUDGET`;
- `DEFERRED_TIMEOUT`;
- `DEFERRED_RSS_BUDGET`;
- `DEFERRED_OVERSIZED_CLUSTER`.

`UNCLUSTERED_BELOW_MIN_SIZE` è ammesso soltanto in
`unclusteredComponents`, richiede discovery completa e membership inferiore a
tre.

`STALE_IDENTITY_REJECTED` è un reason diagnostico: conta osservazioni stale
scartate e non dispone un'identità corrente dello snapshot.

## 12. Tempo predisposto per BC-5

BC-1 non sceglie il campo timestamp autorevole e non legge memorie. Definisce
però la partizione chiusa:

```js
{
  orderedSourceIds,
  unresolvedSourceIds,
  temporalStart,
  temporalEnd,
  timestampQuality
}
```

I due array devono essere disgiunti e coprire esattamente `memberIds`.
`unresolvedSourceIds` è canonico per ID. `orderedSourceIds` è riservato al
futuro ordine cronologico deterministico.

Qualità ammesse:

- `NOT_EVALUATED`;
- `COMPLETE`;
- `PARTIAL_MISSING`;
- `PARTIAL_INVALID`;
- `UNKNOWN`.

In BC-1, `NOT_EVALUATED` richiede tutte le source unresolved e range temporale
null. `COMPLETE` richiede tutte le source ordinate e range epoch millisecondi
valido. `UNKNOWN` richiede tutte le source unresolved e range null. Le policy
di estrazione, precedenza, parsing e prova di stato “attuale” restano BC-5.

Il tempo non partecipa alla membership semantica o al `clusterId`. Il timestamp
più recente non autorizza l'inferenza “attualmente”.

## 13. Provenance

Il piano espone soltanto:

```js
{
  identitySnapshotFingerprint,
  identityCount,
  cacheSchemaVersion,
  embeddingModel,
  embeddingRevision,
  plannerContractVersion,
  globalBarrierStatus
}
```

Modello e revisione devono coincidere con tutte le identità non vuote dello
snapshot. Non compaiono endpoint, API key, provider transport, user ID chiaro,
path o configurazioni globali.

## 14. Metriche

Le metriche hanno shape chiusa e contengono esclusivamente conteggi, durata e
RSS:

```js
{
  identityCount,
  finalizedIdentityCount,
  deferredIdentityCount,
  unclusteredIdentityCount,
  neighborQueryCount,
  candidateEdgeCount,
  canonicalEdgeCount,
  componentCount,
  completedComponentCount,
  deferredComponentCount,
  unclusteredComponentCount,
  pairwiseComparisonCount,
  maximumComponentSize,
  maximumVectorsInMemory,
  elapsedMs,
  rssStartBytes,
  rssPeakBytes,
  rssDeltaBytes,
  reasonCounts
}
```

Conteggi di identità e componenti devono coincidere con le disposizioni.
`maximumComponentSize` rappresenta la massima componente candidata osservata:
deve essere almeno pari alla massima disposition finale e non può superare il
numero di identità dello snapshot. Questo consente al refinement di dimostrare
più gruppi disgiunti dentro una componente BC-3 senza perdere la misura della
componente sorgente. RSS delta deve essere coerente e edge, pairwise e vettori
osservati non possono superare i budget. `reasonCounts`
contiene esattamente tutti i reason code; i reason di componente coincidono con
le rispettive disposizioni, mentre `STALE_IDENTITY_REJECTED` è diagnostico.

## 15. Piano pubblico

```js
{
  schemaVersion: 1,
  algorithmVersion,
  planId,
  status,
  policy,
  budgets,
  provenance,
  clusters,
  deferredComponents,
  unclusteredComponents,
  metrics,
  persisted: false
}
```

Builder e validator richiedono shape esatte, plain data, snapshot valido,
coverage totale, barrier coerente, provenance vincolata e metriche coerenti.
L'output è profondamente congelato.

`planId` è SHA-256 del contenuto semantico e delle disposizioni, esclusa la
telemetria. Il validator richiede anche lo snapshot globale e ricostruisce il
piano per verificare fingerprint, cluster/component ID e determinismo.

## 16. Privacy e failure

Il piano non contiene:

- testo, prompt o source content;
- embedding, vector o centroid;
- payload Qdrant;
- user ID chiaro;
- timestamp raw della memoria;
- endpoint, IP, API key o segreti;
- storage handle, callback, signal o metodo.

Gli errori espongono soltanto `name`, code chiuso, phase e `retryable:false` con
messaggio stabile. Non copiano valori input, ID, hash, provenance o proprietà
sconosciute.

## 17. API BC-1

```js
createGlobalIdentitySnapshot(input)
validateGlobalIdentitySnapshot(snapshot)
createBoundedClusteringPlan(input)
validateBoundedClusteringPlan(plan, identitySnapshot)
```

BC-1 produce soltanto contratti e validazione. Candidate graph, certificazione
discovery, refinement complete-link, estrazione temporale, benchmark e wiring
restano fix futuri separati.
