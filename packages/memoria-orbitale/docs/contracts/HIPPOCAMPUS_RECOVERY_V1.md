# HIPPOCAMPUS_RECOVERY_V1

## 1. Scopo e non-obiettivi

FIX 14 aggiunge journal persistente, rilevamento run incompleti, recovery idempotente e stale-lock handling locale. Non introduce lock distribuiti, provider, migrazioni, ricostruzione di output modello o riparazione automatica di stati ambigui.

## 2. Journal e schema eventi

Il journal è JSONL append-only, uno per user hash SHA-256. Ogni evento V1 contiene event ID/fingerprint, sequence continua, run/mode/phase/status, timestamp, ID tecnici, source ID ordinati e details sanitizzati. Tipi coprono run, piano, cluster, claim, synthesis, commit e recovery.

## 3. Privacy

Sono ammessi ID, contatori, reason code, fingerprint e metadata provider. Sono vietati testo/content, prompt/messages, raw output, centroide/embedding, snapshot, stack e dati lock. Filename, report ed eventi non espongono userId, token o path.

### 3.1 Claim descriptor journal-safe (FIX 16)

Il piano operativo di source claim conserva `userId` perché le primitive storage
devono essere esplicitamente scoped. L'evento `SOURCES_CLAIMED` non persiste più
quel piano completo: usa un descriptor V1 chiuso contenente soltanto
`schemaVersion`, `claimId`, `attemptId`, `claimedAt` e i descriptor source con
content hash e stati processing necessari alle optimistic precondition.

La recovery ricostruisce il piano operativo aggiungendo l'identità esclusivamente
dallo scope `userId` già configurato nel RecoveryManager, quindi rivalida il
`claimId`. Non serve un secondo identificatore utente nel payload journal; il
digest del filename continua a separare i journal, ma non viene usato come
surrogato ambiguo dell'identità nel claim descriptor.

Prima di ogni nuovo append il journal attraversa ricorsivamente l'intero evento,
inclusi array e oggetti annidati. Le chiavi vengono confrontate senza distinzione
di casing e ignorando separatori: varianti come `userId`, `user_id`, `USER_ID`,
`username` e `userIdentifier` sono vietate. È vietata anche qualsiasi stringa che
contenga l'identità configurata. Riferimenti circolari e valori non JSON plain
sono rifiutati con errori generici che non riportano il valore privato.

Eventi V1 storici con un claim plan completo restano leggibili e verificabili;
`inspect()` li segnala mediante `legacyPrivacyDetected` e
`legacyPrivacyEventCount`, senza includere l'identità. Non vengono riscritti o
migrati automaticamente. I nuovi append non accettano il formato legacy.

## 4. Append, fsync e idempotenza

Append acquisisce un lock journal separato, valida lo stato, assegna sequence, calcola ID deterministico, scrive una riga con newline, esegue fsync e chiude. Replay semantico non aggiunge righe; sequence, ID e fingerprint vengono rivalidati in lettura.

## 5. Tail repair

Solo l'ultima riga incompleta senza newline è riparabile. Dry-run produce offset/fingerprint. Mutazione richiede `commitRepair: true` e token `REPAIR_HIPPOCAMPUS_JOURNAL_V1`, ricontrolla size/fingerprint, crea backup, tronca, fsync e rivalida. Corruzione intermedia, sequence o fingerprint alterati restano bloccati.

## 6. Incomplete run

La ricostruzione classifica complete/failed complete, cluster orphan, claimed senza synthesis, synthesis iniziata o riuscita senza commit, commit iniziato o riuscito senza run completion e stati ambigui. L'ordine deriva dalla sequence validata, non dal solo ultimo tipo.

### 6.1 Correlazione multi-cluster (FIX 17)

La sequence JSONL resta globale, ma la ricostruzione separa formalmente due
livelli:

- lifecycle run-level, identificato da `run_id`;
- lifecycle cluster-level, identificato da una correlation key SHA-256 sul
  dominio `hippocampus.cluster-work-v1`, schema V1, `run_id` e `cluster_id`.

La correlation key non contiene userId o contenuti. `claimId` è la chiave
idempotente del source claim e viene verificata insieme ad `attempt_id`, source
ID ordinati, cluster record ID e transaction ID quando applicabili. Claim,
attempt, transaction o source condivisi/contraddittori tra cluster rendono il
run bloccato.

`reconstructRuns()` e `getRunState(runId)` restituiscono per ogni run i cluster
osservati, stato/classificazione per cluster, cluster terminali, incompleti e
bloccati, correlation key e identificatori tecnici sanitizzati. Gli eventi di
cluster diversi possono essere interleaved: l'ordine è validato sulla subsequence
del singolo cluster, senza richiedere contiguità nel JSONL.

`COMMIT_SUCCEEDED` rende terminale soltanto il cluster associato. Il numero
atteso di cluster non viene inventato: qualunque evento cluster-level registra
un'unità osservabile, mentre la chiusura del run richiede `RUN_COMPLETED`,
`RUN_FAILED` o `RUN_RECONCILED` run-level con `cluster_id: null`. Un terminale
run-level è valido soltanto se tutti i cluster osservati sono terminali coerenti;
in caso contrario la ricostruzione produce `CORRUPT_OR_AMBIGUOUS`.

Journal V1 precedenti restano leggibili. Se cluster, claim o attempt non sono
correlabili in modo dimostrabile, il run viene bloccato senza migrazione o
interpretazione ottimistica. I flag `legacyPrivacyDetected` e
`legacyPrivacyEventCount` di FIX 16 restano invariati.

## 7. Stale lock

Il lock V1 registra PID, host e createdAt oltre a owner/token. Un lock è recuperabile automaticamente solo con metadata validi, età oltre `staleAfterMs`, host locale, PID certamente morto, fingerprint invariato e doppia autorizzazione `recover: true` + `RECOVER_STALE_LOCK_V1`.

PID vivo non viene mai rimosso. Host differente/non verificabile e metadata invalidi richiedono intervento manuale. Race o sostituzione bloccano la rimozione. JsonMemoryStorage delega inspect/recovery del lock utente.

## 8. Recovery plan e fingerprint

Il piano dry-run contiene user hash, fingerprint journal, snapshot memoria e
snapshot cluster, generatedAt, azioni/blocchi e statistiche. A parità di
snapshot e clock esplicito è deterministico. Il piano è identificato sul suo
contenuto completo; una manomissione o uno scope journal differente viene
rifiutato.

Dal FIX 19, execute acquisisce prima il lock logico utente e soltanto dentro la
critical section rilegge journal, memoria e cluster. I tre fingerprint devono
coincidere con il piano. Revision, updated_at, state, attempt, content hash e
correlazione sono quindi protetti indirettamente dallo snapshot completo e
rivalidati nuovamente dalle primitive. Una differenza produce
`STALE_RECOVERY_PLAN` prima di qualsiasi mutazione e non genera automaticamente
un nuovo piano.

## 9. Azioni

Azioni V1: noop complete, record recovered commit, mark interrupted claim failed,
record orphan cluster, record run reconciled, repair tail, recover stale lock e
blocchi per stato incoerente/unattributed synthesizing. Le azioni mutanti sono
associate al cluster corretto; il run-level `RUN_RECONCILED` viene aggiunto solo
dopo le azioni cluster previste dal piano.

## 10. Source synthesizing

Una source attribuibile a claim journal e oltre grace diventa failed retryable con `RECOVERY_INTERRUPTED_ATTEMPT`, usando la primitiva idempotente del claim. Synthesis riuscita ma non persistita non viene ricostruita. Attempt senza attribuzione o stato misto resta bloccato.

### 10.1 Failure lifecycle storage-first (FIX 18)

Una sequenza con `SYNTHESIS_FAILED` o `COMMIT_FAILED` ma senza terminale source
resta incompleta. Se le source sono ancora synthesizing, recovery usa la
transizione idempotente esistente e poi registra `SOURCES_FAILED`. Se lo storage
dimostra invece che tutte le source sono già failed con attempt, revision ed
errore stabile coerenti, recovery registra soltanto l'ACK mancante
`SOURCES_FAILED`: non riscrive la memoria e non incrementa nuovamente revision.

La chiusura run-level `RUN_RECONCILED` avviene solo dopo i terminali cluster
necessari. Stati misti, transition failure o correlazioni non dimostrabili
restano bloccati. Nessun output modello viene ricostruito e nessuna
super-memory viene creata durante questa riconciliazione.

## 11. Commit reconciliation

Se storage contiene una super-memory valida ma manca COMMIT_SUCCEEDED, recovery verifica id/key/fingerprint, source used consolidated con linkage e rejected failed. Registra RUN_RECONCILED senza riscrivere memoria. Non crea né duplica super-memory. Duplicati semantici restano blocco critico.

## 12. Execute e repeated recovery

Execute richiede `execute: true` e `RECOVER_HIPPOCAMPUS_V1`. Le primitive
rivalidano precondizioni e ricevono lo stesso `lockHandle` verificato per user,
manager e owner. `failClaimedSources` mantiene la firma precedente e accetta
opzionalmente l'handle per evitare una seconda acquisizione. Una seconda
recovery vede il run riconciliato e non incrementa revision né duplica
super-memory.

Una failure dopo una prima mutazione interrompe le azioni successive. Poiché le
azioni dati V1 modificano il solo file memoria, RecoveryManager ripristina lo
snapshot memoria iniziale sotto lo stesso handle e ne verifica il fingerprint.
Failure del ripristino produce `RECOVERY_ROLLBACK_FAILED_STATE_UNKNOWN`; failure
della release produce `RECOVERY_LOCK_RELEASE_FAILED` e non viene dichiarato un
successo.

## 13. Lock order

Dal FIX 19 tutte le azioni dati di un piano condividono una sola acquisizione:

1. acquire del user/data lock;
2. rilettura e recheck di journal, memoria e cluster;
3. mutazioni dati con lo stesso handle;
4. verifica post-azione ed eventuale rollback memoria circoscritto;
5. release del user/data lock;
6. append degli ACK sotto il journal lock separato.

User lock e journal lock non sono mai detenuti contemporaneamente. Un failure
degli ACK dopo mutazioni valide non causa rollback cieco: il report restituisce
`needs_reconciliation` e il piano successivo riconosce lo stato storage-first.
Writer memory, link e cluster dello stesso utente e una seconda recovery devono
attendere o andare in timeout; utenti differenti usano lock key indipendenti.

Tail repair e rimozione autorizzata di uno stale lock sono operazioni preliminari
con le proprie precondition: non fanno parte della critical section dataset e
non introducono un ordine journal-lock → user-lock annidato.

## 14. Daemon integration

Commit richiede journal e RecoveryManager. Il preflight blocca con RECOVERY_REQUIRED in presenza di run incompleti, journal non valido o stale lock. Nessuna recovery è automatica. Eventi precedono/seguono cluster persistence, claim, synthesis e commit.

Failure journal prima del claim abortisce senza mutazioni. Failure dopo commit valido restituisce NEEDS_RECONCILIATION; non effettua rollback del commit e il run successivo viene riconciliato dallo storage. Scheduler dry-run non esegue recovery mutante.

Dal FIX 18 lo stesso principio vale per l'ACK terminale di una failure: append
fallito prima della mutazione non produce un falso terminale; append fallito
dopo source failed verificate produce `NEEDS_RECONCILIATION` e viene completato
storage-first. Dal FIX 19 la rilettura, le mutazioni dati e la verifica finale
sono mutuamente esclusive sotto un unico lock logico per utente; gli ACK restano
successivi alla release.

## 15. Crash windows, garanzie e non-garanzie

Il journal rende osservabili le finestre cluster→claim→model→commit e consente recovery prudente. Non garantisce atomicità multi-file tra dataset e journal, distributed consensus, PID affidabile su host remoto, recupero output modello non persistito o correzione automatica di ambiguità.

## 16. Procedura operativa

1. Eseguire inspect/build plan senza mutazioni.
2. Risolvere manualmente blockedItems.
3. Riparare solo tail troncata con token dedicato.
4. Recuperare stale lock solo dopo verifica host/PID/età e token dedicato.
5. Ricostruire un nuovo piano dopo ogni cambiamento.
6. Eseguire recovery con conferma V1.
7. Verificare che incomplete runs siano zero prima di un nuovo commit.

## 17. Hydration status daemon post-FIX 21

`RecoveryManager.inspect()` e il piano dry-run alimentano lo status operativo
del daemon. Lo status non è persistito separatamente: è una proiezione RAM
sanitizzata di journal, snapshot storage e lock inspection. Prima di una lettura
persistente il valore è `unknown`, mai falsamente ready.

`HippocampusDaemon.refreshStatus()` distingue journal valido vuoto, run
incompleti, riconciliazione storage-first, stati bloccati, corruzione, tail
troncata e stale lock. Un ACK source/commit mancante con stato dati già valido è
`needs_reconciliation`; non viene confuso con `ready`. Tail e stale lock sono
soltanto segnalati: nessuna riparazione o recovery è automatica.

Ogni commit ripete l'ispezione persistente anche se la cache precedente era
ready. Una failure d'ispezione è fail-closed e sanitizzata. Dopo
`executeRecovery()` il passaggio a ready richiede un nuovo refresh che dimostri
zero run incompleti; restart successivi ricostruiscono lo stesso esito dalle
fonti persistenti. Flag e conteggio privacy legacy restano tecnici e non
ristampano identità.
