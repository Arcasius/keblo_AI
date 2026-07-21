# CLUSTER_PERSISTENCE_V1

## 1. Scopo

Il FIX 8 definisce il record canonico V1 dei cluster candidati prodotti da `ClusterEngineAdapter` e il relativo CRUD in `JsonMemoryStorage`. Il JSON cluster è autorevole, versionato, validato e sostituito atomicamente per singolo file. Le source memory sono rappresentate soltanto dai loro ID e non vengono modificate.

## 2. Non-obiettivi

Il V1 non assegna cluster alle memorie, non esegue transition di processing, non implementa sintesi, maturità, lock, compare-and-swap, recovery o transazioni memoria + cluster. Non chiama Qwen, Ollama, rete o servizi globali. Non promette idempotenza o assenza di lost update tra processi.

## 3. Schema persistito

```js
{
  schema_version: 1,
  id: "clp_<sha256>",
  idempotency_key: "<sha256>",
  record_fingerprint: "<sha256>",
  user_id: "synthetic_user",
  candidate_cluster_id: "<FIX 7 sha256>",
  plan_id: "<sha256>",
  algorithm_version: "complete-link-greedy-v1",
  policy: {
    similarityThreshold: 0.7,
    minClusterSize: 3,
    maxClusterSize: null
  },
  source_memory_ids: ["mem_a", "mem_b", "mem_c"],
  embedding: {
    provider_id: "explicit-provider",
    model: "explicit-model",
    version: "explicit-version",
    dimension: 2
  },
  centroid: [1, 0.5],
  centroid_fingerprint: "<sha256>",
  density: {
    average_similarity: 0.9,
    minimum_similarity: 0.8,
    maximum_similarity: 1,
    member_count: 3
  },
  created_at: 1780000000000,
  updated_at: 1780000000000,
  persisted: true
}
```

Non sono ammessi campi sconosciuti. In particolare sono assenti testo, `content`, `sourceSnapshot`, entities, prompt, risposte modello, processing inventato e `centroid_ref` fittizio.

## 4. Provenance e source memory

`source_memory_ids` è la provenance minima V1. Contiene esattamente i `memberIds` del candidato FIX 7, senza duplicati e ordinati lessicograficamente. `createClusterRecord()` può ordinare una copia dell'array candidato, ma rifiuta duplicati e non modifica né cancella l'input o le memorie sorgenti. `validateClusterRecord()` richiede che il record persistito sia già ordinato.

## 5. Metadati embedding

Provider, modello e versione sono input espliciti e non vuoti. La dimensione proviene dal candidato validato ed è conservata esplicitamente; deve coincidere con la lunghezza del centroide. Non esistono default globali, provider ignoti vuoti o versione `null`.

## 6. Centroide inline

Il centroide V1 è inline, deve essere un embedding valido secondo `ClusterMath`, viene copiato e il suo fingerprint SHA-256 viene ricalcolato. Un futuro vector adapter potrà duplicarlo o spostarlo in un indice vettoriale soltanto tramite una migrazione deliberata; fino ad allora il JSON resta autorevole.

## 7. Densità

Le tre similarity devono essere numeri finiti in `[-1, 1]` e soddisfare `minimum_similarity <= average_similarity <= maximum_similarity`. `member_count` deve coincidere con il numero di source memory. La densità non prova né induce maturità o autorizzazione alla sintesi.

## 8. Timestamp

`created_at` e `updated_at` sono epoch millisecondi safe integer `>= 0`, sempre forniti dal chiamante. Alla creazione sono uguali. Il modulo non legge l'orologio e non genera timestamp. Un replay equivalente con timestamp differente conserva il record originario e il suo `created_at`.

## 9. Cluster ID e idempotency key

La key è SHA-256 della serializzazione canonica di:

- `schema_version`;
- `user_id`;
- `algorithm_version`;
- policy completa;
- `source_memory_ids` ordinati;
- embedding `provider_id`, `model`, `version`, `dimension`;
- `centroid_fingerprint`.

Tempo, casualità e `plan_id` sono esclusi. L'ID è sempre `clp_<idempotency_key>`; `candidate_cluster_id` resta separato. Una diversa provenance embedding produce quindi una diversa identità persistita.

## 10. Record fingerprint

Il fingerprint semantico include esattamente `schema_version`, `id`, `idempotency_key`, `user_id`, `candidate_cluster_id`, `algorithm_version`, policy, source ID, metadata embedding, `centroid_fingerprint`, density e `persisted`. Esclude `created_at`, `updated_at`, `plan_id` e `record_fingerprint` stesso. Questa scelta rende equivalenti retry provenienti da piani semanticamente compatibili senza nascondere cambiamenti a candidato, provenance o densità.

## 11. Validazione e immutabilità

`validateClusterRecord()` accetta esclusivamente plain object con proprietà esatte, ricontrolla versione, stringhe, SHA-256, source ID, policy, embedding, centroide, density, timestamp e `persisted === true`, quindi ricalcola key, ID e fingerprint. Manomissioni vengono rifiutate e non sono corrette silenziosamente.

Creazione e validazione restituiscono una copia plain separata e profondamente congelata. Non accedono allo storage, non modificano l'input e non condividono riferimenti mutabili.

## 12. Formato file e CRUD

Ogni utente usa esclusivamente:

```text
<dataDir>/<userId>_clusters.json
```

Il documento è una object map indicizzata per `record.id`. `loadClusters(userId)` restituisce `[]` se il file finale manca, valida ogni entry e non enumera `.bak` o temp. Una entry corrotta o una key diversa da `record.id` produce errore, non viene nascosta. `getCluster()` restituisce una copia validata o `null`.

`saveCluster()` valida record e scope utente, legge lo stato corrente, controlla ID e key e restituisce:

```js
{ cluster, created, idempotentReplay }
```

`deleteCluster()` elimina soltanto l'ID richiesto e restituisce `{ deleted, clusterId }`; un ID assente non provoca riscrittura. Non modifica memorie, centroidi esterni o processing.

## 13. Replay e conflitti

Nuova key/ID crea un record. Stessa key e stesso fingerprint restituiscono il record originario con `created: false` e `idempotentReplay: true`, senza riscrittura. Stessa key con fingerprint diverso oppure collisioni incoerenti non producono overwrite e generano errore. Un record o file corrotto viene segnalato.

La garanzia riguarda replay sequenziali nel singolo processo e nello stato appena letto. Non dimostra idempotenza multi-processo.

## 14. Atomic write e backup

Creazione, aggiornamento della object map e delete passano da `atomicWriteJson()`: temp nella stessa directory, fsync, validazione JSON, backup `.bak`, rename atomico e fsync directory secondo `ATOMIC_JSON_COMMIT_V1`. L'atomicità riguarda un singolo file cluster. Il backup è l'ultima versione valida precedente osservata dal writer, non snapshot o rollback applicativo.

## 15. Capability

`JsonMemoryStorage.capabilities` dichiara `cluster.readAll`, `cluster.readOne`, `cluster.writeOne` e `cluster.deleteOne` come `supported` e `verified: true`. Snapshot, lock e rollback restano `unsupported`; `commit.atomic` conserva il solo significato di sostituzione atomica del singolo file.

## 16. Compatibilità legacy

Il formato storico di `core/ClusterEngine.js` usa `memory_ids`, `centroid_ref`, density scalare, timestamp ISO e muta le memorie. Non è accettato o migrato implicitamente. Una futura importazione richiederà adapter/migration esplicito e verificato; il precedente storage cluster era uno stub, quindi FIX 8 non migra dati reali.

## 17. Garanzie e non-garanzie

Il V1 garantisce schema stretto, provenance per ID, metadata embedding espliciti, identità e fingerprint deterministici, copia immutabile, CRUD verificato, replay sequenziale senza duplicato e atomic replace del singolo file.

Non garantisce lock, serializzazione tra processi, prevenzione lost update, compare-and-swap, transazione memoria + cluster, rollback, recovery, assegnazione alle memorie, processing transition, maturità, sintesi o qualità semantica.

## 18. Concorrenza aperta e decisioni rinviate

Due processi possono leggere la stessa object map e sostituirla con documenti completi ma incompatibili: il file resta JSON atomico, però un update può andare perso. Restano rinviati lock e stale-lock handling, optimistic concurrency, transazioni multi-file, recovery, migrazione legacy, vector adapter, maturity, processing commit e sintesi.
