# HIPPOCAMPUS_DAEMON_V1

## 1. Scopo e non-obiettivi

FIX 13 introduce un orchestratore locale single-process sopra i componenti FIX 1–12. Non è distribuito, non avvia processi, non incorpora provider, endpoint o porte, non migra legacy e non cancella/comprime raw.

## 2. Architettura

La pipeline è: load memoria → candidate selection → consolidation plan → cluster adapter → maturity gate → ClusterRecord → source claim → synthesis → transactional commit. Ogni componente conserva il proprio contratto e la propria idempotenza.

## 3. Modalità e fasi

Le modalità sono `dry-run` e `commit`; il default è dry-run. Le fasi sono `plan`, `cluster`, `synthesis`, `commit`; il default è plan. Commit implica phase commit. Synthesis e commit richiedono `maxClustersPerRun` positivo esplicito.

## 4. Dry-run

Plan non richiede provider. Cluster aggiunge embedding senza persistenza. Synthesis valuta maturità e invoca il modello solo per cluster approvati, senza salvare cluster, claim, processing o super-memory. Il report dichiara `dryRun: true` e `writesAttempted: 0`.

## 5. Commit guard

Commit richiede insieme `commitEnabled: true` nel costruttore e `{ mode: "commit", phase: "commit", confirmCommit: "COMMIT_HIPPOCAMPUS_V1" }`. Una condizione mancante non degrada mai a commit implicito.

## 6. Scheduler e single-process

`start()` accetta soltanto dry-run e usa un timer locale. Non esistono cron, worker o scheduler distribuiti. Il guard consente un solo `runOnce`; overlap produce `RUN_ALREADY_ACTIVE`. `stop()` è idempotente. Import e costruzione non avviano nulla.

## 7. Provider

I provider sono iniettati. Cluster richiede embedding V1; ClusterRecord richiede providerId/model/version. Synthesis usa il provider FIX 9. Non esistono globali o fallback. La chiamata modello avviene dopo il rilascio del lock claim e prima del lock commit.

## 8. Maturity gate

Il gate predefinito richiede struttura, dimensione coerente, embedding/density validi e ID in `approvedClusterIds`. Non esistono soglie nascoste, conteggi di cicli o auto-approval. Un evaluator futuro deve restituire evidence plain; la maturità multi-ciclo richiede storico persistente futuro e non viene simulata.

## 9. Source claim

Commit accetta soltanto source con processing `raw` esplicito. Il claim verifica ID, revision, updated_at e SHA-256 del testo esatto, applica logicamente `raw → candidate → synthesizing` e persiste una sola volta sotto lock. Revision cresce di due; gli altri campi restano invariati. Replay equivalente è no-op. Legacy senza processing non è committabile.

## 10. Content hash precondition

Subito prima del commit, ConsolidationTransaction normalizza ogni source e ricalcola SHA-256 UTF-8. Deve coincidere con `SynthesisResult.sourceContentHashes` nella provenance. Un mismatch rifiuta tutto prima della write senza esporre testo.

## 11. Pipeline commit

Per ogni candidato maturo: crea/salva ClusterRecord idempotente, claim, sintesi fuori lock, transition plan used/rejected e commit. Used diventa consolidated; rejected failed. Il cluster non viene modificato dal commit.

## 12. Failure policy

`continueOnClusterFailure` è false per default; se true continua esplicitamente. Dopo una failure gestita il daemon tenta `synthesizing → failed` con errore sanitizzato e una write sotto lock. Uno stato concorrente evoluto non viene sovrascritto.

Dal FIX 18, una normale failure di synthesis successiva al claim produce in
ordine `SYNTHESIS_FAILED`, la transizione persistente delle source e
`SOURCES_FAILED`. La transizione usa `HIPPOCAMPUS_CLUSTER_FAILED`, è retryable,
preserva l'attempt e incrementa la revision una sola volta. Il daemon rilegge lo
storage e verifica stato, revision, attempt ed errore prima di confermare
`SOURCES_FAILED`.

`SOURCES_FAILED` è l'unico terminale del cluster fallito. `SYNTHESIS_FAILED` e
`COMMIT_FAILED` descrivono la causa ma non rendono terminale il cluster. Dopo il
ciclo, `RUN_FAILED` è emesso esclusivamente come evento run-level e soltanto se
tutti i cluster osservati sono terminali e non bloccati. Con
`continueOnClusterFailure: false` il ciclo si ferma dopo aver chiuso il cluster;
con `true` contabilizza anche i cluster successivi prima di chiudere il run.

## 13. Legacy e limiti

`allowLegacyUnclassified: true` è ammesso solo dry-run. Commit legacy è vietato. Non esiste limite cinque: plan/cluster seguono le policy; synthesis/commit usano il solo limite esplicito e registrano i rinviati.

## 14. Capabilities

Dry-run richiede `memory.readAll`. Commit richiede memory read/write-all, cluster read-all/read-one/write-one, atomic commit e lock acquire/release. Snapshot e rollback generale non sono richiesti.

## 15. Report, eventi e privacy

Report ed eventi contengono run identity, fasi, statistiche, ID tecnici e codici. Non contengono testi, centroidi, prompt, raw response, snapshot, mappe memoria o lock data. Una failure event sink è registrata separatamente e non corrompe il commit.

## 16. Idempotenza

Il daemon riusa ClusterRecord, source claim, SuperMemory e ConsolidationTransaction senza introdurre key incompatibili. Candidate selection e replay dei componenti impediscono duplicati equivalenti.

## 17. Garanzie e non-garanzie

Sono garantiti dry-run default, doppia autorizzazione, guard single-process, maturità esplicita, modello fuori lock, raw preservation e privacy. Non sono garantiti coordinamento daemon multi-process, journal, recovery crash, stale-lock recovery o maturità multi-ciclo.

## 18. Crash window e FIX 14

Un crash tra claim e failure/commit può lasciare source synthesizing; un crash può lasciare lock stale. FIX 14 dovrà introdurre journal e recovery persistente senza confondere snapshot RAM con crash recovery.

## 19. Integrazione recovery post-FIX 14

Commit richiede ora journal persistente e RecoveryManager. Il preflight rifiuta nuovi commit quando recovery è richiesta. Ogni fase irreversibile è delimitata da eventi sanitizzati; un ACK journal fallito dopo commit valido produce `NEEDS_RECONCILIATION`, non rollback. Recovery resta dry-run e separatamente autorizzata.

## 20. Privacy source claim post-FIX 16

Il daemon passa a `SOURCES_CLAIMED` esclusivamente il descriptor journal-safe del
claim. Il piano operativo completo, incluso lo scope utente, resta in memoria e
non entra nel JSONL, nei report o nei recovery plan pubblici. Claim ID, attempt,
source ID, content hash e processing precondition restano disponibili per replay
e recovery deterministici.

## 21. Correlazione journal multi-cluster post-FIX 17

Gli eventi run-level usano `run_id` e `cluster_id: null`; gli eventi di lavoro
usano sempre il `cluster_id` del candidato e, dalle fasi claim in avanti,
`attempt_id`, claim ID nel descriptor e source ID coerenti. Commit usa inoltre
un transaction ID stabile per cluster.

Un `COMMIT_SUCCEEDED` chiude esclusivamente il cluster correlato. Il daemon emette
`RUN_COMPLETED` soltanto al termine del ciclo selezionato senza failure; la
ricostruzione journal lo accetta soltanto se tutti i cluster osservati sono già
terminali. Il daemon non dichiara né inventa un conteggio persistente dei cluster
attesi: la validità della chiusura dipende dall'evento run-level esplicito e dalle
unità cluster effettivamente registrate.

## 22. Divergenza journal/storage post-FIX 18

Se l'append dell'evento causale fallisce prima della transizione source, il
daemon non emette un terminale e restituisce `needs_reconciliation`. Se la
transizione a failed è già verificata ma l'ACK `SOURCES_FAILED` fallisce, le
source non vengono riportate a synthesizing: il risultato resta
`needs_reconciliation` e la recovery successiva completa il journal in modalità
storage-first senza un secondo incremento della revision.

Un content-hash mismatch o un errore nel commit produce `COMMIT_FAILED`, ma non
un falso `SOURCES_FAILED` quando lo stato persistito non dimostra che tutte le
source claimed siano failed. Errori pubblici ed eventi contengono soltanto code
stabili e identificatori tecnici correlati; messaggi provider, stack, prompt,
output e contenuti memoria non vengono journalizzati.

## 23. Status recovery persistente post-FIX 21

Il costruttore non esegue I/O. Una nuova istanza espone tramite `getStatus()` uno
stato conservativo non idratato:

- `statusHydrated: false`;
- `recoveryState: "unknown"`;
- `recoveryRequired: null`;
- contatori e indicatori persistenti a `null`;
- `reasonCode: "STATUS_NOT_INSPECTED"`.

`refreshStatus()` è l'unica API esplicita di hydration. È read-only e deriva lo
stato da `RecoveryManager.inspect()`, dal journal e, quando esistono run
incompleti, dal recovery plan dry-run storage-first. Non crea un file status e
non esegue recovery, tail repair o stale-lock removal. La cache risultante è
soltanto osservabilità RAM; journal e JSON restano autorevoli.

Gli stati chiusi sono `unknown`, `ready`, `recovery_required`,
`needs_reconciliation`, `blocked` e `corrupt`. Lo schema include inoltre
`incompleteRunCount`, `blockedRunCount`, `ambiguousRunCount`,
`tailRepairRequired`, `staleLockDetected`, `journalValid`, flag/count privacy
legacy, `lastInspectionAt` e reason code sanitizzato. Running/scheduled,
recovery state e last run restano assi distinti. `getStatus()` restituisce ogni
volta una copia profondamente congelata.

Ogni preflight commit forza un nuovo `refreshStatus()` e non si fida della
cache. `ready` è l'unico stato che consente il commit; incomplete/reconciliation
producono `RECOVERY_REQUIRED`, mentre stati non affidabili producono errori
specifici blocked/corrupt/unknown. Un dry-run con RecoveryManager configurato
aggiorna e riporta lo status senza mutare. Dopo un commit concluso il daemon
ricalcola la cache; dopo recovery esterna serve un nuovo refresh esplicito.

Refresh concorrenti usano una generation locale monotona: un'ispezione iniziata
prima e completata dopo non può sovrascrivere una generazione più recente. La
generation non è persistente e non è una seconda fonte di verità.

## 24. Piano dry-run scalabile post-FIX 22

Il percorso `dry-run` costruisce il piano con
`buildConsolidationPlanScalable()` e riporta `scaleTelemetry` sanitizzata. Le
opzioni `batchSize` e `budget` provengono dalla `candidatePolicy`; il default V1
è pubblico e versionato. Il batching è puramente operativo e non modifica
`maxCandidates`, eleggibilità, deduplica o `planId`.

Il percorso commit continua a consumare un piano validato con la semantica
esistente; le opzioni operative di scala non entrano nella policy persistita.
Candidate selection non invoca provider e non scrive storage in nessuna modalità.
