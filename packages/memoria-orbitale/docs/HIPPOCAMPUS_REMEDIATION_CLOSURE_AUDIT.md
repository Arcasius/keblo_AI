# HIPPOCAMPUS_REMEDIATION_CLOSURE_AUDIT

## 1. Executive summary

**Data audit:** 2026-07-13

**Scope:** FIX 16–22, regressione FIX 1–15 e isolamento del vector path

**Verdetto:** `READY_FOR_ACTIVATION_GATE`

L'audit è stato svolto in modalità non correttiva, partendo dal codice e dai
test presenti nel worktree e senza assumere corretti i precedenti report. Le
sette remediation obbligatorie risultano effettive: i quattro finding P1 e i
tre finding P2 obbligatori non sono più riproducibili. Non sono emerse nuove
regressioni P0/P1.

Il conteggio dei finding ancora aperti o condizionali è:

| Severità | Conteggio | Disposizione |
|---|---:|---|
| P0 | 0 | nessuno |
| P1 | 0 | nessuno |
| P2 | 1 | `AUD-P2-004`, isolato e condizionale all'abilitazione vector |
| P3 | 2 | `AUD-P3-001` e `AUD-P3-002`, rinviabili e non bloccanti |

L'Activation Gate autorizzato da questo verdetto è soltanto la preparazione
controllata della DEV: configurazione provider, dry-run sintetico/DEV e canary
su copie o staging. Non autorizza provider reali, commit sui dati reali,
migrazione legacy o merge nel server.

## 2. Baseline e metodo

La baseline conteneva 23 entry modificate/non tracciate. Sono state trattate
tutte come modifiche preesistenti. Il lavoro FIX 1–22 non è protetto da un
checkpoint Git completo: resta quindi un rischio operativo di perdita del
worktree, ma l'audit non ha creato commit.

Ambiente verificato:

- Node `v18.19.1`;
- Linux `x64`;
- suite e benchmark senza rete, provider reali o prototipi;
- file temporanei esclusivamente sotto `os.tmpdir()`;
- `git diff --check` globale già non pulito in baseline per whitespace
  preesistente in `chat_orbitale_ollama.js` alle righe 206, 535, 537, 542,
  793, 794, 799 e 810.

Sono stati letti integralmente l'audit originario, l'Evolution Log, i contratti
disponibili dei FIX 1–22, i moduli toccati dalla remediation e le suite
dedicate/regressive. Sono stati inoltre caricati in modo controllato otto
moduli senza side effect e ispezionate le capability storage.

## 3. Tabella finding originale → prova → stato

| Finding | Prova indipendente | Stato |
|---|---|---|
| `AUD-P1-004` privacy journal | descriptor claim minimo; rifiuto ricorsivo di identity top-level/nested/array/casing/value; scansione JSONL; lettura legacy con soli flag/count | **RESOLVED** |
| `AUD-P1-001` multi-cluster | A committed/B claimed, interleaving, incomplete-first, 12 cluster, correlazioni contraddittorie e recovery solo B | **RESOLVED** |
| `AUD-P1-003` failure lifecycle | eccezione, timeout, non-ok, JSON/schema/provenance invalidi, ACK failure pre/post mutation, restart storage-first e due policy di continuazione | **RESOLVED** |
| `AUD-P1-002` single user lock | una acquire/release, handle unico, writer memory/cluster, recovery concorrenti, utenti distinti, stale plan, rollback/release/ACK failure | **RESOLVED** |
| `AUD-P2-001` status restart | unknown iniziale, refresh persistente, incomplete/needs reconciliation/blocked/corrupt/tail/stale lock, generation-safe refresh | **RESOLVED** |
| `AUD-P2-002` composizione | registro completo A01–G45, componenti reali, failure injection e verifica memory/cluster/journal/lock | **RESOLVED** |
| `AUD-P2-003` scala | benchmark 40.000, tre run, 40.000 decisioni/run, un planId, mediana e RSS entro budget | **RESOLVED** |
| `AUD-P2-004` vector hydration | nessun import runtime del vector adapter; provider/collection espliciti; JSON dichiarato autorevole; nessuna hydration runtime | **ISOLATED / DEFERRED** |
| `AUD-P3-001` rischi documentali storici | cronologia append-only preservata e stato corrente aggiunto in coda | **DEFERRED**, non blocker |
| `AUD-P3-002` leggibilità moduli/test | comportamento coperto, ma alcuni file restano molto compressi | **DEFERRED**, non blocker |

## 4. Privacy journal — AUD-P1-004

Il percorso reale è `createSourceClaimPlan()` →
`createJournalSourceClaimDescriptor()` → `HippocampusDaemon` →
`HippocampusJournal.append()`. Il descriptor journal-safe conserva soltanto
schema, claim ID, attempt ID, claimed time e precondizioni tecniche delle
source; il `userId` usato internamente per ripristinare il piano non viene
serializzato (`core/hippocampus/SourceClaimTransaction.js:116`).

La validazione del journal attraversa ricorsivamente oggetti e array, normalizza
le chiavi per casing/separatori, confronta anche valori annidati e usa un
`WeakSet` per i cicli (`core/hippocampus/HippocampusJournal.js:51`). Le prove
hanno coperto `userId`, `USER_ID`, `UserIdentifier`, identità sentinella dentro
un valore e strutture circolari. Gli errori non ristampano la sentinella.

I record V1 restano leggibili; l'identità legacy è riportata soltanto tramite
`legacyPrivacyDetected` e `legacyPrivacyEventCount`
(`core/hippocampus/HippocampusJournal.js:113-135`). Nessuna migrazione o
riscrittura automatica è stata osservata. Report, recovery plan, eventi letti e
JSONL corrente risultano privi delle sentinelle utente/provider e dei campi
privati vietati.

**Verdetto specifico:** `RESOLVED`.

## 5. Correlazione multi-cluster — AUD-P1-001

La correlazione per unità di lavoro usa il dominio versionato
`hippocampus.cluster-work-v1` su `runId + clusterId`; claim ID, attempt ID e set
source sono poi verificati nel lifecycle
(`core/hippocampus/HippocampusJournal.js:196`). La sequence resta globale,
mentre gli eventi sono aggregati per cluster senza assumerne la contiguità.

Le riproduzioni hanno dimostrato che:

- `COMMIT_SUCCEEDED` termina soltanto il cluster correlato;
- A committed e B claimed produce `MULTI_CLUSTER_INCOMPLETE` e recovery solo B;
- primo cluster incompleto/secondo terminale e ordine interleaved restano
  separati;
- dodici cluster vengono ricostruiti senza top five;
- attempt, claim o source condivisi in modo contraddittorio bloccano il run;
- un evento run-level terminale con cluster non terminali è respinto con
  `RUN_TERMINAL_WITH_NONTERMINAL_CLUSTER`
  (`core/hippocampus/HippocampusJournal.js:251-257`);
- recovery ripetuta non modifica A e non crea una seconda super-memory.

**Stato:** `RESOLVED`.

## 6. Lifecycle delle failure — AUD-P1-003

Per una failure ordinaria successiva al claim, la sequenza verificata è:

`SOURCES_CLAIMED` → `SYNTHESIS_STARTED` → `SYNTHESIS_FAILED` → persistenza
`synthesizing → failed` → verifica revision/attempt/error → `SOURCES_FAILED` →
`RUN_FAILED`.

Il daemon emette l'evento di causa prima della transizione, verifica lo stato
persistito e solo dopo emette l'ACK delle source
(`core/hippocampus/HippocampusDaemon.js:325-369`). Sono stati riprodotti timeout,
eccezione, response non-ok, JSON invalido e schema/provenance invalida. Le source
arrivano a revision 3 una sola volta, mantengono l'attempt e usano
`HIPPOCAMPUS_CLUSTER_FAILED` retryable senza messaggio provider.

Se l'append della causa fallisce prima della mutazione, le source restano
`synthesizing` e il report è `needs_reconciliation`; se fallisce l'ACK dopo la
mutazione, la recovery riconosce storage-first lo stato `failed`, completa il
journal e non incrementa nuovamente la revision. Con
`continueOnClusterFailure: true` un cluster fallito non nasconde quello
successivo; con `false` il run viene chiuso coerentemente dopo il cluster
fallito. Non sono stati osservati terminali falsi.

**Stato:** `RESOLVED`.

## 7. Recovery e lock — AUD-P1-002

`executeRecovery()` acquisisce il lock utente una volta, rilegge journal e
dataset, rivalida fingerprint/precondizioni, applica e verifica tutte le azioni,
quindi rilascia in `finally` (`core/hippocampus/RecoveryManager.js:320-407`). Lo
stesso handle viene passato alle primitive di mutazione. Gli ACK journal sono
emessi soltanto dopo la release, quindi user lock e journal lock non sono
detenuti insieme.

Le prove con componenti concreti hanno verificato:

- acquire/release `1/1` e identità dello stesso handle;
- writer memory e cluster dello stesso utente in attesa;
- due recovery dello stesso utente serializzate;
- utenti differenti indipendenti;
- `STALE_RECOVERY_PLAN` se dataset, revision o attempt cambiano durante
  l'attesa, senza mutazione recovery;
- handle estraneo/contraffatto rifiutato;
- stop dopo la prima azione fallita e rollback sotto lo stesso lock;
- rollback fallito come stato unknown, senza falso ACK;
- release failure sanitizzata;
- ACK failure post-dati come `needs_reconciliation`, seguito da retry
  idempotente.

La recovery stale-lock resta prudente: PID vivo non viene rimosso e host non
verificabile viene bloccato. Snapshot/rollback generali restano unsupported;
sono presenti soltanto rollback circoscritti già contrattualizzati.

**Stato:** `RESOLVED`.

## 8. Status persistente dopo restart — AUD-P2-001

Una nuova istanza nasce con `statusHydrated: false`, recovery `unknown` e
`recoveryRequired: null`, quindi non dichiara un falso ready
(`core/hippocampus/HippocampusDaemon.js:80-89`). `refreshStatus()` ricava lo
stato da journal, recovery manager e storage, e una generation locale impedisce
a un refresh lento precedente di sovrascrivere quello più recente
(`core/hippocampus/HippocampusDaemon.js:149`).

Le nuove istanze sugli stessi file temporanei hanno distinto correttamente:
ready su journal vuoto, recovery required su run incompleto, needs
reconciliation su source failed o commit senza ACK, blocked su ambiguità,
corrupt su corruzione intermedia e flag di tail/stale lock senza mutazione. Dopo
recovery il ready compare soltanto in seguito a un nuovo refresh persistente.
`getStatus()` restituisce una copia profondamente congelata e il preflight
commit forza sempre un refresh (`core/hippocampus/HippocampusDaemon.js:233-235`).

**Stato:** `RESOLVED`.

## 9. Matrice compositiva — AUD-P2-002

Il registro contiene esattamente i 45 ID stabili A01–G45, senza duplicati o
mancanze. I 45 scenari sono distribuiti in test espliciti, non in un golden
opaco. La matrice usa le implementazioni reali di storage, lock, journal,
recovery, daemon, claim, transaction, processing, cluster e synthesis; sono
mockati soltanto embedding/model provider, clock e failure point.

Le asserzioni verificano stato memoria, raw/unknown fields, revision,
super-memory, cluster, sequence/fingerprint journal, lock residui, report e
privacy. Ogni ambiente crea directory con `fs.mkdtempSync(os.tmpdir())` e
registra la rimozione con `t.after`, che viene eseguito dal test runner anche in
caso di failure. Alcuni ID sono raggruppati nello stesso test perché condividono
il medesimo failure point; le prove di concorrenza e release sono inoltre
duplicate nelle suite dedicate FIX 19. Non sono stati rilevati stub tautologici
al posto delle primitive oggetto dell'audit.

**Stato:** `RESOLVED`.

## 10. Scala e budget — AUD-P2-003

La pipeline scalabile proietta ogni memoria ai soli campi di selezione, calcola
SHA-256 sul testo esatto e non trattiene content/meta/entities/source snapshot.
Il batching è operativo, con default 500, mentre `maxCandidates` resta una
policy semantica distinta (`core/consolidation/CandidateSelector.js:118-136` e
`:348-376`). La deduplica resta globale perché la decisione finale opera su
tutte le proiezioni.

Benchmark indipendente:

| Misura | Risultato |
|---|---:|
| record | 40.000 |
| batch size | 500 |
| run misurati | 3, dopo warm-up |
| generazione input, esclusa | 261,898 ms |
| elapsed run 1 | 2.800,454 ms |
| elapsed run 2 | 2.829,514 ms |
| elapsed run 3 | 2.630,292 ms |
| mediana elapsed | **2.800,454 ms** |
| RSS delta run 1 | 96.964.608 byte |
| RSS delta run 2 | 21.692.416 byte |
| RSS delta run 3 | 17.104.896 byte |
| massimo RSS delta | **96.964.608 byte (92,47 MiB)** |
| budget | 9.500 ms / 128 MiB |
| esito | **PASS** |

Ogni run ha prodotto 40.000 decisioni, senza troncamento, con lo stesso planId.
Il runner usa `process.hrtime.bigint()`, `process.memoryUsage().rss`, dataset
deterministico, warm-up e `--expose-gc`; la correttezza non dipende dalla
presenza di GC. La telemetria contiene soltanto contatori, tempi, RSS, budget e
versione algoritmo, e non entra nel planId
(`core/consolidation/ConsolidationPlan.js:100-128`). I test separati verificano
deduplica cross-batch, batch size 1/7/100/500/1000, map/array, ordine input e
separazione da `maxCandidates`.

**Stato:** `RESOLVED`.

## 11. Risultati delle suite

| Esecuzione | Test | Pass | Fail | Skip | Durata TAP |
|---|---:|---:|---:|---:|---:|
| FIX 16–22 dedicati | 84 | 84 | 0 | 0 | 19.350 ms |
| matrice FIX 20 separata | 18 | 18 | 0 | 0 | 12.060 ms |
| suite completa FIX 1–22 | 369 | 369 | 0 | 0 | 25.762 ms |

Sono stati eseguiti `node --check` su 26 JavaScript di produzione coinvolti,
tutti validi. Non sono comparsi warning, handle aperti, rejection non gestite,
cancel o todo. La suite completa comprende storage/capability/atomic,
transaction, journal/recovery/daemon, recall, synthesis e vector adapter.

Le capability ispezionate manualmente riportano supported/verified per
memory read/write, cluster readAll/readOne/writeOne, atomic single-file commit e
lock acquire/release; snapshot e rollback generali restano unsupported.

## 12. Scansioni runtime e vector path

La scansione degli import non trova riferimenti a `VectorIndexAdapter` o
`VectorIndexRecord` fuori da `core/vector` e dai test. RecallRouter, daemon,
chat, bridge e storage non lo istanziano. L'adapter richiede esplicitamente
provider, collection, dimension e distance e non contiene endpoint, `fetch`,
API key o creazione automatica della collection. Non esiste provider Qdrant
reale, query embedding provider, hydration contro JSON o configurazione runtime.

Il vector path è quindi realmente disabilitato per assenza di wiring e
fail-closed all'istanziazione. JSON resta la fonte autorevole. `AUD-P2-004`
diventa blocker prima, e soltanto prima, di collegare vector search al runtime:
ogni point dovrà essere reidratato dal JSON e verificato per content hash. Il
vector path è esplicitamente fuori scope dall'Activation Gate qui consigliato.

Le ulteriori scansioni non hanno trovato:

- endpoint/rete/provider reali nei moduli Ippocampo/remediation;
- auto-start del daemon (il solo `setInterval` è dentro `start()` esplicito e
  accetta esclusivamente dry-run);
- import dei prototipi Hippocampus nel runtime nuovo;
- uso di `ColdMemoryCompressor` nella pipeline di consolidamento;
- limiti impliciti 5/100 nei nuovi moduli;
- write dirette al dataset fuori da `JsonMemoryStorage`/`AtomicJsonCommit`;
  le write ulteriori appartengono esclusivamente a lock file e journal JSONL.

Il legacy `Keblomemory` continua a importare `ColdMemoryCompressor`, ma questo è
un percorso storico separato e non viene usato dall'Ippocampo.

## 13. Rischi residui

1. **P2 condizionale — vector hydration:** `AUD-P2-004` resta aperto ma isolato.
   È obbligatorio prima di qualunque vector path, non per il Gate con vector
   disabilitato.
2. **P3 documentazione:** alcune sezioni storiche possono sembrare obsolete se
   lette fuori dalla cronologia append-only. Non altera il comportamento.
3. **P3 manutenibilità:** alcuni moduli/test restano compressi e più difficili
   da revisionare. La copertura è verde; un refactor resta rinviabile.
4. **Worktree non protetto:** i file FIX 1–22 sono in larga parte non tracciati.
   Prima di attività operative serve un checkpoint Git controllato esterno a
   questo audit.
5. **Limiti dichiarati:** non esistono recovery distribuita, journal
   transazionale col dataset, provider reali, migrazione legacy o rollback
   generale. Sono non-obiettivi dichiarati, non regressioni.

## 14. Inventario per l'Activation Gate

### 14.1 Prerequisiti già implementati

- dry-run di default e commit con doppia autorizzazione;
- provider iniettati, versionati e senza endpoint hardcoded;
- maturity gate con approval esplicita;
- journal persistente sanitizzato e recovery storage-first;
- lock utente, optimistic precondition e replay idempotente;
- status persistente conservativo e preflight sempre aggiornato;
- batching candidato e budget 9.500 ms/128 MiB;
- report/eventi senza contenuto memoria;
- vector path non cablato.

### 14.2 Configurazioni normali mancanti per il Gate

- embedding provider reale con ID/modello/versione espliciti;
- synthesis provider Qwen/Ollama reale con modello/versione ed endpoint in
  configurazione, non nel core;
- timeout input/output e dimensioni prompt validate;
- directory journal e lock con permessi/spazio verificati;
- utente DEV dedicato;
- `batchSize`, `maxCandidates`, `maxClustersPerRun` e limiti synthesis espliciti;
- `approvedClusterIds` o policy di approval manuale;
- token commit custodito e assente dal dry-run;
- metriche, soglie di stop e revisione umana del report.

Queste sono attività del Gate, non blocker di codice emersi dall'audit.

### 14.3 Preparazione dati e operazioni

- backup/snapshot operativo e verifica dello spazio disco;
- primo dry-run sul dataset DEV senza commit;
- revisione umana di candidate, cluster, maturity e stime prompt;
- staging su copie sintetiche;
- procedura documentata per stale lock, tail repair e recovery;
- rollback operativo circoscritto e criterio di stato unknown;
- primo commit canary su copie/staging, con stop immediato su reconciliation;
- vector path esplicitamente disabilitato in configurazione e checklist.

### 14.4 Attività separate

La migrazione/inizializzazione `processing: raw` dei circa 40.000 ricordi legacy
resta separata e non deve essere implicita. Anche la pipeline Keblo nuovo → nuovo
ricordo → raw → Ippocampo sarà verificata separatamente dopo il Gate. Il merge
nel server Keblo è successivo al dry-run, alla review e al canary; `server.js`
non è stato modificato né validato per attivazione in questo audit.

### 14.5 Veri blocker di codice

Nessun blocker P0/P1 è stato trovato per iniziare un dry-run DEV controllato
con vector path disabilitato. `AUD-P2-004` diventa blocker se e quando il vector
path viene abilitato.

## 15. Integrità dei dati reali

Sono stati confrontati prima, durante e dopo test/benchmark gli 11 file dati
inventariati, senza leggerne o stamparne il contenuto:

| Gruppo | File | Size baseline |
|---|---|---:|
| backup chat | `francesco_links.json` | 24.306 |
| backup chat | `francesco_memories.json` | 60.658 |
| keblo | `keblo_user_links.json` | 2 |
| keblo | `keblo_user_memories.json` | 13.266 |
| chat reale | `francesco_links.json` | 16.955.431 |
| chat reale | `francesco_memories.json` | 95.060.415 |
| chat reale | `francesco_memory_events.jsonl` | 123.800 |
| bridge diagnostico | `francesco_bridge_diag_links.json` | 394 |
| bridge diagnostico | `francesco_bridge_diag_memories.json` | 1.542 |
| JSON diagnostico | `francesco_json_diag_links.json` | 394 |
| JSON diagnostico | `francesco_json_diag_memories.json` | 1.493 |

Per tutti gli 11 file SHA-256, size e mtime coincidono esattamente tra baseline
e controllo finale. Gli hash completi sono stati usati per il confronto locale
ma non sono riportati qui. Nessun test ha puntato alle directory reali.

## 16. Conclusione operativa

I finding `AUD-P1-001`…`004` e `AUD-P2-001`…`003` risultano chiusi da codice,
prove dedicate, matrice compositiva e regressione completa. Commit, recovery e
status falliscono in modo conservativo; privacy e correlazione multi-cluster
sono preservate; la scala sintetica è entro budget. Non risultano nuove
regressioni P0/P1.

Il verdetto è **`READY_FOR_ACTIVATION_GATE`**, a condizione che il Gate:

1. mantenga commit reale disabilitato durante la preparazione e il primo
   dry-run;
2. mantenga il vector path esplicitamente fuori scope/disabilitato;
3. configuri provider, directory, budget, approval e procedure operative prima
   di qualunque canary;
4. non tratti implicitamente memorie legacy come raw.

L'Activation Gate non è stato eseguito da questo audit e nessun codice è stato
corretto.
