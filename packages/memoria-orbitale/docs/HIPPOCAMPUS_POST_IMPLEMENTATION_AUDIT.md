# HIPPOCAMPUS_POST_IMPLEMENTATION_AUDIT

## Executive verdict

- **Verdict:** `NOT_READY`.
- **Data:** 2026-07-13 (Europe/Rome).
- **Scope:** audit indipendente e non correttivo dei FIX 1–15, integrazione recall, pipeline Ippocampo, journal/recovery, storage e vector adapter.
- **Test:** 285/285 pass, 0 fail, 0 skip, 0 todo; durata TAP 7,40 s (8,13 s wall con `/usr/bin/time`). Tutti i JavaScript di produzione coinvolti superano `node --check`.
- **Dati invariati:** sì; 11 file runtime/backup/diagnostici controllati prima e dopo per path, size, mtime e SHA-256.
- **Finding:** P0 0, P1 4, P2 4, P3 2.
- **Sintesi blocker:** commit reale è ancora disabilitato e quindi non esiste rischio immediato ai dati, ma recovery e journal non sono affidabili per run multi-cluster, l'esecuzione recovery non mantiene una precondizione atomica sotto user lock, gli eventi di failure non chiudono coerentemente i run e il journal può persistere l'userId in chiaro. In base ai criteri richiesti, recovery non affidabile implica `NOT_READY`, anche con suite verde.
- **Significato:** il verdetto non nega la qualità dei contratti isolati e non autorizza attivazione. Provider reali, dry-run DEV e canary appartengono all'Activation Gate, che non è iniziato.

## 1. Baseline e worktree

Baseline:

- root: `/home/francesco/MemoriaOrbitale/Memoria_Orbitale_Autonomo`;
- branch/worktree già sporco prima dell'audit;
- tracked modificati preesistenti: `chat_orbitale_ollama.js`, `core/JsonMemoryStorage.js`, `core/Keblomemory.js`, `core/OrbitaleBridge.js`;
- FIX 1–15, contratti, test, Evolution Log e prototipi risultano in larga parte non tracciati;
- `git diff --check` baseline segnala whitespace preesistente in `chat_orbitale_ollama.js` (righe 206, 535, 537, 542, 793, 794, 799, 810 nel diff);
- `git diff --stat` baseline sui soli tracked: 4 file, 418 inserimenti, 61 rimozioni.

La quantità di file non tracciati costituisce rischio concreto di perdita o esclusione accidentale: l'intera queue FIX 1–15 non è protetta da un checkpoint Git verificabile. L'audit non ha eseguito commit.

Classificazione:

| Categoria | Evidenza |
|---|---|
| FIX 1–15 | `core/{clustering,consolidation,hippocampus,locking,recall,synthesis,vector}`, i tre moduli foundation, `docs/contracts`, `test` |
| Runtime integrato | chat, `Keblomemory`, `OrbitaleBridge`, `JsonMemoryStorage` |
| Legacy | moduli core storici, script diagnostici, Python |
| Prototipi | `hyppocampus.js`, `hyppocampo_Jace.js`, `testhyppo.js` |
| Dati reali | `orbitale_chat_data`, `keblo_data`; backup e directory diagnostiche inclusi nel controllo integrità |
| Documentazione | Evolution Log, contratti, audit Delta 0, roadmap/checkpoint |
| Test | 15 file `*.test.js`, fixture sintetiche |

Sono stati identificati 11 file dati senza stamparne il contenuto. Dimensione aggregata circa 112 MB; nel report sono omessi gli hash completi. La baseline locale conserva path, size, mtime e SHA-256 integrali esclusivamente per il confronto finale.

## 2. Inventario FIX 1–15

| Fix | Moduli | Contratto | Test | Runtime integration | Stato verificato | Finding |
|---|---|---|---|---|---|---|
| 1 | fixture V1 | ORBITAL_MEMORY | fixture contract | no | presente/testato | nessuno |
| 2 | MemoryContractNormalizer | ORBITAL_MEMORY | normalizer | usato dai nuovi confini | presente/testato | P3-001 log storico non allineato |
| 3 | StorageCapabilityContract | STORAGE_CAPABILITY | capability | usato da transazioni/daemon | presente/testato | nessuno |
| 4 | AtomicJsonCommit | ATOMIC_JSON_COMMIT | atomic/storage | JsonMemoryStorage | presente/testato | nessuno |
| 5 | CandidateSelector, ConsolidationPlan | CONSOLIDATION_PLAN | read-only plan | daemon | composto | P2-003 scala monolitica |
| 6 | ProcessingState | PROCESSING_STATE | processing | claim/commit | composto | nessuno |
| 7 | ClusterMath, ClusterEngineAdapter | CLUSTER_ENGINE_ADAPTER | clustering | daemon | composto con mock | provider reale assente, atteso |
| 8 | ClusterRecord + storage CRUD | CLUSTER_PERSISTENCE | persistence | daemon | composto | nessuno |
| 9 | SynthesisContract/Engine | SYNTHESIS_ENGINE | synthesis | daemon | composto con mock | provider reale assente, atteso |
| 10 | lock, SuperMemory, transaction | TRANSACTIONAL_COMMIT | transaction | daemon | composto | recovery esterna problematica |
| 11 | RecallRouter | RECALL_ROUTER | read-only router | FIX 12 | composto | nessuno |
| 12 | classifier, adapter, builder | RECALL_ROUTER_INTEGRATION | integration | chat/Keblo/bridge | composto | nessuno P0/P1 |
| 13 | maturity, claim, daemon | HIPPOCAMPUS_DAEMON | daemon | non bootstrap runtime | composto con mock | P1-003 |
| 14 | journal, recovery, stale lock | HIPPOCAMPUS_RECOVERY | recovery | daemon commit preflight | non affidabile end-to-end | P1-001/002/004, P2-001/002 |
| 15 | VectorIndexRecord/Adapter | VECTOR_INDEX_ADAPTER | vector | volutamente isolato | contratto isolato/testato | P2-004 |

Tutti i file dichiarati esistono, gli import dei moduli side-effect-free sono risolvibili e gli export minimi sono disponibili. Il require controllato di 29 moduli non ha avviato runtime né prodotto scritture. `JsonMemoryStorage` esporta la classe come default CommonJS e `ClusterStorageError` come proprietà, coerente con i chiamanti.

L'Evolution Log dichiara tutti i fix `COMPLETED`; l'audit conferma presenza e test, ma non conferma la readiness complessiva dei FIX 13–14. Il completamento documentale non sostituisce la composizione multi-cluster e crash recovery.

## 3. Architettura runtime reale

### Recall

Flusso chat reale:

```text
chat_orbitale_ollama
  -> singleton RecallRouter creato nel bootstrap
  -> RecallRequestBuilder
  -> LegacyRecallAdapter core/warm/deep
  -> KebloMemory.recallReadOnly(mutateOnRecall=false, tier)
  -> RecallRouter merge/dedupe/suppression/rank/limit
  -> KebloMemory.reinforceRecallSelection una volta
  -> context/prompt
```

Evidenze:

- chat crea un solo router e lo registra (`chat_orbitale_ollama.js:31-32`);
- `getContextForKeblo` usa il router registrato e non richiama legacy dopo il risultato (`core/Keblomemory.js:878-888`);
- adapter usa esclusivamente `recallReadOnly`, `mutate:false` e tier esplicito (`core/recall/LegacyRecallAdapter.js:39-56`);
- filtro tier è applicato prima dei candidati e nuovamente dopo scoring/link (`core/Keblomemory.js:559-567`, `667-671`);
- un link verso deep non riceve base score nel retriever warm e non reintroduce il record;
- router default core+warm, deep solo `includeDeep`, `full-history` o fallback esplicito;
- classificazione: deep/historical legacy -> deep, `memoryDepth:core` -> warm legacy; orbitalLevel non decide (`MemoryTierClassifier.js:29-49`);
- reinforcement deduplica gli ID finali e salva batch; super-memory è esclusa (`Keblomemory.js:712-757`);
- il fallback senza router resta legacy e mutante per retrocompatibilità, ma non esegue una doppia recall nello stesso percorso (`Keblomemory.js:889-894`);
- i limit 3/5/10/20 sono decisioni dei caller, non capacità del router.

`OrbitaleBridge` crea un router una sola volta per la propria istanza e lo registra sulla stessa `KebloMemory`; rifiuta un secondo user. Non condivide l'istanza della CLI chat, perché è un entry point distinto, ma usa la stessa pipeline e gli stessi contratti.

### Hippocampus

Flusso implementato:

```text
JsonMemoryStorage.loadMemories
 -> CandidateSelector
 -> ConsolidationPlan
 -> ClusterEngineAdapter
 -> MaturityGate
 -> ClusterRecord + saveCluster (commit only)
 -> SourceClaimTransaction
 -> SynthesisEngine (fuori lock)
 -> ConsolidationTransaction
 -> SuperMemoryRecord + source transitions nello stesso memory file
 -> journal ACK / RecoveryManager preflight
```

Il daemon non è registrato in chat/server e non si auto-avvia. È istanziabile con storage e mock, ma non esistono nel repository provider embedding/modello reali conformi né bootstrap DEV. È quindi “collegabile con dipendenze iniettate”, non “operativo in DEV”.

## 4. Producer/consumer compatibility

| Producer | Output | Consumer | Validazione | Compatibile |
|---|---|---|---|---|
| Normalizer | canonical camelCase + sourceSnapshot | selector/classifier/synthesis | plain/JSON-like | sì |
| CandidateSelector | selection, decisions, contentHash | ConsolidationPlan | closed/deterministic | sì |
| ConsolidationPlan | candidateIds/decisions/planId | ClusterEngineAdapter | validate plan | sì |
| ClusterEngineAdapter | clusterCandidate camelCase | MaturityGate/ClusterRecord | structural + math | sì |
| ClusterRecord | persisted snake_case V1 | SynthesisEngine/SuperMemory | validateClusterRecord | sì |
| SourceClaimPlan | sources + claimedProcessing | claim/fail/daemon | validate plan | sì |
| SynthesisEngine | result camelCase, output snake_case | transaction/super-memory | validateSynthesisResult | sì |
| ProcessingState | transition camelCase + nextProcessing snake_case | transaction | validate transition | sì |
| SuperMemoryRecord | canonical memory + provenance | normalizer/recall/storage | strict validator | sì |
| ConsolidationTransaction | sanitized report | daemon/journal | report fields | sì |
| Daemon events | run-level JSONL events | Journal/Recovery | schema closed ma ricostruzione run-level | **no per multi-cluster** |
| Journal | incomplete runs raggruppati per runId | RecoveryManager | type-presence heuristic | **no, P1-001** |
| Vector adapter | point IDs/payload | futuro hydrator | strict point, no hydration | isolato intenzionalmente |

I principali bridge camelCase/snake_case sono espliciti. Timestamp memoria sono integer epoch; cluster e processing usano snake_case; request/result envelope usano camelCase. Non è emerso un mismatch nella pipeline happy path coperta dai test. La rottura è nel modello journal: il daemon processa più cluster sotto un singolo `run_id`, mentre `findIncompleteRuns()` riduce l'intero run a una sola classificazione basata sulla presenza di event type.

## 5. Contratti memoria

- Flat, nested e hybrid sono normalizzati senza mutazione; precedenza flat usa presenza strutturale e preserva `0`, `null`, `false`, stringa vuota e timestamp storici.
- Unknown fields sono conservati in `sourceSnapshot` dal normalizzatore, ma i componenti privacy-sensitive estraggono viste chiuse.
- Super-memory è flat/canonica: `memoryKind=super_memory`, `storageTier=core`, processing consolidated; viene letta da normalizzatore e RecallRouter.
- CandidateSelector esclude esplicitamente super-memory, deep, consolidated e synthesizing (`CandidateSelector.js:160-184`), quindi una super-memory non viene ricandidata.
- Source raw sono clonate e preservate; la transaction sostituisce processing e aggiunge metadata di consolidamento solo alle used (`ConsolidationTransaction.js:300-317`).
- Rejected diventano failed e non ricevono metadata consolidated.
- Commit source richiede processing raw esplicito; legacy senza processing è rifiutata (`SourceClaimTransaction.js:45-49`).
- ColdMemoryCompressor non è importato dalla pipeline Ippocampo. Rimane importato/istanziato nel runtime Keblo legacy, quindi è isolato rispetto al commit Ippocampo, non risolto globalmente.
- I nuovi moduli critici usano nullish/presenza strutturale; i numerosi `||` legacy in Keblo restano debito storico e possono perdere configurazioni zero, ma non sono stati introdotti nel percorso transazionale.

## 6. Storage, atomicità e lock

`AtomicJsonCommit` realizza temp `wx` nella stessa directory, fsync temp, parse/validator, backup temp validato, rename backup, rename finale, fsync directory e cleanup (`AtomicJsonCommit.js:153-299`). Un errore dopo rename espone `committed=true` nell'errore. Il commit è correttamente dichiarato atomico per singolo file, non multi-file.

`JsonMemoryStorage` conserva object map e tutti i writer memory/link/cluster passano da `_withWriteLock` e `_writeJson` (`JsonMemoryStorage.js:135-141`, `162-318`). Un `lockHandle` è verificato dal manager e dalla chiave user. I test concorrenti coprono memory/link/cluster senza lost update tra writer cooperanti.

`FileLockManager` usa filename SHA-256, `wx`, token/owner, timeout, retry e verifica ownership. Recovery stale richiede metadata valida, host locale, PID morto, età e fingerprint invariato; PID vivo o host differente sono bloccati (`FileLockManager.js:157-199`). Snapshot e rollback generale restano unsupported.

Write-path classification:

| Path | Classificazione |
|---|---|
| JsonMemoryStorage memory/link/cluster | lock user + atomic single-file |
| SourceClaim/ConsolidationTransaction | lock user + saveMemories atomico |
| HippocampusJournal | journal lock separato + append/fsync |
| MemoryEventLogger | JSONL legacy separato, append diretto |
| LinkManager/RetrievalBias/maintenance/compressor/orbital | passano da storage writer cooperante |
| prototipi `hyppocampus*.js` | writeFileSync diretto, isolati/non importati |
| import/sync/visualize/automation | tool operativi esterni al runtime Ippocampo |

Non emerge un bypass diretto ai file memory/link/cluster nella nuova pipeline. Il problema di lock è nella recovery: manca il lock esterno che renda atomici recheck e sequenza di azioni (P1-002).

## 7. Transazioni e idempotenza

Verificati nel happy path:

- ClusterRecord ID/key/fingerprint deterministici e replay no-write;
- claim `raw -> candidate -> synthesizing` in una sola save, revision +2;
- SynthesisResult validato, content hash verificato subito prima del commit;
- super-memory ID deterministico, used -> consolidated, rejected -> failed;
- super-memory e source nello stesso file memoria con una sola sostituzione;
- optimistic precondition stato/revision/updated_at/attempt;
- verifica post-commit e rollback snapshot RAM sotto lo stesso lock;
- replay equivalente senza seconda super-memory o incremento revision;
- cluster non modificato dal consolidation commit;
- nessun lock mantenuto durante chiamata modello.

Matrice crash:

| Crash point | Stato persistito | Journal | Recovery prevista | Rischio residuo |
|---|---|---|---|---|
| prima cluster persistence | nessuna mutazione source | RUN/PLAN/SELECTED | run incompleto/orphan | basso |
| dopo cluster persistence | cluster immutabile | CLUSTER_PERSISTED | record orphan | basso |
| dopo claim | source synthesizing | SOURCES_CLAIMED | mark failed oltre grace | medio; piano completo nel journal |
| durante synthesis | source synthesizing | SYNTHESIS_STARTED | mark failed | medio |
| dopo synthesis | source synthesizing | SYNTHESIS_SUCCEEDED | mark failed, non ricostruire output | medio |
| prima commit | source synthesizing | COMMIT_STARTED | storage-first reconcile o fail | medio |
| dopo commit/prima ACK | super-memory + source finali | manca COMMIT_SUCCEEDED | reconcile storage | valido single-cluster; rotto multi-cluster |
| durante rollback | snapshot o stato unknown | COMMIT_STARTED/FAILED incompleto | intervento/recovery | alto, correttamente non rassicurato |
| durante journal append | tail completa o troncata | tail | repair autorizzata | medio |
| stale lock | dataset invariato o operazione interrotta | variabile | PID/host/age gate | prudente |

La matrice dimostra che l'idempotenza locale dei record è robusta, ma la recovery run-level non conserva correttamente lo stato per cluster multipli.

## 8. Journal e recovery

Aspetti positivi: JSONL append-only, sequence continua, fingerprint, lock separato, fsync file, replay identico, tail truncation distinta dalla corruzione intermedia, backup prima del truncate, dry-run e token di conferma. Output modello non è journaled né ricostruito.

Limiti verificati:

1. `findIncompleteRuns()` raggruppa solo per `run_id` e usa `types.includes()` (`HippocampusJournal.js:108-124`). Con cluster 1 committato e cluster 2 claimed, classifica l'intero run `COMMIT_SUCCEEDED_NO_RUN_COMPLETION`. Riproduzione sintetica: classification `COMMIT_SUCCEEDED_NO_RUN_COMPLETION`, attempt IDs `[a1,a2]`.
2. `RecoveryManager.executeRecovery()` fa fingerprint recheck, poi esegue primitive con lock separati senza mantenere un user lock tra recheck e mutazione (`RecoveryManager.js:54-60`). Un writer può intervenire tra snapshot e `failClaimedSources`; alcune primitive falliranno safe, ma il flow dichiarato non è atomico e più azioni non costituiscono una recovery coerente.
3. Il daemon non emette `SYNTHESIS_FAILED`, `COMMIT_FAILED` o `SOURCES_FAILED`; dopo provider failure emette solo `RUN_FAILED` (`HippocampusDaemon.js:169-177`). Poiché il journal ha `SOURCES_CLAIMED`, `findIncompleteRuns()` non considera il fallimento completo e RecoveryManager tende a produrre `CLAIM_NOT_ATTRIBUTABLE` sulle source già failed.
4. Il daemon journalizza `details.claimPlan` completo (`HippocampusDaemon.js:139`), e il piano include `userId` (`SourceClaimTransaction.js:60`). `BANNED_KEYS` non vieta `userId` (`HippocampusJournal.js:17`). Riproduzione sintetica conferma userId chiaro nel JSONL, in conflitto con il contratto privacy.

Il journal contiene abbastanza dati per il recovery single-cluster claimed (claim plan, IDs, attempt, hash), ma non per distinguere correttamente più lifecycle cluster nello stesso run con l'algoritmo attuale. Non è quindi una base affidabile per activation.

## 9. Recall integration

La pipeline recall è la parte end-to-end meglio composta dell'intervento:

- core+warm default e deep esplicito;
- comandi deep a prefisso, nessuna inferenza da parole generiche;
- score invariato dal router, tie tier deterministico;
- deduplica ID/content esatto e suppression source coperte;
- retriever `mutate:false`;
- reinforcement solo sugli ID finali, deduplicato e batch;
- super-memory non riceve activation/access/orbital inventati;
- output router separato e frozen;
- bridge e getContext usano la stessa architettura.

Rischio residuo non bloccante: il comportamento legacy diretto resta mutante e include propagation link; è intenzionale per caller non migrati. Uno smoke test reale della chat su copia DEV resta obbligatorio prima dell'Activation Gate, perché la suite usa storage/retriever sintetici e non avvia la CLI.

## 10. Daemon

- import/costruttore non avviano nulla;
- default `dry-run`/`plan`;
- commit richiede `commitEnabled:true`, mode commit e token esatto;
- scheduler accetta solo dry-run, guard single-process impedisce overlap;
- synthesis/commit richiedono `maxClustersPerRun` esplicito;
- maturity default richiede approval ID;
- legacy commit è vietato;
- provider modello è chiamato fuori lock;
- report/event sink sono sanitizzati per contenuto;
- journal e recovery manager sono obbligatori in commit;
- preflight blocca `recoveryRequired`.

Il daemon è testato con provider sintetici. Oggi non è realmente eseguibile in DEV per pipeline completa perché mancano embedding provider reale, model provider Synthesis V1, configurazione journal/lock approvata e bootstrap autorizzato. Questo è correttamente un prossimo step, non un bug. Tuttavia i P1 recovery rendono prematuro anche iniziare il gate operativo.

`getStatus()` non interroga il recovery manager: `incompleteRunCount` è sempre `null` e `recoveryRequired` deriva solo dall'ultimo report locale (`HippocampusDaemon.js:220`). Dopo restart può quindi mostrare stato rassicurante/non informativo pur esistendo journal incompleto (P2-001).

## 11. Vector index

FIX 15 è isolato e non autorevole:

- kind chiusi memory_fragment/super_memory/cluster_centroid;
- user hash, dedup key e UUID deterministici;
- content hash, model/version e vector fingerprint inclusi;
- payload tecnico chiuso e senza testo;
- provider iniettato, collection/dimension/distance validate;
- upsert new/replay/conflict, batch senza top-five;
- filter allowlist e raw score preservato;
- delete solo point IDs;
- timeout con AbortController/race;
- nessun endpoint, fetch, Qdrant client o write JSON.

Non esistono Qdrant provider reale, query embedding provider, memory embedding provider, collection configurata o hydration/verifica contro JSON. Non esiste neppure un index-plan/rebuild executor; il rebuild è documentato come procedura futura. Il vector path è quindi contrattualizzato e testato con mock, non operativo. RecallRouter e daemon continuano senza vector.

P2-004: `search()` verifica shape/allowlist del payload restituito ma non richiama la validazione completa del point né verifica content hash contro JSON (`VectorIndexAdapter.js:29`). È coerente con il confine FIX 15, ma rende l'hydrator futuro un controllo di sicurezza obbligatorio, non opzionale.

## 12. Test audit

File eseguiti:

1. `test/contracts/memory-contract-fixtures.test.js`
2. `test/contracts/memory-contract-normalizer.test.js`
3. `test/storage/storage-capability-contract.test.js`
4. `test/storage/json-atomic-commit.test.js`
5. `test/consolidation/read-only-consolidation-plan.test.js`
6. `test/consolidation/processing-state-contract.test.js`
7. `test/clustering/cluster-engine-adapter.test.js`
8. `test/clustering/cluster-persistence.test.js`
9. `test/synthesis/synthesis-engine-contract.test.js`
10. `test/consolidation/transactional-consolidation-commit.test.js`
11. `test/recall/recall-router-read-only.test.js`
12. `test/recall/recall-router-integration.test.js`
13. `test/hippocampus/hippocampus-daemon-single-process.test.js`
14. `test/hippocampus/hippocampus-recovery.test.js`
15. `test/vector/vector-index-adapter.test.js`

Nessun test usa directory dati reali, avvia chat/daemon reale, chiama rete o importa i prototipi. I test mutanti usano `os.tmpdir()` e cleanup. Risultato: 285 pass, 0 fail/cancel/skip/todo; TAP 7,402 s, wall 8,13 s, RSS massimo circa 70 MiB. Nessun warning, open handle o rejection non gestita osservata.

Test manuali read-only/temporanei:

- require/export dei moduli: pass;
- tier e super-memory: coperti da test dedicati e composizione ispezionata;
- capability inspection: pass nei test senza invocare writer;
- journal read/classification multi-cluster: **riproduce P1-001**;
- journal privacy claimPlan: **riproduce P1-004**.

La suite dimostra bene i moduli isolati e il happy path single-cluster. Non dimostra il recovery multi-cluster, la chiusura journal dopo provider failure, il lock atomico sull'intero recovery né uno smoke runtime con provider reali. P2-002: la copertura FIX 14 è insufficiente rispetto alle garanzie dichiarate; 17 test recovery compatti non coprono queste composizioni fondamentali e consentono un falso positivo di readiness.

## 13. Performance sintetica

Benchmark non scientifico, interamente sotto `os.tmpdir()`, 40.000 memorie sintetiche, cleanup finale:

| Operazione | Risultato |
|---|---:|
| JSON prodotto | 15.268.892 byte |
| atomic save | 1.770,5 ms |
| load | 738,8 ms |
| candidate selection | 5.615,6 ms |
| consolidation plan | 3.875,2 ms |
| lock acquire/release | 50,8 ms |
| delta RSS approssimativo | +251,7 MiB |

Il collo di bottiglia è la materializzazione/serializzazione canonica O(N) con molte copie e hash, non il lock. Sul dataset reale più grande e con testi reali, memoria e tempo possono essere sensibilmente superiori. Questo è P2-003: prima del dry-run DEV servono budget memoria/tempo, spazio per temp+backup e monitoraggio; non implica corruzione.

## 14. Legacy/prototipi

| Modulo | Stato | Side effect/rischio | Decisione futura |
|---|---|---|---|
| ClusterEngine legacy | isolato dal nuovo daemon | muta cluster/memorie, storage assumptions | mantenere isolato/migrazione esplicita |
| CluasterEngine | non rilevato come modulo reale | riferimento storico possibile | nessuna azione |
| MemoryNode | non importato dai nuovi moduli | class instances vs plain object | adapter solo se autorizzato |
| MemoryTypes | non importato | embedding service legacy | isolare |
| OrbitalDinamics | non importato da Ippocampo | writer/field assumptions | isolare |
| MemoriaOrbitaleConCampi | non importato | modello teorico | isolare |
| ColdMemoryCompressor | non importato da Ippocampo, ancora in Keblo | compressione distruttiva potenziale | policy separata, mai nel commit |
| `hyppocampus.js` | prototipo isolato | top-level/run e write diretto | non eseguire |
| `hyppocampo_Jace.js` | prototipo isolato | top-level/run e write diretto | non eseguire |

I prototipi non sono cancellati né rinominati. La loro semplice presenza resta rischio umano/operativo, non runtime del nuovo daemon.

## 15. Disposizione finding originari

L'audit pre-Ippocampo disponibile è `PROJECT_DELTA_0_AUDIT.md`; non usa formalmente ID P0/P1. La seguente disposizione copre i finding richiesti senza promuovere “isolato” a “risolto”.

| Finding originario | Disposizione | Evidenza sintetica |
|---|---|---|
| flat/nested | MITIGATED | normalizzatore verificato; legacy resta distinto |
| atomicità | RESOLVED per singolo file | temp/fsync/backup/rename/fsync-dir |
| lock | MITIGATED | writer cooperanti serializzati; recovery race aperta |
| prototipi auto-start | ISOLATED | non importati, ancora presenti |
| clusterify assente | RESOLVED nel nuovo adapter | legacy non corretto |
| cluster CRUD | RESOLVED | CRUD V1 atomico/locked |
| plain object/isCold | MITIGATED | nuovi confini plain; legacy class assumptions restano |
| CognitiveLink import | ISOLATED | non nel nuovo runtime |
| MemoriaOrbitaleConCampi | ISOLATED | non importato |
| OrbitalDinamics | ISOLATED | non importato |
| compressor distruttivo | ISOLATED | escluso da Ippocampo, presente in Keblo |
| LinkManager legacy fields | DEFERRED | non migrati; storage lock mitiga writer |
| memoryDepth/orbitalLevel/storageTier | MITIGATED | classifier esplicito; legacy resta |
| processing | RESOLVED nel contratto Ippocampo | legacy non migrato automaticamente |
| recall mutante | MITIGATED | router read-only; recall diretto resta mutante |
| Qdrant | DEFERRED | adapter astratto, nessun provider/collection |
| scheduler | MITIGATED | locale, dry-run only, no auto-start |
| default `||` | STILL_OPEN nel legacy | nuovi contratti preservano zero |
| deep nel recall | RESOLVED nel router | legacy diretto fuori router non è tier-safe per policy |
| double reinforcement | RESOLVED nella pipeline router | final IDs una volta |
| provenance | MITIGATED | strutturale, non prova fattuale |
| idempotenza | MITIGATED | record/commit robusti; recovery run-level aperta |
| recovery | REGRESSED rispetto alla dichiarazione COMPLETED | P1-001/002/003 impediscono affidabilità |

## 16. Finding nuovi

### AUD-P1-001 — Journal/recovery perde lo stato dei cluster successivi nello stesso run

- **Severità:** P1.
- **Evidenza:** `core/hippocampus/HippocampusJournal.js:108-124`; consumer `core/hippocampus/RecoveryManager.js:34-46`.
- **Impatto:** un commit del primo cluster fa classificare l'intero run come commit riuscito anche se un secondo cluster è rimasto `synthesizing`; recovery può riconciliare il run e lasciare source bloccate, rendendo falsa la garanzia crash recovery.
- **Riproduzione:** journal sintetico con c1 `COMMIT_SUCCEEDED`, poi c2 `SOURCES_CLAIMED`; `findIncompleteRuns()` restituisce `COMMIT_SUCCEEDED_NO_RUN_COMPLETION` per il run unico.
- **Raccomandazione:** ricostruire state machine per `(run_id, cluster_id, attempt_id)`, validare ordine eventi e chiudere il run solo quando ogni cluster è terminale.
- **Blocker activation:** sì.

### AUD-P1-002 — Recovery snapshot precondition non è protetta da un unico user lock

- **Severità:** P1.
- **Evidenza:** `core/hippocampus/RecoveryManager.js:54-60`; confronto con requisito/primitive locked in `SourceClaimTransaction.js:112-127`.
- **Impatto:** tra fingerprint recheck e azioni un writer può cambiare il dataset; più azioni vengono applicate con lock separati, quindi il recovery plan non è una transazione coerente. Le precondition interne riducono il danno ma non soddisfano la garanzia dichiarata.
- **Riproduzione:** inspection statica del flow; non esiste `withUserLock/acquireLock` in RecoveryManager.
- **Raccomandazione:** definire ordine lock, acquisire data lock, ricalcolare snapshot sotto lock, applicare primitive con handle condiviso o piano atomico; append journal dopo rilascio con checkpoint idempotenti.
- **Blocker activation:** sì.

### AUD-P1-003 — Failure provider non produce eventi terminali coerenti

- **Severità:** P1.
- **Evidenza:** event vocabulary `HippocampusJournal.js:9-13`; catch daemon `HippocampusDaemon.js:169-177`; classificazione `HippocampusJournal.js:114-122`.
- **Impatto:** source correttamente portate failed possono lasciare un run classificato incompleto/ambiguo perché mancano `SYNTHESIS_FAILED` e `SOURCES_FAILED`; il preflight successivo può restare bloccato e RecoveryManager risponde `CLAIM_NOT_ATTRIBUTABLE`.
- **Riproduzione:** commit sintetico con provider rejection (test daemon già verifica le source failed), poi ispezione della sequenza eventi prodotta.
- **Raccomandazione:** appendere eventi failure terminali idempotenti e validare la state machine journal; non usare solo `RUN_FAILED` come surrogato.
- **Blocker activation:** sì.

### AUD-P1-004 — User ID in chiaro nel journal

- **Severità:** P1 (security/privacy contract violation).
- **Evidenza:** `HippocampusDaemon.js:139`; `SourceClaimTransaction.js:60`; allow/deny journal `HippocampusJournal.js:17,29-31`.
- **Impatto:** il filename è hashato ma il contenuto JSONL rivela l'user identity dentro `details.claimPlan`, contraddicendo il contratto FIX 14 e ampliando il dato sensibile persistito.
- **Riproduzione:** append sintetico di `SOURCES_CLAIMED` con claimPlan; lettura del JSONL conferma la stringa userId.
- **Raccomandazione:** journalizzare un recovery descriptor sanitizzato senza userId chiaro, oppure hash/scoping verificabile; ampliare validazione privacy strutturale.
- **Blocker activation:** sì.

### AUD-P2-001 — getStatus non riflette lo stato persistente dopo restart

- **Severità:** P2.
- **Evidenza:** `core/hippocampus/HippocampusDaemon.js:220`.
- **Impatto:** `incompleteRunCount` è sempre null e recoveryRequired deriva solo da `lastRun`; osservabilità operativa fuorviante.
- **Riproduzione:** istanza nuova con journal incompleto, chiamata sincrona `getStatus()`.
- **Raccomandazione:** API status async/read-only basata su RecoveryManager oppure stato cached esplicitamente “unknown”.
- **Blocker activation:** no da solo; sì come parte del recovery gate operativo.

### AUD-P2-002 — Suite recovery non copre garanzie fondamentali di composizione

- **Severità:** P2.
- **Evidenza:** `test/hippocampus/hippocampus-recovery.test.js:6-25`; assenza casi multi-cluster e failure-event lifecycle.
- **Impatto:** 285/285 verde non intercetta P1-001/002/003/004; rischio di dichiarare readiness sulla base di mock e casi single-cluster.
- **Riproduzione:** confronto test declarations con riproduzione manuale multi-cluster.
- **Raccomandazione:** test black-box di crash matrix, privacy journal e concorrenza recovery prima di qualsiasi Gate.
- **Blocker activation:** sì indirettamente.

### AUD-P2-003 — Costi elevati del piano monolitico a 40.000 record

- **Severità:** P2.
- **Evidenza:** benchmark sintetico sezione 13; `CandidateSelector.js:104-130,189-256`, `ConsolidationPlan.js`.
- **Impatto:** ~9,5 s solo selection+plan e +252 MiB RSS su JSON da 15,3 MB; dataset DEV reale può causare pressione memoria/latency.
- **Riproduzione:** benchmark os.tmpdir descritto.
- **Raccomandazione:** misurare dry-run controllato, budget, telemetry e futuro streaming/sharding; non ottimizzare prima della correzione reliability.
- **Blocker activation:** no per provider integration; blocker per dry-run reale senza limiti operativi.

### AUD-P2-004 — Hydration/vector stale verification non implementata

- **Severità:** P2.
- **Evidenza:** `core/vector/VectorIndexAdapter.js:29`; contratto `VECTOR_INDEX_ADAPTER_V1.md` sezioni stale/hydration.
- **Impatto:** un futuro retriever che si fidasse direttamente del payload potrebbe restituire point stale o di un JSON cambiato.
- **Riproduzione:** search provider può restituire payload shape-valid senza risoluzione JSON; adapter lo restituisce.
- **Raccomandazione:** hydration obbligatoria con lookup JSON e contentHash prima di collegare RecallRouter.
- **Blocker activation:** opzionale se vector path resta disabilitato; obbligatorio se incluso.

### AUD-P3-001 — Sezione rischi Evolution Log obsoleta

- **Severità:** P3.
- **Evidenza:** `docs/MEMORIA_ORBITALE_EVOLUTION.md` sezione 11 dichiara ancora assenza lock/lost update/recovery nonostante FIX 10/14.
- **Impatto:** orientamento contraddittorio; la cronologia append-only è corretta, lo “stato corrente” dei rischi no.
- **Riproduzione:** confronto sezioni FIX 10/14 con sezione 11.
- **Raccomandazione:** futura nota append-only che distingua resolved/nuovi finding, senza riscrivere storia.
- **Blocker activation:** no.

### AUD-P3-002 — Moduli critici e test recenti eccessivamente compressi

- **Severità:** P3.
- **Evidenza:** `RecoveryManager.js` 64 righe e `VectorIndexAdapter.js` 34 righe con molte istruzioni per riga; recovery test 25 righe.
- **Impatto:** review, line evidence e manutenzione security/reliability più difficili; favorisce omissioni di stato.
- **Riproduzione:** inspection line-based.
- **Raccomandazione:** futuro refactor meccanico separato, senza cambiare semantica, dopo i blocker.
- **Blocker activation:** no.

## 17. Activation blockers

### Obbligatori prima di iniziare provider/dry-run/canary

1. correggere e riesaminare AUD-P1-001/002/003/004;
2. aggiungere regressioni crash multi-cluster, provider failure journal e recovery concurrency/privacy;
3. proteggere il worktree FIX 1–15 con checkpoint Git controllato (non eseguito dall'audit);
4. definire provider embedding reale e versioni provider/model;
5. definire provider Qwen/Ollama conforme al Synthesis V1, endpoint esplicito e versioni;
6. decidere strategia non implicita per inizializzare `processing:raw` sulle legacy e scegliere memorie eleggibili;
7. approvazione manuale cluster o maturity policy reale verificata;
8. directory journal e lock, ownership/permessi, spazio e backup;
9. limiti synthesis input/output/timeout e `maxClustersPerRun` esplicito;
10. smoke test chat/RecallRouter su copia/sintetico;
11. dry-run dataset DEV con report sanitizzato e revisione umana;
12. staging con copie, commit canary e verifica raw/provenance;
13. runbook recovery, stale lock e rollback operativo;
14. confronto/merge controllato successivo verso server Keblo.

### Obbligatori solo se si abilita il vector path

- Qdrant provider reale conforme;
- collection esplicitamente provisionata con dimension/distance;
- query e memory embedding provider compatibili/versionati;
- rebuild plan controllato;
- hydration JSON autorevole + contentHash stale check.

### Miglioramenti post-attivazione

- performance streaming/sharding;
- status persistente più ricco;
- refactor leggibilità moduli compatti;
- distributed coordination, se mai richiesta;
- verifica semantica/fattuale oltre provenance strutturale.

## 18. Activation Gate consigliato

Non iniziare l'Activation Gate nello stato corrente. Dopo la chiusura verificata dei quattro P1, il gate consigliato è:

1. checkpoint e riproducibilità;
2. provider contract tests offline;
3. dry-run plan/cluster su copia DEV, zero write;
4. dry-run synthesis su cluster approvati, output revisionato senza persistenza;
5. failure-injection completa journal/recovery;
6. staging clone con commit canary di un cluster;
7. verifica raw byte/field preservation, super-memory/provenance e replay;
8. recovery drill da ogni crash point;
9. decisione umana go/no-go separata.

Commit reale sui dati DEV deve restare disabilitato durante i primi passi. “Gate superato” non equivale ad attivazione production.

## 19. Merge futuro nel server Keblo

Il merge non è autorizzato. Prima serviranno audit della versione server, backup verificato, confronto contratti/storage/runtime, branch/checkpoint, prova su copia, smoke recall, canary e rollback. Non trasferire dati, journal, lock o collection per semplice copia senza piano. Vector index resta ricostruibile e non deve essere migrato come fonte autorevole.

## 20. Conclusione

FIX 1–15 hanno prodotto una base ampia, con buoni confini puri, atomicità single-file, recall read-only composto, transazioni deterministiche e suite verde. Il vector adapter è correttamente opzionale. Tuttavia il sottosistema che dovrebbe rendere sicuro il passaggio da prototipo a operazione — journal/recovery — non compone correttamente i run multi-cluster, non protegge atomicamente il recovery plan, non chiude gli eventi failure e viola il confine privacy dell'userId.

Il verdetto è pertanto **NOT_READY**. Non sono stati trovati P0 e il commit resta esplicitamente disabilitato, quindi non esiste un rischio immediato ai dati finché non viene attivato. I P1 devono essere corretti e riesaminati in un intervento successivo esplicitamente autorizzato. Questo audit non ha implementato fix e non ha iniziato l'Activation Gate.
