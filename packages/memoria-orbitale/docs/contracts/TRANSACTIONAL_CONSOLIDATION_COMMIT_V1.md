# TRANSACTIONAL_CONSOLIDATION_COMMIT_V1

## 1. Scopo e non-obiettivi

Il FIX 10 definisce il commit controllato che inserisce una super-memory e aggiorna tutte le source del cluster nello stesso file memoria, sotto un lock per utente. Il commit valida cluster, sintesi, transition plan e optimistic precondition, preserva i raw, verifica la scrittura e supporta replay idempotente e rollback circoscritto.

Il V1 non modifica cluster, non integra chat, RecallRouter o daemon, non chiama modelli, non migra dati, non implementa journal, recovery dopo crash, stale-lock recovery o una transazione multi-file generale. FIX 11 non è iniziato; crash/stale recovery resta al FIX 14.

## 2. File lock manager

`FileLockManager` usa soltanto moduli built-in. Ogni lock key viene trasformata in SHA-256 e il file `<hash>.lock` viene creato con apertura esclusiva `wx` e permessi `0600`. Nome e contenuto non includono user ID, memoria o payload; il contenuto contiene soltanto versione, token UUID operativo e owner operativo.

Acquisizione supporta timeout e retry interval positivi. `release()` accetta soltanto un handle emesso dalla stessa istanza, verifica token e owner persistiti, rifiuta handle estranei, ownership persa e doppia release. `withLock()` rilascia in `finally` sia su successo sia su errore.

`Date.now()` e `randomUUID()` sono usati esclusivamente per coordinamento lock. Non partecipano a ID, timestamp o fingerprint di memorie, cluster, sintesi o transazioni.

## 3. Stale lock e crash window

Il V1 non rimuove automaticamente lock file preesistenti. Un crash tra acquire e release può lasciare un lock stale che provoca timeout ai writer successivi. TTL, owner liveness, quarantine, recovery e audit degli stale lock appartengono al FIX 14. La mancata rimozione automatica è una scelta conservativa: il FIX 10 non può distinguere in modo sicuro un lock stale da un writer lento ancora valido.

## 4. Integrazione nei writer storage

`JsonMemoryStorage` espone `acquireLock(userId)`, `releaseLock(handle)` e `withUserLock(userId, callback)`. Tutti i writer `saveMemory`, `saveMemories`, `deleteMemory`, `saveLink`, `saveLinks`, `saveCluster` e `deleteCluster` condividono la stessa lock key logica per utente, indipendentemente dal kind del file.

Le firme legacy senza options restano operative. L'ultimo options object può contenere soltanto `{ lockHandle }`: il writer verifica manager e user key e non acquisisce un secondo lock. Questo consente alla transazione di mantenere il lock mentre chiama `saveMemories` senza deadlock. I reader restano lock-free e osservano il file completo precedente o successivo grazie al rename atomico.

## 5. Super-memory V1

La super-memory contiene schema/ID/user, `type` e `memoryKind: super_memory`, `storageTier: core`, content sintetico validato, processing consolidated revision zero, source usate/rifiutate, cluster linkage, metadata synthesis/provider, provenance per fingerprint cluster e hash source, idempotency key, semantic fingerprint e timestamp esplicito.

Non contiene raw source text, `sourceSnapshot`, prompt, messages, raw response, embedding completo, activation/orbita/lastAccess inventati o callback. `MemoryContractNormalizer` usa un fallback circoscritto da `processingState` a `processing.state`, quindi riconosce la super-memory come consolidated senza cambiare la precedenza del campo legacy esplicito.

## 6. Provenance e source rifiutate

Le source usate e rifiutate sono disgiunte e coprono esattamente `clusterRecord.source_memory_ids`. Ogni used source passa `synthesizing → consolidated`. Ogni rejected source passa `synthesizing → failed` con errore stabile `SYNTHESIS_SOURCE_REJECTED`, non viene mai marcata consolidated e non riceve metadata che affermino un consolidamento riuscito.

La super-memory conserva source ID e content hash della sintesi validata. La provenance prova identità, copertura e linkage strutturale, non accuratezza fattuale perfetta.

## 7. Identità e fingerprint super-memory

L'idempotency key SHA-256 include user, cluster record fingerprint, synthesis request ID, source usate/rifiutate, provider/modello/versione, prompt version e fingerprint dell'output validato. Esclude `committedAt`. L'ID è `sm_<key>`.

Il record fingerprint include content sintetico, processing semantico, source, cluster, synthesis/provenance e idempotency key. Esclude `timestamp` e `processing.updated_at`; un retry equivalente con timestamp diverso mantiene ID, key e fingerprint. Include attempt ID e revision, quindi un tentativo semanticamente incompatibile non viene nascosto.

## 8. Transaction plan

`createConsolidationCommitPlan()` richiede user, cluster record, synthesis result, esattamente un transition plan per ogni source, committedAt e processing attempt ID espliciti. Cluster e synthesis vengono rivalidati e devono coincidere per cluster ID/fingerprint e copertura source.

Il piano contiene schema, transaction ID, user, cluster/fingerprint, synthesis request ID, super-memory, transition plan ordinati, descrittori delle precondition e committedAt. `transactionId` è SHA-256 deterministico dell'intero significato del piano. Il piano è plain, copiato, profondamente congelato e privo di raw source, prompt, storage e callback.

## 9. Optimistic concurrency

Prima della scrittura, ogni source deve esistere e il processing persistito deve coincidere con `fromState`, `expectedRevision`, `expectedUpdatedAt` ed `expectedAttemptId`. Un solo mismatch interrompe l'intera transazione prima della write. Nessuna transition viene applicata parzialmente.

Ogni transition deve partire da `synthesizing`, conservare lo stesso attempt ID, incrementare revision di uno e usare `committedAt` come `nextProcessing.updated_at`. Used e rejected devono avere il ruolo previsto dall'output synthesis.

## 10. Snapshot RAM e raw preservation

Sotto lock, il commit carica una sola volta l'array memoria e crea una object map snapshot completamente separata. Il fingerprint snapshot è SHA-256 di serializzazione canonica. La next map nasce da una deep copy; snapshot e input non vengono mutati.

Per ogni raw source vengono conservati integralmente content, timestamp, tags, activation, orbitalState, orbitalLevel, memoryDepth, dualState, meta e campi sconosciuti. Cambia soltanto `processing`; le used ricevono un metadata `consolidation` V1 minimo con transaction, super-memory, cluster e synthesis request ID. Le rejected conservano il failure nel processing e non ricevono metadata consolidated. Nessuna source viene cancellata, spostata o compressa.

## 11. Singolo atomic memory commit

Super-memory e source aggiornate vengono inserite nella stessa next memory object map e passate una sola volta a `JsonMemoryStorage.saveMemories(..., { lockHandle })`. Il write termina in `atomicWriteJson()` e sostituisce un solo file `<user>_memories.json`. Il cluster file non viene letto né modificato dal commit.

Questo è un commit atomico a singolo file memoria, non una transazione multi-file generale. `commit.atomic` mantiene il significato storico del FIX 4.

## 12. Verifica post-commit

Dopo la write, mentre detiene ancora il lock, la transazione rilegge la memory map, ne confronta il fingerprint con la next map e rivalida super-memory e processing di tutte le source. Il report restituito viene prodotto soltanto dopo questa verifica.

## 13. Rollback circoscritto

Se la verifica post-commit fallisce, la transazione riscrive lo snapshot RAM precedente con lo stesso lock handle e verifica il fingerprint ripristinato prima di rilasciare il lock. Questo rollback copre soltanto il file memoria e soltanto una failure osservata dopo il commit nello stesso processo ancora vivo.

Non è la capability storage `rollback`, non è snapshot API, journal, crash recovery o rollback multi-file. Se riscrittura o verifica del ripristino falliscono, viene restituito `ROLLBACK_FAILED_STATE_UNKNOWN` con committed state `unknown`, senza falsa rassicurazione.

## 14. Replay idempotente

Se l'ID super-memory esiste, record, key e semantic fingerprint devono coincidere. Tutte le used source devono essere consolidated con revision/attempt e metadata verso la stessa super-memory/transaction; tutte le rejected devono essere failed con processing previsto. Solo allora il replay restituisce `committed: false`, `idempotentReplay: true` senza write, duplicato o incremento revision.

Un record o source incompatibile produce conflitto prima della scrittura.

## 15. Capability

Dopo i test FIX 10, `lock.acquire` e `lock.release` sono `supported/verified`. Il commit richiede `memory.readAll`, `memory.writeAll`, `commit.atomic`, `lock.acquire` e `lock.release` tramite `StorageCapabilityContract`.

Snapshot create/verify/restore e rollback storage generale restano `unsupported`. Non viene dichiarata una capability transazione multi-file.

## 16. Report e privacy

Il report contiene transaction ID, super-memory ID, flag committed/replay, conteggi source, fingerprint snapshot/post-commit e rollback flag. Non contiene content, testo synthesis, prompt, raw output, object map, lock token o path.

Gli errori possono indicare phase, codici e soli source ID coinvolti. Non includono raw memory, synthesis text o snapshot.

## 17. Garanzie e non-garanzie

Il V1 garantisce esclusione tra writer dello stesso utente finché il processo coopera col lock file, optimistic preconditions, preservazione raw, used/rejected distinti, singolo atomic memory commit, verifica post-write, replay idempotente e rollback circoscritto nello stesso processo.

Non garantisce stale-lock recovery, crash recovery dopo rename, journal persistente, lock distribuito su filesystem senza semantica `wx` affidabile, transazione memoria+cluster, rollback generale, retry automatico, daemon, recall integration o qualità fattuale della sintesi. Queste decisioni restano al FIX 14 o a interventi successivi.

## 18. Precondizione content hash post-FIX 13

Prima di replay o write finale, il commit normalizza ogni source e calcola SHA-256 sul testo UTF-8 esatto. L'hash deve coincidere con la entry corrispondente di `SynthesisResult.sourceContentHashes`, trasportata in `superMemory.provenance.source_content_hashes`. Un mismatch produce `SOURCE_CONTENT_HASH_MISMATCH` prima della scrittura, senza testo nel messaggio e senza super-memory o transizioni parziali.

## 19. Recovery post-FIX 14

Il commit memoria resta atomico a singolo file e non include atomicamente il journal. Se il commit è valido ma l'evento successivo manca, RecoveryManager riconcilia verificando super-memory e source e registra il successo senza riscrivere il dataset. Non viene eseguito rollback di un commit valido per una failure del journal.

## 20. Confine recovery sotto user lock post-FIX 19

L'esecuzione mutante di un recovery plan usa la stessa lock key logica per utente
dei writer `JsonMemoryStorage`. Memoria e cluster vengono riletti e confrontati
con i fingerprint del piano soltanto dopo l'acquisizione; tutte le primitive
memory ricevono lo stesso handle e non acquisiscono lock annidati. Di
conseguenza nessun writer cooperante memory, link o cluster può intervenire tra
precondition e verifica finale.

Questo non amplia `commit.atomic`: una recovery non è una transazione generale
multi-file. Il rollback circoscritto copre soltanto mutazioni memory osservate
nello stesso processo e sotto lo stesso lock. Gli ACK journal vengono appesi
dopo la release; una loro failure richiede riconciliazione storage-first e non
inverte dati già validi.
