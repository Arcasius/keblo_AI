# HIPPOCAMPUS RECOVERY TEST MATRIX V1

## 1. Scopo

Questa matrice chiude `AUD-P2-002` componendo le implementazioni reali dei FIX
16–19. Verifica recovery, journal e daemon attraverso boundary persistenti in
directory temporanee; non abilita Ippocampo e non costituisce un test sui dati
DEV reali.

La suite eseguibile è
`test/hippocampus/hippocampus-recovery-composition.test.js`. L'elenco stabile
degli ID `A01`–`G45` è parte del test: ID mancanti, duplicati o sconosciuti
falliscono esplicitamente.

## 2. Componenti composti

La suite usa le implementazioni concrete di `JsonMemoryStorage`,
`FileLockManager` attraverso lo storage, `HippocampusJournal`,
`RecoveryManager`, `HippocampusDaemon`, `SourceClaimTransaction`,
`ConsolidationTransaction`, `ProcessingState`, persistenza cluster,
`CandidateSelector`, `ConsolidationPlan`, `ClusterEngineAdapter` e
`SynthesisEngine`.

Sono sintetici soltanto embedding provider, model provider, clock, failure
injection ed eventuali osservatori di test. Ogni scenario crea e rimuove il
proprio ambiente sotto `os.tmpdir()`; non usa rete, provider reali, daemon reale
o directory dati del repository.

## 3. Matrice test-ID

| ID | Scenario | Invarianti principali |
|---|---|---|
| A01 | Happy path singolo cluster | commit e terminale coerenti |
| A02 | Più cluster nello stesso run | lifecycle separati e run terminale |
| A03 | Dodici cluster | nessun limite implicito di cinque |
| A04 | Super-memory deterministica | un solo ID semantico |
| A05 | Raw preservati | testo, timestamp e campi sconosciuti integri |
| A06 | Report immutabile | output profondamente congelato |
| B07 | Cluster A fallisce, B riesce | continuazione esplicita e terminali distinti |
| B08 | Cluster A riesce, B fallisce | successo precedente non nascosto |
| B09 | Stop on failure | cluster successivi restano raw |
| B10 | Timeout provider | failure sanitizzata e terminale |
| B11 | JSON/schema/provenance invalidi | lifecycle completo senza output privato |
| B12 | Revision della source failed | un solo incremento post-claim |
| B13 | SYNTHESIS_FAILED → SOURCES_FAILED | ordine journal verificato |
| C14 | Crash dopo claim | run incompleto ricostruibile |
| C15 | Append persa prima della mutazione | nessun falso terminale |
| C16 | Source failed senza ACK | riconciliazione storage-first |
| C17 | Commit valido senza ACK | nessuna riscrittura del commit |
| C18 | Restart con nuove istanze | stato persistito ricostruito |
| C19 | Recovery storage-first | stato dati verificato prima dell'ACK |
| C20 | Recovery ripetuta | nessuna seconda revisione |
| D21 | A committato, B claimed | recovery soltanto di B |
| D22 | Eventi interleaved | sequence globale e lifecycle separati |
| D23 | Primo cluster incompleto | terminale successivo non lo nasconde |
| D24 | Claim/attempt/source contraddittori | blocco fail-closed |
| D25 | Cluster ambiguo accanto a terminali | nessun falso run terminale |
| D26 | Cluster già terminale | nessuna seconda super-memory |
| E27 | Writer memory concorrente | attende il lock recovery |
| E28 | Writer cluster concorrente | attende il lock recovery |
| E29 | Due recovery stesso utente | serializzazione sul lock logico |
| E30 | Recovery utenti differenti | indipendenza dei lock |
| E31 | Piano stale durante attesa | zero mutazioni recovery |
| E32 | Acquisizione recovery | esattamente una acquire/release |
| E33 | Ordine dei lock | ACK journal soltanto dopo user-lock release |
| E34 | Failure path lock | nessun lock residuo |
| F35 | Scan ricorsiva | report, eventi ed errori privi di payload |
| F36 | Scan JSONL grezza | nessuna sentinella privata |
| F37 | Identità utente | nessun `userId` in chiaro |
| F38 | Dati modello/memoria | niente prompt, raw output, embedding o testo |
| F39 | Journal legacy | privacy rilevata senza ristampare identità |
| G40 | Failure dopo prima azione | azioni successive non eseguite |
| G41 | Arresto del piano | stato parziale non dichiarato completo |
| G42 | Rollback riuscito | snapshot ripristinato e verificato |
| G43 | Rollback fallito | stato `unknown`/bloccato esplicito |
| G44 | ACK fallito dopo dati validi | `needs_reconciliation` |
| G45 | Retry dopo ACK loss | nessuna doppia revisione |

## 4. Invarianti globali

Negli scenari applicabili la suite verifica che le source raw non siano
cancellate o compresse, i campi sconosciuti e i timestamp storici restino
invariati, revision e attempt ID siano coerenti, non esistano false chiusure o
super-memory duplicate, i lock siano rilasciati e journal sequence/fingerprint
restino validi. Restart e recovery usano nuove istanze sopra gli stessi file
temporanei, quindi non dipendono da stato process-local.

La privacy viene controllata sia ricorsivamente sia sul JSONL grezzo. I nomi di
campi tecnici e i contatori sono ammessi; valori privati e campi payload quali
testo, content, prompt, messages, raw output, embedding, centroid e
sourceSnapshot non lo sono.

## 5. Failure injection

Le failure sono iniettate ai boundary pubblici o mediante dipendenze sintetiche:
provider timeout/errore/output invalido, append journal pre/post mutazione,
crash dopo claim, ACK mancante dopo commit, piano stale, seconda azione fallita,
rollback riuscito/fallito e writer concorrenti. Non sono presenti hook di
produzione aggiunti dal FIX 20 e non sono usati sleep come criterio di esito.

## 6. Esito FIX 20

Tutte le 45 righe sono registrate e coperte. La suite dedicata esegue 18 test
TAP (17 test di scenario/registry più un subtest timeout), tutti verdi. Le
regressioni mirate eseguono 147 test e la suite completa 342 test, senza fail,
skip o todo.

La matrice non ha scoperto difetti riproducibili nel codice di produzione. Un
primo controllo testuale troppo ampio interpretava un contatore tecnico di
embedding come payload privato; il controllo è stato ristretto alla struttura e
ai valori vietati. Non è stata applicata alcuna modifica di produzione.

## 7. Non-obiettivi

Il FIX 20 non modifica lo status persistente dopo restart (FIX 21), non esegue
benchmark a 40.000 memorie (FIX 22), non avvia provider o daemon e non autorizza
l'Activation Gate.
