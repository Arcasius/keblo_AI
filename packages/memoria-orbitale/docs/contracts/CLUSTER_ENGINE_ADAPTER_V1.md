# CLUSTER_ENGINE_ADAPTER_V1

## 1. Scopo

Il FIX 7 definisce clustering operativo esclusivamente read-only su un `ConsolidationPlan` validato e memorie plain. L'output è un insieme deterministico di cluster candidati matematici; non è persistenza, maturità o autorizzazione alla sintesi.

## 2. Non-obiettivi

Il V1 non legge o scrive storage, non modifica memorie o processing, non assegna `cluster.id`, non crea provider reali, non chiama rete, Qwen/Ollama o Qdrant, non sostituisce automaticamente il legacy e non implementa split/merge, maturità, sintesi o commit.

## 3. Separazione adapter/math

Il flusso è:

```text
ConsolidationPlan validato + memorie + embedding provider esplicito
  → MemoryContractNormalizer
  → ClusterEngineAdapter
  → ClusterMath
  → cluster candidates read-only
```

`ClusterMath` conosce soltanto array numerici. Non conosce memoria, provider, piano, processing, storage, file o servizi. L'adapter gestisce contratti e orchestration senza incorporare matematica alternativa.

## 4. Contratto e privacy del provider

```js
{
  schemaVersion: 1,
  getEmbedding: async ({ memoryId, embeddingRef }) => number[]
}
```

Il provider è obbligatorio, esplicito e non globale. L'adapter gli passa un oggetto congelato con esclusivamente `memoryId` ed `embeddingRef` normalizzato, che può essere `null`. Non passa testo, content, entities, meta, snapshot o memoria completa. Il provider decide se può risolvere senza reference. Non esiste fallback o chiamata HTTP incorporata.

## 5. Input piano e memorie

Prima di operare l'adapter chiama `validateConsolidationPlan()` e processa esclusivamente `candidateIds`. Piano manomesso, non dry-run, ID duplicato o candidato non risolvibile vengono rifiutati con errore strutturato. Opzioni storage/write/commit sono proprietà sconosciute e vengono rifiutate.

Le memorie possono essere array o object map. Ogni plain object candidato passa attraverso `normalizeMemory()`; il mapping flat/nested/hybrid non è duplicato. Un ID canonico duplicato o non corrispondente a un candidato richiesto non viene associato silenziosamente.

## 6. Validazione embedding

Un embedding è un array JavaScript non vuoto di soli number finiti, con norma finita diversa da zero. Typed array, `NaN`, infinito, valori non numerici, zero vector e dimensioni incoerenti sono rifiutati. Non avvengono padding, truncation, correzione o normalizzazione silenziosa. Gli array del provider vengono copiati e non mutati.

## 7. Policy

```js
{
  similarityThreshold: 0.70,
  minClusterSize: 3,
  maxClusterSize: null
}
```

La soglia è finita in `[-1, 1]`, il minimo è intero `>= 2`, il massimo è `null` oppure intero `>= minClusterSize`. `null` significa nessun limite: non esistono top-five, max 100, limiti prompt o slice nascosti. Un gruppo oltre un massimo esplicito non viene troncato: tutti i membri sono rinviati con `OVERSIZED_CLUSTER_DEFERRED`. Split/partition è futuro.

## 8. Algoritmo complete-link greedy V1

1. Ordina candidati validi per `memoryId`.
2. Usa il primo non assegnato come seed.
3. Considera gli altri in ordine di ID.
4. Aggiunge un candidato solo se la cosine verso ogni membro corrente è `>= similarityThreshold`.
5. Continua fino a esaurimento.
6. Promuove gruppi con dimensione almeno minima a cluster candidati.
7. Segnala ogni membro dei gruppi più piccoli come unclustered.

È un'euristica deterministica complete-link greedy, non un clustering globalmente ottimale. Non misura maturità. La soglia è confrontata direttamente; non viene usata la formula ambigua `similarity > 1 - threshold` del legacy.

## 9. Matematica

`cosineSimilarity(a, b)` rifiuta dimensioni diverse e zero vector e clampa soltanto il minimo errore floating point in `[-1, 1]`.

Il centroide è la media per componente di embedding con dimensione identica, restituita in un nuovo array.

La densità interna è la media delle cosine di ogni membro verso il centroide e riporta:

```js
{ averageSimilarity, minimumSimilarity, maximumSimilarity, memberCount }
```

Non è maturità e non decide sintesi.

L'isolamento esterno è `1 - media cosine` verso gli altri centroidi. Senza altri cluster restituisce similarity `null`, isolamento `1`, conteggio `0`. Con cosine negative l'isolamento può superare `1` e arrivare teoricamente a `2`; il V1 conserva questa semantica e non nasconde il fenomeno con clamp.

## 10. Reason code

- `CLUSTERED`
- `UNCLUSTERED_BELOW_MIN_SIZE`
- `EMBEDDING_PROVIDER_FAILED`
- `INVALID_EMBEDDING`
- `EMBEDDING_DIMENSION_MISMATCH`
- `CANDIDATE_MEMORY_NOT_FOUND`
- `OVERSIZED_CLUSTER_DEFERRED`
- `INVALID_CONSOLIDATION_PLAN`

I fallimenti non espongono eccezioni, testo o payload del provider.

## 11. Cluster candidate e ID

```js
{
  schemaVersion: 1,
  algorithmVersion: "complete-link-greedy-v1",
  clusterId,
  memberIds,
  embeddingDimension,
  centroid,
  centroidFingerprint,
  density,
  policy,
  reasonCodes: ["CLUSTERED"],
  persisted: false
}
```

I membri sono ordinati e univoci. `clusterId` è SHA-256 di serializzazione canonica di schema, algoritmo, policy, member ID, fingerprint del centroide e fingerprint degli embedding associati agli ID. Non usa tempo o casualità. `centroidFingerprint` è SHA-256 deterministico della rappresentazione numerica del centroide.

## 12. Risultato e statistiche

```js
{
  schemaVersion,
  algorithmVersion,
  planId,
  policy,
  clusters,
  unclustered,
  embeddingFailures,
  stats,
  persisted: false
}
```

Le statistiche distinguono candidati richiesti, memorie risolte, embedding validi/invalidi, failure provider, cluster, membri clustered/unclustered e gruppi oversize. Ogni candidato appartiene a cluster, unclustered oppure embedding failures, mai a più categorie.

## 13. Determinismo async ed errori provider

Richieste provider possono completarsi in qualsiasi ordine; l'associazione resta per ID e risultati, errori, cluster e membri vengono ordinati deterministicamente. Un failure provider è isolato e gli altri candidati continuano. Errori strutturali globali di piano, provider, policy o risoluzione ID interrompono l'operazione.

## 14. Immutabilità, privacy e assenza storage

Policy, risultato, cluster, centroidi e liste sono copie separate profondamente congelate. Piano, memorie, provider ed embedding sorgente non vengono mutati. L'output non contiene testo, snapshot, entities, meta, payload, storage o metodi e dichiara sempre `persisted: false`.

I moduli FIX 7 non importano `fs`, storage/capability, atomic commit, MemoryNode, Qdrant o modelli. Non creano file o directory e non chiamano `saveCluster`/`saveMemory`.

## 15. Differenze dal legacy ClusterEngine

`core/ClusterEngine.js` resta legacy/teorico e invariato. Richiede storage, embedding service con persistenza, memorie con metodi di classe, genera ID temporali/casuali, muta `memory.cluster` e salva memoria/cluster. Inoltre il suo confronto `similarity > 1 - threshold` è ambiguo.

L'adapter V1 lavora su plain object normalizzati, provider esplicito e funzioni matematiche pure. Non esiste sostituzione automatica nel runtime. Nel repository non è presente un file `CluasterEngine.js`, quindi non esiste una seconda copia da sincronizzare.

## 16. Garanzie, non-garanzie e rinvii

Il V1 garantisce input validato, provider privato, clustering greedy riproducibile, soglia diretta, membri non persi, ID deterministici, read-only e immutabilità. Non garantisce ottimo globale, maturità, qualità semantica, stabilità rispetto a provider/versioni embedding differenti, persistenza, transazioni, split/merge, sintesi o recall.

FIX 8 definirà la persistenza cluster. Restano inoltre rinviati: schema persistito e provenance, optimistic concurrency, cluster maturity, split/merge avanzati, versionamento provider/modello embedding, batching e synthesis policy.
