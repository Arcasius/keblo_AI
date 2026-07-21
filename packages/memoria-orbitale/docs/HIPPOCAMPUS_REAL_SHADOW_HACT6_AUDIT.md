# HACT-6 — Real SHADOW audit and production gap analysis

## Stato, scope e verdetto

**Stato:** `VERIFIED`

**Verdetto:** `REAL_SHADOW_VERIFIED_READY_FOR_COMMIT_BRIDGE_DESIGN`

Audit eseguito in modalità strettamente read-only su codice, contratti,
documentazione, report aggregati disponibili e file autorevole. Non sono stati
contattati server o provider, non è stata rilanciata una SHADOW run e non sono
stati avviati daemon. Nessun codice, test, file di configurazione, cache o dato
è stato modificato. La queue legacy non contiene HACT-6 e non è stata
aggiornata; HACT-6 non è marcato automaticamente `completed`.

Il verdetto autorizza soltanto il design di HACT-7. LIVE, commit, daemon e
wiring chat restano non autorizzati.

## Evidenza considerata

L'audit usa esclusivamente:

- prima run reale da 20: 20 candidati, 20 cache create, zero cluster e zero
  commit;
- rerun reale da 20: 20 hit, zero create, 20 certificati exact, cache e memoria
  autorevole invariate, zero processing-state write e zero commit;
- run reale con limite 100: 99 candidati, 20 hit, 79 create, 99 certificati
  exact, 5 cluster, zero componenti deferred, 5 SuperMemory simulate, 6 letture
  autorevoli, zero write autorevoli, zero processing-state write e zero commit;
- contratti e implementazioni già presenti nel repository.

Non è presente un artifact completo della run da 100 con piano, membership,
cluster summary o SuperMemory temporanee. Il control-plane e il runtime
standalone espongono deliberatamente soltanto metriche aggregate.

## Audit deterministico 99/100

### Risultato aggregato della ricostruzione offline

La ricostruzione pura ha letto l'unico file autorevole configurato con almeno
100 record, ha applicato la projection HACT-4 e il planner esistenti senza
provider, senza cache e senza write. Non sono stati stampati ID, testi, hash o
metadata.

```json
{
  "sourceCount": 40774,
  "projectedCount": 100,
  "selectedCount": 99,
  "plannedCount": 99,
  "materializedCount": 99,
  "identityIndexCount": 99,
  "clusteredOrUnclusteredCount": 99,
  "deferredCount": 0
}
```

Contatori supplementari della sola barriera projection/planner:

```json
{
  "projectedEligibleCount": 40774,
  "projectionExclusionCount": 0,
  "plannerExcludedCount": 1,
  "plannerDuplicateContentCount": 1,
  "plannerDuplicateIdCount": 0,
  "plannerDeferredCount": 0,
  "limitTruncated": false
}
```

`materializedCount` e `identityIndexCount` sono 99 perché la barriera globale
accetta il risultato soltanto se totale, identità materializzate e somma
hit/create/replay coincidono col numero di sorgenti. I dati reali 20 hit + 79
create e 99 certificati exact confermano la barriera completa.
`clusteredOrUnclusteredCount` è 99 per la coverage totale e disgiunta imposta
dal bounded plan: con zero deferred ogni identità deve essere in un cluster
finale o in un componente terminale sotto `minClusterSize`. Il report esterno
non conserva la ripartizione fra i due insiemi.

### Significato esatto di `maxCandidates`

Nel runner reale il limite viene applicato due volte con la stessa soglia, ma
su insiemi diversi:

1. `LegacyFlatMemoryShadowProjection` ordina lessicograficamente tutte le
   identità eleggibili e prende al massimo le prime 100;
2. `CandidateSelector` rivalida i 100 descriptor, li ordina deterministicamente,
   deduplica identità e contenuto e soltanto dopo applica il proprio limite.

Il primo limite ha quindi già ridotto l'input del planner a 100. Il planner ha
escluso uno dei descriptor perché il suo SHA-256 del testo UTF-8 esatto era già
presente. Sono rimaste 99 candidate; il secondo limite non è entrato in azione
e `truncated` è correttamente false.

`maxCandidates=100` significa dunque **massimo numero di descriptor ammessi
dalla projection e massimo numero di eleggibili ammessi dal planner**, non
"restituisci esattamente 100 candidate dopo ogni validazione".

### Barriere verificate

| Barriera | Prima | Dopo | Motivo della differenza |
| --- | ---: | ---: | --- |
| storage read-only | 40.774 | 40.774 | nessuna |
| legacy eligibility | 40.774 | 40.774 | esclusioni projection tutte a zero |
| limite projection | 40.774 | 100 | limite esplicito e ordinamento canonico |
| candidate validation/dedup | 100 | 99 | 1 `DUPLICATE_CONTENT` |
| limite planner | 99 | 99 | non applicato; 99 non supera 100 |
| consolidation plan | 99 | 99 | candidate IDs coerenti con decisioni eligible |
| materialization | 99 | 99 | 20 hit + 79 create, barriera completa |
| current identity index | 99 | 99 | una identità corrente per materializzazione |
| exact discovery | 99 | 99 | 99 certificati validi |
| clustering disposition | 99 | 99 | coverage cluster/unclustered, zero deferred |

Non esiste un record sottratto come query o seed: exact discovery esegue una
query per ciascuna delle 99 identità e il refiner usa seed soltanto come ruolo
interno senza rimuoverlo dalla coverage. Non emerge alcun off-by-one.

Snapshot membership e identity projection sono fail-closed: identità duplicate
o point duplicate sono vietati, modello/revisione devono essere uniformi e il
fingerprint lega l'intero snapshot. Il `contentHash` viene calcolato sul testo
esatto dalla projection, ricalcolato dal selector, verificato nella source
normalization e verificato di nuovo sulla rilettura autorevole prima della
synthesis. Il processing state `raw` usato in SHADOW è una projection RAM, non
un dato persistito.

### Classificazione 99/100

Non è perdita silenziosa, non è errore di conteggio e non è off-by-one. È
semantica intenzionale di deduplica per contenuto, con reason code già presente
nel consolidation plan. È però incompleta l'auditabilità del report reale: le
metriche pubbliche espongono `candidateCount:99` ma non `projectedCount:100`, le
statistiche del planner o `DUPLICATE_CONTENT:1`.

## Audit dei cinque cluster e delle cinque SuperMemory RAM

### Evidenza aggregata e implicazioni del percorso riuscito

| Proprietà | Esito HACT-6 | Base probatoria |
| --- | --- | --- |
| cluster riusciti | 5 | `clusterCount:5` |
| componenti deferred | 0 | `deferredComponentCount:0` |
| membership disgiunta e coverage | runtime-enforced | il bounded plan validato rifiuta overlap e coverage incompleta |
| `minClusterSize=3` | runtime-enforced | il piano rifiuta cluster finali più piccoli |
| `minimumPairSimilarity >= 0.70` | runtime-enforced | refiner e ricostruzione ClusterRecord ricalcolano tutte le coppie |
| `discoveryComplete` | runtime-enforced | un cluster finale accetta solo `COMPLETE_ABOVE_THRESHOLD` |
| content hash verificato prima della synthesis | runtime-enforced e corroborato | una lettura iniziale + una rilettura per ciascuno dei 5 cluster = 6 letture |
| temporal provenance valida | runtime-enforced | provenance e request temporale sono validate prima della rilettura/synthesis |
| chiamate Qwen riuscite | 5 | 5 cluster summary, zero blocked/deferred; una chiamata per cluster |
| SuperMemory schema validation | 5 | `simulatedSuperMemoryCount:5`, valorizzato solo se tutte le temporanee sono valide |
| persistenza SuperMemory | 0 | temporanee non incluse nel risultato, zero write e zero commit |
| commit | 0 | `commitCalls:0` |

Il contatore deferred del risultato è somma dei componenti deferred del piano e
dei cluster bloccati durante temporal/reread/cluster-record/Qwen/SuperMemory.
Il valore zero, insieme a cinque cluster riusciti, dimostra che nessuno dei
cinque è stato bloccato. Il ciclo incrementa il contatore synthesis una sola
volta subito prima di ogni chiamata provider; il percorso osservato implica
quindi cinque chiamate Qwen riuscite, non chiamate aggiuntive nascoste.

### Evidenza per-cluster non conservata

Per ciascuna delle proprietà seguenti il codice impone il vincolo, ma gli
artifact disponibili non conservano il valore o la membership dei singoli
cluster:

- membership del cluster 1–5: `EVIDENCE_NOT_PERSISTED`;
- dimensione del cluster 1–5: `EVIDENCE_NOT_PERSISTED`;
- `minimumPairSimilarity` del cluster 1–5: `EVIDENCE_NOT_PERSISTED`;
- certificate fingerprint/discovery status per membro: `EVIDENCE_NOT_PERSISTED`;
- temporal range e timestamp quality per cluster: `EVIDENCE_NOT_PERSISTED`;
- fingerprint della rilettura/content hash per cluster: `EVIDENCE_NOT_PERSISTED`;
- SuperMemory record/fingerprint/idempotency key temporanei: `EVIDENCE_NOT_PERSISTED`;
- numero di identità nei cluster rispetto agli unclustered: `EVIDENCE_NOT_PERSISTED`.

Non è possibile elevare queste garanzie runtime a prova forense per-cluster
senza un artifact aggregato aggiuntivo. HACT-6 non inventa tale prova e non
rilancia la run.

## Confine memoria autorevole e runtime SHADOW

Il runner standalone costruisce un adapter autorevole dedicato che espone solo
`inspect`, lettura iniziale, rilettura per membership e contatore letture. Non
espone `save`, `write`, `rename`, delete, lock o atomic commit. Le uniche write
consentite dal runner SHADOW sono create/upsert nella collection embedding cache
dedicata; il provider controllato blocca le altre collection.

La composition rifiuta LIVE, non riceve storage writer o commit capability e
rifiuta un risultato con `authoritativeMemoryWrites != 0`, `commitCalls != 0`
o `realDataModified != false`. Il report finale forza inoltre
`processingStateWrites:0`. La projection legacy crea `processingState:raw`
soltanto in oggetti frozen in RAM e dichiara esplicitamente
`processingStatePersisted:false`.

Le SuperMemory temporanee sono create e validate dentro la funzione di run,
poi ridotte a summary aggregate; non sono restituite al composition root e non
esiste una chiamata storage nel bounded adapter. La run da 100 conferma zero
write autorevoli, zero processing-state write e zero commit. Nessun collegamento
dal runner standalone raggiunge recall o chat.

## Componenti riutilizzabili e gap di produzione

### Riutilizzabile senza cambiare contratto

- `SuperMemoryRecord`: schema, fingerprint, idempotency key, coverage delle
  source e validation sono già utilizzabili.
- `ConsolidationTransaction`: verifica optimistic state/content hash,
  idempotent replay, singola mappa next-state, commit atomico e verifica
  post-commit sono già utilizzabili.
- `AtomicJsonCommit`, file lock e `JsonMemoryStorage`: write atomica con lock e
  capability esplicite sono già disponibili.
- `ProcessingState` e `SourceClaimTransaction`: transizioni
  `raw → candidate → synthesizing → consolidated/failed`, revisioni e claim
  idempotente sono già disponibili.
- `HippocampusJournal` e `RecoveryManager`: journal persistente, ispezione,
  recovery plan, tail/stale-lock handling e reconciliation sono già disponibili.
- `HippocampusDaemon`: single-process guard, commit token, recovery preflight,
  limiti per run e failure closure sono riutilizzabili.
- `RecallRouter`, `LegacyRecallAdapter` e `chat_orbitale_ollama`: il percorso
  core/warm/deep read-only, la soppressione delle source coperte e il bootstrap
  chat sono già presenti.

### Gap esatti prima di LIVE

1. Il bounded runtime non restituisce un commit payload: cluster record,
   synthesis result, SuperMemory temporanea, source content hashes e temporal
   evidence restano locali e vengono scartati dopo la summary.
2. Le source legacy autorevoli non hanno processing state persistito. La
   projection `raw` SHADOW non può essere usata come precondizione di commit;
   `SourceClaimTransaction` rifiuta correttamente source senza `processing.raw`
   esplicito. Serve una policy/bridge autorizzata, atomica e verificabile, non il
   riuso silenzioso della projection.
3. Il daemon principale usa ancora il vecchio `ClusterEngineAdapter` nel
   percorso `runOnce`; il bounded adapter è esposto soltanto come
   `runBoundedSynthetic()` laterale e non entra in claim/journal/commit.
4. Il commit bridge deve legare lo stesso identity snapshot e gli stessi
   content hash verificati a claim, synthesis artifact e transaction, senza
   rieseguire clustering o Qwen e senza affidarsi a oggetti mutabili.
5. Il report pubblico non conserva contatori projection/planner, reason counts,
   unclustered count, cluster sizes, min-similarity aggregate, synthesis calls o
   fingerprint di audit non sensibili. Questo non corrompe dati, ma impedisce
   una verifica forense completa della run da 100.
6. Non esiste un composition root che avvii il nuovo bounded runtime dal daemon
   o dalla chat. Scheduler e chat non devono acquisire implicitamente capability
   commit.

### Stato preciso di `chat_orbitale_ollama`

La chat è già collegata a `RecallRouter`: crea `JsonMemoryStorage` sul proprio
data directory, `KebloMemory`, `LegacyRecallAdapter` e un router, quindi usa il
router per il recall. Il router riconosce una `SuperMemoryRecord` come core
soltanto con `memoryKind:super_memory` e `storageTier:core`, e può sopprimere le
source coperte.

La chat **non** importa il composition root HACT, il bounded runner,
`HippocampusDaemon`, journal/recovery o commit bridge; non avvia Ippocampo e non
consuma le cinque SuperMemory RAM della run reale. Una futura SuperMemory
committata diventerebbe richiamabile soltanto se HACT-7 la persiste nello stesso
storage e scope utente usati dalla chat. L'identità effettiva fra data directory
runtime configurata e data directory relativa della chat non è oggi garantita
da un wiring condiviso.

## Finding

### P0

Nessun finding P0. Le evidenze non mostrano perdita o corruzione; la memoria
autorevole è rimasta invariata e il 99/100 è interamente spiegato.

### P1

- **HACT6-P1-001 — Commit bridge assente e processing legacy non committabile.**
  Un collegamento diretto delle source proiettate violerebbe la precondizione
  persistente `processing.raw`. È bloccante per LIVE, non per il design HACT-7.
- **HACT6-P1-002 — Artifact bounded non trasferibile al commit.** Il runtime
  scarta gli oggetti necessari a costruire una transaction legata allo snapshot;
  ricostruirli dopo la run aprirebbe una finestra di identità/staleness non
  autorizzata.

### P2

- **HACT6-P2-001 — Causa 99/100 assente dal report pubblico.** Projection count,
  planner exclusions e reason counts non sono esposti.
- **HACT6-P2-002 — Evidenza cluster non persistita.** I vincoli sono enforced
  ma membership, size, minimum similarity e provenance per-cluster sono
  `EVIDENCE_NOT_PERSISTED`.
- **HACT6-P2-003 — Metriche finali ambigue/incomplete.** `clusterCount` conta
  summary riuscite; unclustered identities/components e `synthesisCalls` non
  attraversano il wrapper standalone.
- **HACT6-P2-004 — Bounded runtime isolato da daemon e chat.** Il metodo daemon
  laterale non alimenta il percorso transazionale e la chat vede soltanto dati
  già persistiti dal proprio storage.

### P3

- **HACT6-P3-001 — Nomenclatura di `maxCandidates`.** Il nome è coerente col
  significato "massimo", ma senza i contatori di barriera può essere letto
  erroneamente come cardinalità target.

## Piano minimo: tre FIX

### HACT-7 — Commit bridge

Definire e verificare un bridge esplicito dal risultato bounded validato a
source claim, journal e `ConsolidationTransaction`. Il bridge deve conservare
snapshot/content-hash identity, esporre artifact frozen sufficienti senza
contenuto nei log, risolvere esplicitamente l'inizializzazione atomica del
processing state legacy e mantenere commit disabilitato per default. Acceptance:
replay idempotente, stale reread fail-closed, recovery/journal coerenti, singolo
commit atomico e nessuna seconda synthesis.

### HACT-8 — Daemon/chat integration

Sostituire, dietro configurazione esplicita, il percorso bounded laterale del
daemon con l'orchestrazione HACT-7; conservare scheduler dry-run-only e doppia
autorizzazione commit. Condividere in modo esplicito storage/user scope con la
chat. La chat resta consumer read-only via `RecallRouter`: nessun commit dal
turno chat e nessun daemon auto-start all'import. Acceptance: una SuperMemory
persistita fake è visibile nel tier core, le source coperte sono soppresse e i
percorsi OFF/SHADOW non mutano.

### HACT-9 — Controlled LIVE pilot

Eseguire un solo pilot LIVE bounded con limite e cluster approval espliciti,
backup/hash pre e post, journal/recovery ready, commit token manuale, stop
cooperativo e verifica post-commit/replay/recall. Nessun cleanup o delete raw.
Acceptance: esattamente i commit approvati, processing state coerente,
SuperMemory richiamabile dalla chat, nessun artifact ambiguo e rollback/recovery
operativo secondo contratto.

Non sono necessari ulteriori fix prima di questi tre; HACT-7 deve chiudere i due
finding P1 prima che HACT-9 possa essere autorizzato.

## Verifica riproducibile HACT-6

- ricostruzione offline projection/planner: PASS, 100 → 99 con un solo
  `DUPLICATE_CONTENT`;
- scansione statica write boundary SHADOW: PASS;
- audit bounded cluster/SuperMemory/temporal/reread: PASS con limiti di evidenza
  dichiarati;
- audit commit/storage/processing/journal/recovery/daemon/recall/chat: PASS;
- rete, provider, SHADOW run, daemon, commit applicativo e commit Git: non
  eseguiti.

