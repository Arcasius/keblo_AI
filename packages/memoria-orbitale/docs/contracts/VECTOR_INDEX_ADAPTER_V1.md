# VECTOR_INDEX_ADAPTER_V1

## 1. Scopo e non-obiettivi

FIX 15 definisce record e adapter per un indice vettoriale opzionale. Non genera embedding, non crea collection, non implementa client Qdrant/rete, non sincronizza dataset e non integra RecallRouter o daemon.

## 2. JSON autorevole e indice derivato

JSON memoria/cluster resta l'unica fonte autorevole. L'indice è derivato, eliminabile e completamente ricostruibile. Un point mancante non elimina memoria; failure provider non modifica JSON; recall lessicale e dry-run Ippocampo funzionano senza adapter.

## 3. Vector kinds

I kind chiusi sono `memory_fragment`, `super_memory`, `cluster_centroid`. Non esistono alias o inferenze da type, orbitalLevel o memoryDepth.

## 4. Record e vettore

Il point V1 contiene schema, UUID, deduplication key, dimension, vector e payload chiuso. Il vector passa `ClusterMath.validateEmbedding`: array non vuoto di number finiti, norma non zero e dimensione coerente. Input/output sono separati e profondamente congelati.

## 5. Fingerprint numerico

`vector_fingerprint` è SHA-256 di `JSON.stringify(vector)`, la stessa serializzazione numerica canonica di ClusterMath. Non avvengono normalizzazione, rounding, padding o truncation.

## 6. User hash, dedup key e point ID

Il payload usa SHA-256 dell'userId normalizzato con trim; l'userId chiaro non è persistito. La dedup key include user hash, entity, kind, content hash, embedding model/version e, per centroidi, cluster/fingerprint.

Il point ID usa i primi 128 bit SHA-256 della key con bit UUID version 5 e variant RFC impostati. È deterministico; cambio content hash/model/version/kind produce un ID differente. Timestamp, endpoint e collection non partecipano.

## 7. Payload e privacy

Il payload versionato contiene soltanto user hash, entity/kind, memory/storage/processing state espliciti, consolidated, cluster, createdAt, source IDs, embedding provenance, content hash e vector fingerprint. Sono esclusi testo/content, title, facts, synthesis, prompt, snapshot, tag, entity, path e raw output.

## 8. Regole kind

Memory fragment richiede kind/tier/content hash espliciti. Super-memory richiede memoryKind super_memory, tier core, source non vuote e consolidated true. Cluster centroid richiede entity=cluster ID, source non vuote, content hash uguale al fingerprint e campi memory/tier/processing/consolidated esplicitamente null.

## 9. Provider contract

Il provider V1 espone ID e metodi async `getCollectionInfo`, `retrieve`, `upsert`, `search`, `delete`, tutti con AbortSignal. Non include endpoint, API key o configurazione globale. I test usano esclusivamente provider in-memory.

## 10. Collection validation

Prima di upsert/search l'adapter richiede collection esistente, dimensione esatta e distance coerente. Non crea collection. Provisioning resta attività infrastrutturale esplicita.

## 11. Upsert, replay e conflitto

Ogni point viene validato prima del provider. Retrieve verifica l'ID esistente: stessa key, fingerprint e payload è replay senza write; semantica diversa è conflitto senza overwrite. Response `ok/status` è obbligatoria.

## 12. Batch

`upsertMany` valida l'intero batch prima di scrivere, ordina per ID, rifiuta ID duplicati, recupera gli esistenti e invia soltanto i nuovi. Non esiste limite cinque o batching implicito. Il report non promette transazione provider.

## 13. Search e filtri

Search richiede vector, userId e limit positivo. Costruisce soltanto campi allowlisted: user hash, vector/memory kind, storage tier, processing, consolidated, cluster e range createdAt. Filtri arbitrari sono rifiutati. Lo score provider resta raw, incluso il range cosine negativo.

## 14. Delete e inspect

Delete accetta soltanto UUID espliciti e opera esclusivamente sul provider vettoriale. Non cancella JSON, cluster o processing. Inspect restituisce soli conteggi/ID trovati.

## 15. Timeout ed errori

Ogni call usa AbortController e race controllata, gestendo provider cooperativi e non cooperativi. Timer sempre pulito. Errori pubblici espongono codice/fase/status sintetico, mai vector, payload o messaggi provider completi.

## 16. Stale point e hydration futura

Un futuro retriever dovrà ricevere point ID, caricare il record dal JSON autorevole, confrontare contentHash, scartare point stale/mancanti e soltanto allora produrre risultati per RecallRouter. FIX 15 non implementa tale hydration.

## 17. Futuro provider Qdrant e rebuild

Un provider Qdrant futuro dovrà adattare il contratto senza trasferire endpoint nell'adapter e senza creare collection implicitamente. Rebuild significa rileggere JSON, ottenere embedding da un provider separato autorizzato e ricreare point deterministici; nessun sincronizzatore automatico è incluso.

## 18. Garanzie, non-garanzie e Activation Gate

Sono garantiti determinismo, privacy payload, validazione collection, replay/conflict, timeout e assenza di scritture JSON. Non sono garantiti disponibilità Qdrant, consistenza transazionale col JSON, qualità embedding, hydration o attivazione reale. Provider reali, collection e dataset DEV appartengono al successivo `HIPPOCAMPUS ACTIVATION GATE`, non avviato dal FIX 15.
