# HIPPOCAMPUS ACTIVATION HACT-9

## Esito

HACT-9 ha introdotto un composition boundary separato, esclusivamente one-shot,
che richiede simultaneamente LIVE, flag pilot, token esatto, user scope
`francesco`, `maxCommits=1`, limite candidati esplicito non superiore a 100,
capability server-side, storage attested, preflight completa e lock esclusivo.
Il daemon HACT-8 non è stato modificato e continua a rifiutare LIVE.

Il receipt pubblico è chiuso e sanitizzato. Non contiene user ID, source ID,
testi, hash contenuto, path, endpoint, payload, stack o segreti. Il backup manager
ordina i target, copia byte per byte con permessi `0700/0600`, rilegge e verifica
SHA-256 e dimensione; il rollback è consentito soltanto dopo una failure
successiva al commit e viene riverificato.

## Test prima del pilot

- HACT-9 fake: 9/9 PASS;
- token errato e limite maggiore di uno: fail-closed;
- capability assente: fail-closed;
- backup fallito: zero prepare/commit;
- source/hash stale: zero write;
- failure transazionale: recovery e rollback verificati;
- replay: zero duplicati e zero write;
- percorso fake riuscito: esattamente un commit e verifica diretta recall
  SuperMemory/raw obbligatoria;
- regressioni HACT-1→8, BC, commit/storage/processing/journal/recovery/RecallRouter:
  437/437 PASS;
- suite completa serializzata, una sola volta: 792/792 PASS.

## Unica invocazione reale

L'unico comando LIVE one-shot autorizzato è stato eseguito con token, utente,
limite candidati e limite commit esatti. La preflight ha restituito
`CONFIGURATION_INCOMPLETE` prima di storage, provider, bounded runtime, backup o
commit. Nessun retry o fallback è stato effettuato.

| Evidenza | Valore |
| --- | ---: |
| preflight | FAIL |
| cluster selezionati | 0 |
| source | 0 |
| SuperMemory create | 0 |
| authoritative reads | 0 |
| authoritative writes | 0 |
| processing-state writes | 0 |
| commit calls | 0 |
| file autorevoli toccati | 0 |
| backup | NOT_CREATED |
| recovery/rollback | NOT_NECESSARY |
| verifica RecallRouter post-commit | NOT_APPLICABLE |
| realDataModified | false |

Non esistono hash pre/post di file autorevoli perché nessun target è stato
aperto o modificato. I manifest sanitizzati registrano esplicitamente zero file
e zero diff. Non è stato avviato il daemon, non è stata interrogata la chat e
non è stato eseguito alcun commit Git.

## Confine tecnico preservato

Le source legacy reali non vengono promosse implicitamente dalla projection RAM
a processing state autorevole. Un eventuale prossimo tentativo richiede prima
configurazione completa dei servizi e, successivamente, un artifact bounded
trasferibile a HACT-7 con processing-state autorevole compatibile. In assenza di
questi confini il comando resta fail-closed.

## Verdetto

`HIPPOCAMPUS_CONTROLLED_LIVE_PILOT_BLOCKED`

Reason code: `CONFIGURATION_INCOMPLETE`.

## Continuation: boundary artifact e processing legacy autorevole

La continuation HACT-9 ha risolto i due confini applicativi senza modificare la
semantica generale HACT-7. Il bounded adapter espone internamente soltanto il
primo artifact finalizzabile a una capability legata a `francesco` e alla run
corrente. OFF e SHADOW non possiedono la capability e gli output pubblici
restano invariati.

`AuthoritativeLegacyProcessingBoundary` riconosce soltanto record flat approvati
dalla projection HACT-4, con key/id, scope e content hash correnti. L'assenza
completa di `processing` viene interpretata come `raw` canonico e trasformata in
RAM, mediante i contratti esistenti, in `candidate` e `synthesizing`. Processing
presente ma nullo, parziale o invalido, record strutturati incompatibili, scope
estraneo e hash stale falliscono chiusi. Senza questo adapter HACT-7 continua a
restituire `SOURCE_PROCESSING_STATE_CONFLICT`.

Il salvataggio atomico consente differenze soltanto sulle source autorizzate e
su una SuperMemory validata; le memorie estranee devono restare semanticamente
identiche. Gli stati virtuali vengono rimossi in rollback e non possono essere
persistiti. La provenance persistita sulle sole source distingue
`legacy_absence_derived` e `authoritative_commit`.

Test mirati PASS, regressioni focalizzate 686/686 PASS e suite completa
serializzata eseguita una sola volta 800/800 PASS.

La nuova singola LIVE autorizzata ha superato preflight, controllo concorrenza
e backup esterno verificato, ma si è fermata con `CONNECTION_RESET` nel bounded
runtime prima del primo artifact finalizzabile. Nessun retry è stato eseguito.
Il memory JSON è byte-identico al backup: 40.774 record, zero SuperMemory, zero
processing persistiti; journal ancora assente e lock rilasciato.

Verdetto continuation:

`HIPPOCAMPUS_CONTROLLED_LIVE_PILOT_BLOCKED`

Reason code: `CONNECTION_RESET`.

## Continuation — diagnosi riproducibile del reset

È stata aggiunta osservabilità HACT-9 a vocabolario chiuso: fase, provider,
operazione, ultima fase completata, elapsed e contatori parziali. Il receipt non
espone URL, chiavi, user ID, testi, payload, hash o point raw. Il percorso
diagnostico dedicato condivide la pipeline bounded e il limite di 100 candidati,
ma non costruisce la capability di commit né il bridge HACT-7; blocca ogni
upsert e termina sulla prima cache miss.

È stata eseguita una sola diagnostica reale read-only, senza retry o fallback.
La preflight è passata e la projection ha verificato 99 candidati; il run si è
fermato prima del primo lookup candidato durante la verifica della collection:

| Evidenza | Valore |
| --- | ---: |
| failurePhase | `CACHE_LOOKUP` |
| failureProvider | `QDRANT` |
| failureOperation | `VERIFY_CACHE_COLLECTION` |
| reasonCode | `QDRANT_UNAVAILABLE` |
| lastCompletedPhase | `PROJECTION` |
| elapsedMsAtFailure | 14311 |
| candidateCountVerified | 99 |
| cacheLookup / hit / miss | 0 / 0 / 0 |
| neighborQuery / exactCertificate / cluster | 0 / 0 / 0 |
| authoritative / processing writes | 0 / 0 |
| commit calls | 0 |
| realDataModified | false |

Il file autorevole è rimasto byte-identico e il lock è stato rilasciato. La
diagnostica non ha riprodotto `CONNECTION_RESET`: ha identificato con precisione
il boundary corrente, ma non la causa trasporto originaria. In osservanza del
gate richiesto non è stato applicato alcun fix al provider e non è stata
eseguita una nuova LIVE.

Test mirati: 77/77 PASS. La suite completa serializzata è stata avviata una sola
volta, ha terminato senza processi residui e nell'output disponibile non compare
alcun `not ok`; il riepilogo TAP finale è stato troncato dal limite di cattura e
non viene quindi dichiarato un conteggio totale non osservato.

Verdetto continuation:

`HIPPOCAMPUS_CONTROLLED_LIVE_PILOT_BLOCKED`

Reason code: `QDRANT_UNAVAILABLE` at
`CACHE_LOOKUP / QDRANT / VERIFY_CACHE_COLLECTION`.

## Continuation — Qdrant JSON Content-Length completion

Il difetto dimostrato nel client Qdrant è stato corretto esclusivamente in
`QdrantEmbeddingCacheProvider`: anche le risposte JSON con `Content-Length`
valido terminano quando il numero di byte ricevuti coincide esattamente con la
lunghezza dichiarata, senza attendere la chiusura della socket keep-alive. Le
risposte chunked ignorano qualsiasi falsa lunghezza e attendono la fine del
messaggio HTTP. Timeout, AbortSignal, parsing JSON, envelope, schema, status,
content-type e limiti sono invariati; nessun retry o fallback è stato aggiunto.

Verifiche in ordine:

- provider isolato: 25/25 PASS;
- singola chiamata reale `getCollectionInfo()`: `green`, `1024/Cosine`, 8
  payload index;
- singola diagnostica read-only: artifact finalizzabile, 99 candidati,
  203/203 cache hit, zero miss/upsert/write/commit, 99 certificati exact e 5
  cluster verificati;
- regressioni HACT-9: 52/52 PASS;
- suite completa serializzata, una sola volta: 806/806 PASS.

Prima della LIVE sono stati riverificati assenza di concorrenza/lock, zero
SuperMemory e backup esterno byte-verificato di memory+journal. L'unica LIVE
autorizzata ha tuttavia riprodotto un nuovo reset nella verifica iniziale della
collection, prima di lookup, artifact, backup interno o commit:

| Evidenza LIVE | Valore |
| --- | ---: |
| preflight | PASS |
| reasonCode | `CONNECTION_RESET` |
| failurePhase | `CACHE_LOOKUP` |
| failureProvider | `QDRANT` |
| failureOperation | `VERIFY_CACHE_COLLECTION` |
| lastCompletedPhase | `PROJECTION` |
| elapsedMsAtFailure | 4608 |
| candidateCountVerified | 99 |
| cache lookup / hit / miss | 0 / 0 / 0 |
| clusterSelectedCount | 0 |
| authoritative / processing writes | 0 / 0 |
| commitCalls | 0 |
| realDataModified | false |

Nessun retry è stato eseguito. Il memory file è byte-identico al backup esterno;
restano zero SuperMemory e zero processing, e il lock è stato rilasciato.

Verdetto continuation:

`HIPPOCAMPUS_CONTROLLED_LIVE_PILOT_BLOCKED`

Reason code: `CONNECTION_RESET` at
`CACHE_LOOKUP / QDRANT / VERIFY_CACHE_COLLECTION`.

## Continuation — LIVE preflight/runtime lifecycle

La divergenza dimostrata tra factory diagnostica e factory LIVE è stata rimossa.
La live-prefix read-only viene ora costruita dalla stessa
`createLivePilotComposition` e riusa gli stessi oggetti di lock, preflight e
bounded runtime; esce prima del processing boundary HACT-7 e non può eseguire
backup, prepare, upsert o commit. Nessuna modifica è stata apportata al parsing
Qdrant, ai timeout, al clustering o alla cache.

L'osservabilità lifecycle chiusa registra istanza provider, segnali, dispose,
sequenza della verifica runtime e low-level code. Test lifecycle mirati: 16/16
PASS, inclusi doppio `getCollectionInfo`, abort globale, cleanup timeout,
factory condivisa, reset preservato, zero retry/write e artifact fake.

L'unica live-prefix diagnostica reale ha superato la verifica collection come
terza richiesta Qdrant e ha dimostrato:

| Lifecycle | Valore |
| --- | ---: |
| providerInstanceReused | false |
| preflightSignalAbortedAfterReturn | false |
| runtimeSignalSameAsPreflightSignal | true |
| transportDisposed | false |
| runtime VERIFY requestSequence | 3 |
| lowLevelErrorCode | `CONNECTION_RESET` |

Il lifecycle preflight/runtime ipotizzato non è quindi la causa del reset
iniziale: la live-prefix ha proseguito attraverso 99 query exact, 99 certificati
e 5 cluster verificati. Si è poi fermata prima dell'artifact durante un lookup
embedding:

| Evidenza live-prefix | Valore |
| --- | ---: |
| preflight | PASS |
| failurePhase | `CACHE_LOOKUP` |
| failureProvider | `QDRANT` |
| failureOperation | `GET_VALID_EMBEDDING` |
| reasonCode | `CONNECTION_RESET` |
| lastCompletedPhase | `AUTHORITATIVE_READ` |
| elapsedMsAtFailure | 27949 |
| candidateCountVerified | 99 |
| cache lookup / hit / miss | 199 / 198 / 0 |
| neighborQuery / exactCertificate / cluster | 99 / 99 / 5 |
| authoritative / processing writes | 0 / 0 |
| commitCalls | 0 |
| realDataModified | false |

Il file autorevole è byte-identico e il lock è stato rilasciato. Poiché la
live-prefix non ha raggiunto un artifact finalizzabile, il gate ha impedito sia
la suite completa sia una nuova LIVE. Nessun retry è stato eseguito.

Verdetto continuation:

`HIPPOCAMPUS_CONTROLLED_LIVE_PILOT_BLOCKED`

Reason code: `CONNECTION_RESET` at
`CACHE_LOOKUP / QDRANT / GET_VALID_EMBEDDING`.

## Continuation — Qdrant deterministic connection lifecycle

Il provider Qdrant usa ora una sola policy deterministica per-request tramite
`Connection: close`. Non sono stati aggiunti dispatcher alternativi, retry,
fallback, rotazioni euristiche o timeout. AbortSignal, validazione body,
Content-Length/chunked e mapping errori restano invariati. Il costo atteso è una
nuova connessione TCP/TLS per richiesta, accettato in cambio dell'assenza di
dipendenza dal lifecycle di socket keep-alive condivise.

La diagnostica reale pre-fix ha completato 250/250 lookup sia con la policy
corrente sia con `Connection: close`, quindi il campione reale non ha riprodotto
il reset. Il gate esplicito per autorizzare il fix è stato comunque soddisfatto
dalla policy senza riuso. La regressione deterministica con server fake ha poi
dimostrato il reset sulla seconda richiesta di una socket keep-alive e 250/250
richieste riuscite con il provider per-request, una richiesta per socket, zero
retry e cleanup delle socket.

Verifiche ordinate:

- provider: 26/26 PASS;
- 250 `GET_VALID_EMBEDDING` reali post-fix: 250 hit, zero miss/upsert/write/commit;
- live-prefix reale: artifact finalizzabile, 203/203 hit, 99 certificati exact,
  5 cluster, zero write/upsert/commit;
- regressioni HACT-9: 52/52 PASS;
- suite completa serializzata, una sola volta: 811 test PASS, zero failure.

Prima della LIVE: backup esterno byte-verificato, lock e processi concorrenti
assenti, zero SuperMemory e zero processing persistiti. L'unica LIVE autorizzata
ha prodotto:

| Evidenza LIVE | Valore |
| --- | ---: |
| status | `PASSED` |
| preflight | `PASS` |
| cluster selezionati | 1 |
| source | 5 |
| SuperMemory create | 1 |
| authoritative reads / writes | 4 / 1 |
| processing-state writes | 5 |
| commit calls | 1 |
| backup target verificati | 2 |
| recovery verified | true |
| recall SuperMemory/raw | true / true |
| cache lookup / hit / miss | 203 / 203 / 0 |
| neighbor query / certificati / cluster | 99 / 99 / 5 |
| realDataModified | true |

Il journal post-commit è presente, il lock è stato rilasciato e non è stato
eseguito alcun retry, daemon, cleanup, delete, accesso chat/frontend o commit
Git.

Verdetto finale:

`HIPPOCAMPUS_CONTROLLED_LIVE_PILOT_PASSED`
