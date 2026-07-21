# Hippocampus Candidate Graph V1

Stato del contratto: FIX BC-2.

Questo contratto definisce esclusivamente la discovery e la costruzione bounded
del grafo candidato. Non esegue refinement complete-link, non finalizza cluster,
non carica testi e non produce o scrive `SuperMemoryRecord`.

## Versioni e semantica ereditata

- `schemaVersion`: `1`;
- `graphVersion`: `hippocampus-candidate-graph-v1`;
- `algorithmVersion`: `hippocampus-bounded-complete-link-v1`.

BC-2 importa dal contratto BC-1, senza duplicarle, le seguenti decisioni:

- `clusterThreshold = 0.70`;
- confronto inclusivo `>=`;
- `minClusterSize = 3`;
- status e reason code;
- vocabolario `DISCOVERY_COMPLETENESS`;
- fingerprint dello snapshot globale.

Il grafo è un insieme di candidati per i FIX successivi. Una componente
connessa non equivale a un cluster complete-link: la catena A–B–C può essere
una componente anche quando A e C sono sotto soglia. Per questo ogni output ha
`finalizationAuthorized: false` e non contiene un campo `clusters`.

## Isolamento

Il modulo è puro rispetto all'infrastruttura. L'unica dipendenza applicativa è
il contratto puro BC-1. Non importa adapter Qdrant, cache, storage, daemon,
RecallRouter, synthesis, BGE-M3 o Qwen.

Non esistono retry, fallback, write, delete, upsert, provisioning o cleanup.
Il provider di discovery è iniettato dal chiamante e nei test è esclusivamente
fake/in-memory.

## Costruzione

```js
const builder = createHippocampusCandidateGraphBuilder({
  discoveryProvider,
  maxNeighborQueries,
  maxCandidateEdges,
  timeoutMs
});

const graph = await builder.build({
  identitySnapshot,
  signal
});
```

Le shape di opzioni e input sono chiuse. I tre budget sono interi positivi e
obbligatori. `signal` deve essere un `AbortSignal`. Lo snapshot deve essere il
valore profondamente immutabile prodotto da BC-1 e deve superare nuovamente la
validazione del fingerprint.

## Provider read-only

Il provider espone soltanto:

```js
discoverNeighbors({
  queryIdentity: {
    memoryId,
    contentHash,
    pointId,
    model,
    revision
  },
  identitySnapshotFingerprint,
  clusterThreshold,
  signal
})
```

Il builder invoca le identità una alla volta nell'ordine canonico dello
snapshot. Non usa `Promise.all`; la concorrenza osservabile è uno. Ogni chiamata
riceve il segnale interno collegato all'abort del chiamante e al timeout globale.

La risposta è chiusa. Con l'estensione BC-3 può contenere il solo campo
opzionale allowlisted `certificate`:

```js
{
  discoveryCompleteness,
  hits: [{
    pointId,
    memoryId,
    contentHash,
    model,
    revision,
    score
  }],
  certificate // opzionale; contratto BC-3
}
```

`score` deve essere finito e compreso tra `-1` e `1`. Un risultato con campi
aggiuntivi, identificatori malformati o score non finito fallisce chiuso. Una
risposta `FAILED` deve avere `hits: []`. Il builder non interpreta eccezioni del
provider e non ne espone il messaggio: restituisce un errore sanitizzato e non
ritenta.

## Verifica rispetto allo snapshot

Ogni hit viene verificato contro gli indici in-memory dello snapshot corrente.
La classificazione è deterministica:

1. point non presente ma `memoryId` corrente: stale;
2. point e `memoryId` entrambi estranei: foreign;
3. modello o revisione diversi dall'identità corrente: provenance incompatibile;
4. `memoryId` o `contentHash` diversi per un point corrente: stale;
5. point uguale alla query: self-hit;
6. score sotto `0.70`: below-threshold;
7. gli altri hit diventano osservazioni semantiche candidate.

Gli scarti sono contati nelle metriche ma non vengono restituiti con payload o
dettagli provider. Nessun point stale o foreign entra negli edge o nelle
componenti.

## Edge canonico

Un edge è accettato soltanto con `score >= 0.70` ed è sempre rappresentato come:

```js
{
  edgeId,
  pointIdA: min(pointIdA, pointIdB),
  pointIdB: max(pointIdA, pointIdB),
  maximumObservedScore
}
```

`edgeId` lega versione algoritmo, fingerprint dello snapshot e coppia canonica;
non include batch, direzione, ordine provider o score. Osservazioni duplicate
nella stessa direzione o nelle due direzioni vengono deduplicate. Il valore
conservato è il massimo score valido osservato, scelta deterministica orientata
al recall.

Il massimo non certifica la semantica complete-link. BC-4 ricalcolerà la
similarità reale nel refinement bounded: un falso positivo può quindi allargare
una componente candidata, ma non può certificare un cluster scorretto.

## Union-find e componenti

Union-find contiene esclusivamente i pointId dello snapshot e gli edge ammessi.
In caso di merge la radice lessicograficamente minore è sempre la radice
canonica. Anche le identità isolate producono componenti singleton.

```js
{
  componentId,
  memberIds,
  memberCount,
  discoveryCompleteness
}
```

`memberIds` è ordinato. `componentId` lega algoritmo, fingerprint e membership;
non contiene batch o metriche. Le componenti sono ordinate per primo memberId,
dimensione e componentId.

Nessuna componente BC-2 espone `minimumPairSimilarity`, `clusterId`, testo,
vettore o centroide.

## Completezza fail-closed

Il provider deve dichiarare per ogni query uno dei valori BC-1:

- `COMPLETE_ABOVE_THRESHOLD`;
- `INCOMPLETE_TRUNCATED`;
- `INCOMPLETE_UNCERTIFIED`;
- `FAILED`.

BC-2 trasporta e aggrega questi stati con priorità conservativa:
`FAILED`, `INCOMPLETE_TRUNCATED`, `INCOMPLETE_UNCERTIFIED`, complete. Non
trasforma truncated, uncertified o failed in complete.

Identità non interrogate per budget o timeout aggiungono
`INCOMPLETE_UNCERTIFIED`. Un edge budget superato aggiunge
`INCOMPLETE_TRUNCATED` a grafo e componenti. Di conseguenza un grafo localmente
troncato non può risultare silenziosamente complete.

La sola dichiarazione provider `COMPLETE_ABOVE_THRESHOLD` non fornisce una
certificazione: senza certificato BC-3 valido viene degradata a
`INCOMPLETE_UNCERTIFIED`. BC-2 da solo produce quindi
`finalizationAuthorized: false`; l'estensione BC-3 può autorizzare una
componente chiusa esclusivamente per il futuro refinement BC-4, mai come
cluster finale.

## Budget e abort

`maxNeighborQueries` limita il numero totale di query. Se lo snapshot contiene
altre identità, il risultato è `DEFERRED` con
`DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY`.

`maxCandidateEdges` limita gli edge unici conservati. Il primo nuovo edge oltre
il limite ferma la discovery e produce `DEFERRED_EDGE_BUDGET`; il grafo è
esplicitamente `INCOMPLETE_TRUNCATED`.

`timeoutMs` è un deadline globale. Alla scadenza il provider riceve abort e il
risultato è `DEFERRED_TIMEOUT`, anche quando il provider non collabora. L'abort
esplicito del chiamante fallisce chiuso con `CANDIDATE_GRAPH_ABORTED`.

Non viene eseguito alcun retry e nessun budget causa un cluster parziale
dichiarato completo.

## Output

```js
{
  schemaVersion,
  graphVersion,
  algorithmVersion,
  graphId,
  status,
  reasonCode,
  identitySnapshotFingerprint,
  identityCount,
  policy,
  discoveryCompleteness,
  edges,
  components,
  queryDiscoveries,
  metrics,
  finalizationAuthorized
}
```

`graphId` include snapshot, policy, stato, completezza, edge, componenti e i
summary di certificazione BC-3. Le metriche operative non partecipano al suo
calcolo.

Le metriche contano query, hit, osservazioni accettate/duplicate, self-hit,
foreign, stale, provenance incompatibile, score sotto soglia, edge,
componenti, massima dimensione, identità interrogate/non interrogate e i
quattro stati discovery ricevuti.

L'output è profondamente immutabile. Non contiene testo, contenuto della
memoria, userId chiaro, user hash, vettori, centroidi, payload Qdrant, endpoint,
segreti o batch EC-5.

## Determinismo e cross-batch

L'ordine originale delle identità viene eliminato dal fingerprint canonico
BC-1. Il builder ordina query, hit, edge, member e componenti. Tie e radici
union-find hanno regole lessicografiche esplicite.

Un'identità simbolicamente materializzata nel batch 1 può collegarsi a una del
batch 50, passando eventualmente per una del batch 17. Invertire l'input,
invertire la direzione degli hit o permutare le risposte del provider produce lo
stesso grafo canonico. Nessun numero di batch entra in identità, edgeId,
component membership o output.

## Confine dei FIX

- BC-2: grafo candidato, questo contratto;
- BC-3: certificazione della completezza discovery e closure per componente;
- BC-4: retrieval bounded e refinement complete-link reale;
- FIX successivi: piano temporale, synthesis e solo infine wiring.

BC-2 non finalizza cluster e non scrive dati.
