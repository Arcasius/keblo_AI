# CONSOLIDATION_PLAN_V1

## 1. Scopo

Il FIX 5 definisce una selezione pura e un piano di consolidamento esclusivamente read-only. `selectConsolidationCandidates()` classifica memorie già caricate; `buildConsolidationPlan()` trasforma il risultato in un artifact dry-run deterministico, privato e immutabile. Il piano descrive possibilità future: non autorizza alcun commit presente o futuro.

## 2. Non-obiettivi

Il V1 non legge o scrive storage, non modifica memorie o `processingState`, non promuove o archivia raw, non crea cluster, non chiama Qwen/Ollama, non calcola maturità e non implementa state machine, batching, daemon, lock o transazioni.

## 3. Input e normalizzazione

Il selector accetta un array di plain memory object oppure una plain object map indicizzata per ID, come lo storage reale. Rifiuta contenitori ambigui, `null`, `undefined`, primitive top-level, cicli e dati non JSON-like; entry JSON-like che non sono plain memory object ricevono `INVALID_MEMORY`. Numeri non finiti, funzioni, simboli, `BigInt`, classi e oggetti speciali non sono JSON-like.

Ogni plain memory object passa obbligatoriamente attraverso la proiezione validata
`projectMemoryForCandidateSelection()` di `MemoryContractNormalizer`. La proiezione
condivide il riconoscimento flat/nested/hybrid del normalizzatore, ma non crea il
costoso `sourceSnapshot`: conserva solo i campi necessari alla decisione e il testo
soltanto fino al calcolo del suo SHA-256. Nessun input viene mutato e il contratto
pubblico di `normalizeMemory()` resta invariato.

## 4. Decisioni e reason code

Le decisioni stabili sono:

- `eligible`: policy esplicita soddisfatta per una futura considerazione;
- `excluded`: informazione esplicita o duplicato impedisce la candidatura;
- `deferred`: informazione insufficiente o decisione appartenente a un fix futuro.

I reason code V1 sono:

| Code | Significato |
|---|---|
| `ELIGIBLE_EXPLICIT` | `memoryKind`, `storageTier` e `processingState` espliciti e supportati dalla policy V1 |
| `ELIGIBLE_LEGACY_OPT_IN` | legacy ammessa soltanto tramite opt-in visibile |
| `INVALID_MEMORY` | entry JSON-like non interpretabile come plain memory object |
| `MISSING_ID` | ID assente, non stringa o stringa vuota |
| `EMPTY_CONTENT` | testo assente, `null`, non stringa o stringa esattamente vuota |
| `DUPLICATE_ID` | occorrenza successiva dello stesso ID |
| `DUPLICATE_CONTENT` | occorrenza successiva dello stesso testo UTF-8 esatto |
| `EXPLICIT_SUPER_MEMORY` | `memoryKind: super_memory` |
| `EXPLICIT_DEEP_TIER` | `storageTier: deep` |
| `EXPLICIT_CONSOLIDATED` | `processingState: consolidated` |
| `EXPLICIT_SYNTHESIZING` | `processingState: synthesizing` |
| `EXPLICIT_CANDIDATE_ALREADY_CLAIMED` | `processingState: candidate`, già acquisita e quindi non riselezionabile |
| `EXPLICIT_FAILED_REQUIRES_RETRY` | `processingState: failed`, rinviata a una retry policy esplicita |
| `UNSUPPORTED_PROCESSING_STATE` | stato non appartenente al vocabolario canonico V1 o classificazione futura parziale |
| `LEGACY_UNCLASSIFIED` | tutti i tre campi futuri sono assenti/null nella vista normalizzata |
| `LIMIT_EXPLICITLY_APPLIED` | candidata oltre un limite richiesto esplicitamente |

I messaggi testuali non sostituiscono questi codici.

## 5. Policy conservativa e legacy

La policy V1 è `{ policyVersion: 1, allowLegacyUnclassified: false, maxCandidates: null }`. Sono eleggibili esplicite le combinazioni con `memoryKind` tra `raw`, `episodic`, `semantic`, `structural`, `storageTier` tra `core`, `warm` e `processingState: raw`, salvo una regola di esclusione precedente.

Una memoria senza tutti i tre campi futuri non viene interpretata come raw: è `deferred/LEGACY_UNCLASSIFIED`. Solo `allowLegacyUnclassified: true` la rende `eligible/ELIGIBLE_LEGACY_OPT_IN`. L'opzione appare in selection result e piano, non aggiunge campi alle memorie e non cambia stato.

Il vocabolario canonico FIX 6 è `raw`, `candidate`, `synthesizing`, `consolidated`, `failed`. `candidate` è rinviato perché già acquisito; `failed` richiede retry esplicito; `synthesizing` e `consolidated` sono esclusi; stati sconosciuti o classificazioni parziali sono rinviati con `UNSUPPORTED_PROCESSING_STATE`. Il selector usa `PROCESSING_STATES` ma non crea, modifica o deduce processing.

## 6. Nessun limite predefinito

`maxCandidates: null` significa nessun limite: 12, 100 o più candidate possono essere incluse. Non esiste top-five implicito. Un `maxCandidates` esplicito deve essere intero positivo; le candidate oltre il limite diventano `deferred/LIMIT_EXPLICITLY_APPLIED`, restano nel report e contribuiscono ai conteggi. `eligibleBeforeLimit`, `eligibleIncluded` e `truncated` rendono l'effetto verificabile.

La candidate selection generale è distinta dal batching del prompt di sintesi.
Dal FIX 22, `batchSize` controlla solo il lavoro operativo della API scalabile e
non equivale a `maxCandidates`: non elimina, rinvia o tronca record.

## 7. Deduplica esatta

L'ordinamento stabile usa `memoryId` e un indice di disambiguazione; per object map usa inoltre fingerprint e chiave ordinati, rendendo irrilevante l'ordine delle proprietà. La prima occorrenza deterministica di un ID resta classificabile, le successive sono `DUPLICATE_ID`.

Il contenuto è deduplicato con SHA-256 built-in sul testo esatto UTF-8. Non avvengono trim, case folding, normalizzazione Unicode, correzione, stemming, compressione spazi o confronto semantico. Testi diversi per un solo byte sono diversi. Stringa esattamente vuota, `null`, testo assente e valori non stringa sono `EMPTY_CONTENT` e non entrano nella deduplica. Il testo non viene conservato nel risultato o nel piano.

## 8. Selection result e statistiche

```js
{
  policy,
  decisions: [{
    memoryId, sourceContract, decision, reasonCodes, contentHash,
    timestamp, memoryKind, storageTier, processingState, disambiguationIndex
  }],
  eligibleIds,
  excludedIds,
  deferredIds,
  stats: {
    inputCount, validCount, eligibleBeforeLimit, eligibleIncluded,
    excludedCount, deferredCount, duplicateIdCount,
    duplicateContentCount, truncated
  }
}
```

Ogni entry riceve una sola decisione finale; i conteggi non la contano due volte.

## 9. Piano, privacy e immutabilità

```js
{
  schemaVersion: 1,
  planId,
  dryRun: true,
  policyVersion,
  policy,
  candidateIds,
  decisions,
  stats
}
```

Il piano contiene solo descrittori tecnici. Sono vietati testo raw, `sourceSnapshot`, entities private, meta, payload originali, snippet e prompt. Il builder copia il selection result e congela profondamente il piano: non condivide riferimenti mutabili con input, memorie normalizzate o selection result.

`dryRun` è sempre `true`. Il builder rifiuta ogni opzione di esecuzione, inclusi `commit`, write callback, writer o `dryRun: false`.

## 10. Determinismo e planId

A parità di input, policy e versione, ordinamento, decisioni, hash, statistiche e output sono identici. Non vengono generati tempo corrente o valori casuali. `planId` è SHA-256 di una serializzazione canonica di schema version, policy version, policy/opzioni rilevanti, candidate ID, descrittori/decisioni ordinate, statistiche e `dryRun`. Il riordino della stessa object map non lo cambia.

## 11. Validazione

`validateConsolidationPlan()` restituisce `{ valid, errors }` e controlla plain data aciclica, schema, `dryRun === true`, planId, policy version, ID candidati univoci, decisioni e reason code noti, coerenza dei conteggi, corrispondenza candidati/eligible, assenza di campi privati o di commit/write e ricalcolo del planId. Un piano manomesso viene rifiutato.

## 12. Capability e decisioni rinviate

Il core V1 non importa né accede allo storage. Un futuro runner che caricherà memorie dovrà richiedere esclusivamente `memory.readAll` tramite `StorageCapabilityContract` per produrre questo piano. Non servono `memory.writeOne`, `memory.writeAll`, `commit.atomic`, lock o rollback.

Segnali di `MemoryLifecycle`, Echo, densità, affinità, maturità, clustering, prompt batching e provenance non sono obbligatori e restano rinviati. Le transizioni sono definite da `PROCESSING_STATE_CONTRACT_V1`, ma questo piano non le esegue né le autorizza.

## 13. Garanzie e non-garanzie

Il V1 garantisce classificazione locale pura, ragioni stabili, deduplica esatta, privacy strutturale, determinismo, immutabilità e dry-run. Non garantisce opportunità semantica del consolidamento, maturità, qualità di cluster o sintesi, autorizzazione a scrivere, commit futuro, persistenza, recovery o idempotenza.

## 14. Estensione di scala FIX 22

Le API legacy sincrone restano disponibili e semanticamente invariate. La pipeline
di scala aggiunge:

- `selectConsolidationCandidatesScalable(memories, options)`;
- `buildConsolidationPlanScalable(memories, options)`;
- `DEFAULT_CANDIDATE_SCALE_OPTIONS` e versioni algoritmo esplicite.

Le opzioni operative chiuse sono `batchSize`, `budget` e `signal`, oltre alla
policy esistente. Il default V1 è batch da 500 record, 9.500 ms e 128 MiB di RSS
incrementale. Il budget è osservativo: `budgetExceeded` non cambia decisioni e
non produce output parziale. Un abort tra batch rifiuta l'intera operazione.

La deduplica ID/contenuto resta globale fra batch. Array, object map, ordine input
e batch size differenti producono le stesse decisioni, statistiche, candidate e
lo stesso `planId`. La telemetria include solo contatori, tempo, RSS, budget e
versione algoritmo; non contiene ID, testo, hash, utente o path e non entra mai
nel calcolo del `planId`. Il contratto completo e il runner riproducibile sono in
`HIPPOCAMPUS_SCALE_BUDGET_V1.md`.
