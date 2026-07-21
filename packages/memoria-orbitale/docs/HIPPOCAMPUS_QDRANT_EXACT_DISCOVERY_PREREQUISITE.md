# HIPPOCAMPUS_QDRANT_EXACT_DISCOVERY_PREREQUISITE

## Stato e scope

Data: 2026-07-16, Europe/Rome.

Il prerequisito BC-8 è `VERIFIED`. È stato aggiunto un provider Qdrant
read-only isolato capace di produrre il certificato BC-3
`EXACT_ABOVE_THRESHOLD_ENUMERATION_V1` tramite una singola Query API exact
bounded.

Non sono stati modificati `complete-link-greedy-v1`, threshold, minimum cluster
size, candidate graph, refiner, `searchNeighbors`, daemon, storage,
RecallRouter, synthesis, SuperMemoryRecord o commit. La coda legacy
`automation/fix_queue.json` non contiene BC-8 e non è stata modificata.

## Query Qdrant exact

Il transport `QdrantEmbeddingCacheProvider` espone ora il solo metodo
read-only aggiuntivo `queryPoints`. La request è chiusa e usa:

```text
POST /collections/{collection}/points/query
query: queryPointId
params.exact: true
score_threshold: 0.70
limit: maxHitsPerQuery + 1
with_payload: true
with_vector: false
```

Il filtro impone contemporaneamente:

- `schema_version`;
- `user_id_hash`;
- `embedding_model`;
- `embedding_revision`;
- `normalized:true`;
- esclusione del query point tramite `must_not.has_id`.

La query usa il point ID corrente e il vettore già conservato nella collection.
Il provider BC-8 non riceve né restituisce il query vector. Non esiste
paginazione multi-request.

Il transport accetta `exact` soltanto se è letteralmente `true` e restituisce
un'attestazione tecnica `exact:true`. Una risposta fake o transport
approssimata non può produrre certificati.

## Provider dedicato

`QdrantExactThresholdDiscoveryProvider` è costruito con dipendenze esplicite:

- transport Qdrant iniettato;
- user ID confinato nella closure;
- `CurrentEmbeddingIdentityIndex` dello stesso user;
- fingerprint snapshot BC-1;
- `maxHitsPerQuery`;
- `timeoutMs`;
- `maxResponseBytes`.

L'API pubblica contiene soltanto metadata bounded e `discoverNeighbors`. Non
espone health, collection lifecycle, retrieve, search top-k, create, upsert,
delete, provisioning, retry o fallback.

Timeout e response-byte budget devono coincidere con quelli del transport
iniettato. `maxHitsPerQuery` è obbligatorio e limitato esplicitamente a
1…4096.

## Verifica completa degli hit

Prima di emettere un certificato, ogni hit viene verificato contro
`CurrentEmbeddingIdentityIndex`:

- point ID UUID V5 corrente;
- memory ID corrente;
- content hash corrente;
- logical key hash ricostruito;
- user hash ricostruito;
- modello e revisione esatti;
- schema e `normalized:true`;
- score finito e `>= 0.70`;
- payload con shape EC-1 esatta;
- vector assente.

Self-hit viene escluso dal filtro e rimosso difensivamente. Point duplicati,
stale, foreign, provenance mismatch, point mismatch o payload malformed
producono `FAILED`, zero hit e nessun certificato.

Lo snapshot fingerprint e la query corrente vengono verificati prima
dell'accesso Qdrant. Snapshot o query mismatch producono zero chiamate al
transport.

## Cap e certificazione BC-3

Dopo tutte le verifiche:

- fino a `maxHitsPerQuery` hit unici:
  `COMPLETE_ABOVE_THRESHOLD` più certificato BC-3;
- `maxHitsPerQuery + 1` hit:
  `INCOMPLETE_TRUNCATED`, output limitato al cap e nessun certificato;
- più di cap+1, risposta non-exact, malformed, oversized, timeout, abort o
  failure transport:
  `FAILED`, zero hit e nessun certificato.

Il certificato lega:

- versione `hippocampus-threshold-discovery-certificate-v1`;
- mode `EXACT_ABOVE_THRESHOLD_ENUMERATION_V1`;
- snapshot fingerprint;
- query point ID;
- threshold 0.70;
- modello e revisione;
- `eligibleIdentityCount = identityIndex.size - 1`;
- numero di hit verificati;
- `exhausted:true`;
- `truncated:false`;
- `continuation:null`.

Il test di integrazione passa il provider direttamente a BC-2 e ottiene una
componente `AUTHORIZED_FOR_REFINEMENT` soltanto dopo che BC-3 ha validato tutti
i certificati.

## Determinismo, privacy e autorità

Gli hit sono ordinati canonicamente per point ID, score e memory ID. L'output è
profondamente immutabile e usa la shape BC-2/BC-3.

Output ed errori non contengono testo, vettori, endpoint, API key, user ID o
payload raw. Errori transport e record invalidi vengono convertiti in failure
sanitizzate senza retry.

Qdrant resta una cache tecnica non autorevole. Il provider accetta soltanto
identità già presenti nell'indice corrente costruito dalla fonte autorevole e
non legge o scrive memorie.

## Smoke

### Smoke sintetica read-only

La smoke con provider fake ha verificato:

- esattamente sei point sintetici;
- cap 5 e request limit 6;
- threshold 0.70;
- `exact:true`;
- certificato BC-3 valido;
- zero write;
- output sanitizzato.

Esito: `PASS`.

### Smoke Qdrant reale read-only

La smoke reale è stata eseguita una sola volta dopo test e regressioni verdi.
Ha caricato esclusivamente `HIPPOCAMPUS_QDRANT_URL`; non era presente una API
key e l'endpoint è stato accettato soltanto perché riconosciuto come rete
privata.

Risultato sanitizzato:

| Controllo | Risultato |
| --- | --- |
| collection | dedicata embedding cache V1 |
| point osservati | esattamente 6 sintetici EC-7 |
| dati reali letti | no |
| Query API | una singola query |
| exact | true |
| threshold | 0.70 |
| max hit / limit | 5 / 6 |
| hit sopra soglia osservati | 1 |
| certificato BC-3 | valido |
| write | 0 |
| collection nuova | nessuna |
| daemon/Qwen/SuperMemory/commit | nessuno |

Esito: `PASS`.

## Test e verifiche

| Verifica | Risultato |
| --- | --- |
| provider exact + smoke isolati | 18/18 PASS |
| transport Qdrant e path EC focalizzati | 55/55 PASS |
| regressioni BC-1→BC-6 | 115/115 PASS |
| regressioni EC-1→EC-8 | 148/148 PASS |
| suite repository completa, unica esecuzione serializzata | 669/669 PASS |
| fail / cancelled / skipped / todo | 0 / 0 / 0 / 0 |
| smoke sintetica read-only | PASS |
| smoke Qdrant reale read-only | PASS |
| syntax | PASS |
| privacy e shape | PASS |
| whitespace nello scope | PASS |
| import e API distruttive | PASS |

La suite completa ha eseguito il proprio benchmark repository già incluso; non
è stato rilanciato separatamente il benchmark bounded-clustering BC-6 40k.

## File

Aggiunti:

- `core/providers/vector/QdrantExactThresholdDiscoveryProvider.js`;
- `test/providers/qdrant-exact-threshold-discovery-provider.test.js`;
- `scripts/hippocampus-qdrant-exact-discovery-smoke.js`;
- `test/hippocampus/qdrant-exact-discovery-smoke.test.js`;
- `docs/contracts/HIPPOCAMPUS_QDRANT_EXACT_THRESHOLD_DISCOVERY_V1.md`;
- `docs/HIPPOCAMPUS_QDRANT_EXACT_DISCOVERY_PREREQUISITE.md`;
- `automation/logs/BC-8.log.md`;
- `automation/logs/BC-8.diff.md`.

Modificati in modo circoscritto:

- `core/providers/vector/QdrantEmbeddingCacheProvider.js`: Query API read-only
  e metadata dei budget;
- `test/providers/qdrant-embedding-cache-provider.test.js`: contract e request
  Query API;
- `docs/MEMORIA_ORBITALE_EVOLUTION.md`: append-only.

Esplicitamente invariati: `searchNeighbors`, cache adapter, BC-1→BC-6,
ClusterEngineAdapter, daemon, storage, RecallRouter, synthesis,
SuperMemoryRecord, server, configuration e dati.

## Verdetto unico

`EXACT_DISCOVERY_READY_FOR_BC8`
