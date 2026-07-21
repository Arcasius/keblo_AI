# HIPPOCAMPUS BOUNDED COMPLETE-LINK REFINEMENT V1

## 1. Scope

BC-4 raffina esclusivamente componenti BC-3 con
`AUTHORIZED_FOR_REFINEMENT` e produce un piano BC-1 vectorless. Non esegue
tempo BC-5, synthesis, SuperMemory, persistenza, daemon, storage o wiring.

La semantica resta `complete-link-greedy-v1`: identità ordinate con il
comparatore canonico BC-1, primo non assegnato come seed, candidati non
assegnati in ordine e ammissione solo quando ogni cosine verso il gruppo
corrente è `>= 0.70`. Dopo il primo confronto sotto soglia il candidato viene
escluso. Non esistono riassegnazione, clustering gerarchico o limite implicito
di cinque. `minClusterSize` resta 3.

## 2. API pura

```js
createHippocampusBoundedCompleteLinkRefiner({
  embeddingResolver,
  rssReader,
  clock
})
```

Le tre dipendenze sono iniettate. Il resolver espone `cacheSchemaVersion` e:

```js
resolveEmbedding({ identity, identitySnapshotFingerprint, signal })
```

`refine` riceve esclusivamente:

```js
{
  identitySnapshot,
  candidateGraph,
  policy,
  budgets,
  signal
}
```

Policy e budget sono rivalidati dal contratto BC-1. Snapshot e candidate graph
devono essere profondamente immutabili, compatibili per fingerprint, algoritmo
e policy. Closure, coverage e certificati summary BC-3 vengono rivalidati prima
del primo retrieve.

## 3. Resolver e provenance

Ogni risposta ha shape chiusa:

```js
{
  vector,
  provenance: {
    cacheSchemaVersion,
    identitySnapshotFingerprint,
    pointId,
    memoryId,
    contentHash,
    model,
    revision,
    dimension: 1024,
    normalized: true
  }
}
```

BC-4 confronta nuovamente ogni campo con lo snapshot corrente, verifica 1024
valori numerici finiti, vettore non zero e norma unitaria. Shape inattesa,
stale identity, fingerprint o provenance incompatibile e vettore invalido
falliscono chiusi con errore stabile e senza piano parziale. Il resolver non
riceve testo, payload narrativo, user ID chiaro o configurazione globale.

## 4. Bound di memoria e retrieve

Le componenti sono ordinate per point ID minimo. Prima del retrieve vengono
controllati abort, timeout, RSS, pairwise residuo e dimensione componente. Una
componente oltre `maxComponentVectorsInMemory` diventa
`DEFERRED_DENSE_COMPONENT` con zero chiamate resolver.

Il retrieve è strettamente sequenziale e canonico; non viene usato
`Promise.all`. Esiste una sola `Map` di vettori per volta, con al massimo
`memberCount` riferimenti. La `Map` viene svuotata e il riferimento azzerato in
`finally` prima della componente successiva, anche su deferred o failure.

`rssReader.readRssBytes()` è l'unica fonte RSS. Baseline, picco e delta sono
quindi simulabili senza dipendere dalla macchina reale. Un picco oltre
`maxRssDeltaBytes` rinvia integralmente la componente con
`DEFERRED_RSS_BUDGET`.

## 5. Pairwise e verifica finale

Ogni chiamata alla cosine viene contata prima di poter essere usata. Il limite
non viene mai oltrepassato: quando il confronto successivo eccederebbe
`maxPairwiseComparisons`, ogni risultato staged della componente viene
scartato e l'intera componente diventa `DEFERRED_PAIRWISE_BUDGET`.

Non viene conservata una matrice O(m²). Il greedy calcola solo i confronti
richiesti, con short-circuit al primo valore sotto soglia. Per ogni gruppo di
almeno tre membri e non oversized, tutte le coppie vengono poi ricalcolate. Il
minimo reale delle cosine diventa `minimumPairSimilarity`; un valore sotto
0.70 fallisce chiuso e non può produrre un cluster.

Una catena con A-B e B-C sopra soglia ma A-C sotto soglia non forma
`{A,B,C}`. Gruppi sotto tre membri diventano
`UNCLUSTERED_BELOW_MIN_SIZE`. Un gruppo sopra `maxClusterSize` diventa
`DEFERRED_OVERSIZED_CLUSTER` integralmente; altri gruppi disgiunti e verificati
della stessa componente possono restare validi.

## 6. Timeout, abort e output

Il timeout totale produce `DEFERRED_TIMEOUT` per la componente integra. Un
`AbortSignal` del chiamante interrompe il resolver cooperativo e fallisce
chiuso: non viene restituito alcun piano dichiarato completo o parziale.

L'output è costruito esclusivamente tramite `createBoundedClusteringPlan`.
Ogni identità ha una sola disposition, la copertura è completa e disgiunta e i
campi temporali restano nella rappresentazione BC-1 `NOT_EVALUATED`, con tutte
le sorgenti unresolved e range null. Cluster ID e plan ID non includono
metriche; cluster ID non include tempo, RSS, vettori, dati sensibili o batch.

Il modulo non importa provider reali, cache embedding, Qdrant, BGE, synthesis,
storage, daemon, RecallRouter o `ClusterEngineAdapter`.
