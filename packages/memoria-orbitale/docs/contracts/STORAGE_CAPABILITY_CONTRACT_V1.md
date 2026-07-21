# STORAGE_CAPABILITY_CONTRACT_V1

## 1. Scopo

Questo contratto versionato definisce come descrivere e verificare in modo conservativo le capacità di uno storage di Memoria Orbitale. Evita che CandidateSelector, ClusterConsolidator, TransactionManager o altri componenti futuri deducano garanzie semantiche dalla sola presenza di metodi.

Il modulo di riferimento è `core/StorageCapabilityContract.js`. L'ispezione è read-only, deterministica e non accede ai dati persistiti.

## 2. Non-obiettivi

Il FIX 3 non introduce backend, migrazioni, atomic commit, lock, snapshot, rollback o cluster CRUD. Non modifica `JsonMemoryStorage`, non collega il contratto al runtime e non rende transazionale la persistenza JSON corrente.

## 3. Vocabolario

- **Structural:** tutti i metodi richiesti esistono come proprietà dati callable. Getter e proprietà non callable non soddisfano il requisito. La verifica non invoca i metodi.
- **Declared:** il backend espone una dichiarazione canonica esplicita per la capacità.
- **Behaviorally verified:** la dichiarazione indica che test comportamentali specifici hanno dimostrato la proprietà. Il validatore verifica la forma della dichiarazione, non può autenticare da solo la prova esterna.
- **Overall status:** valutazione conservativa prodotta combinando struttura, dichiarazione e indicazione di verifica.

La presenza strutturale non equivale né a dichiarazione né a verifica comportamentale.

## 4. Identificatori e metodi richiesti

Gli identificatori e i nomi metodo sono stabili nel V1. I metodi snapshot, commit, lock e rollback sono nomi contrattuali futuri: non sono dichiarati come presenti nel runtime corrente.

| Capacità | Metodo richiesto | Significato del supporto completo | Supporto parziale / limite strutturale |
|---|---|---|---|
| `memory.readAll` | `loadMemories` | Restituisce tutte le memorie dello scope con round-trip verificato | Metodo callable senza prova sul formato o completezza |
| `memory.readOne` | `getMemory` | Recupera per ID e distingue assenza | Metodo callable senza prova semantica |
| `memory.writeOne` | `saveMemory` | Salva una memoria recuperabile | Metodo callable senza round-trip |
| `memory.writeAll` | `saveMemories` | Sostituisce/salva il batch secondo semantica documentata | Non implica atomicità |
| `memory.deleteOne` | `deleteMemory` | Elimina per ID con esito verificabile | Metodo callable senza verifica post-delete |
| `link.readAll` | `loadLinks` | Restituisce tutti i link dello scope | Metodo callable senza prova di completezza |
| `link.writeAll` | `saveLinks` | Salva un batch recuperabile | Non implica atomicità |
| `link.writeOne` | `saveLink` | Salva un link recuperabile | Metodo callable senza round-trip |
| `link.deleteOne` | `deleteLink` | Elimina un link per ID | Nome contrattuale; assente nei backend reali ispezionati |
| `cluster.readAll` | `loadClusters` | Legge cluster realmente persistiti | Restituire sempre `[]` è uno stub, non persistenza verificata |
| `cluster.readOne` | `getCluster` | Recupera un cluster persistito per ID | Nome usato dai consumatori teorici, assente nei backend reali |
| `cluster.writeOne` | `saveCluster` | Salva un cluster recuperabile | Nome usato dai consumatori teorici, assente nei backend reali |
| `cluster.deleteOne` | `deleteCluster` | Elimina un cluster persistito | Nome usato dai consumatori teorici, assente nei backend reali |
| `snapshot.create` | `createSnapshot` | Crea snapshot identificabile e consistente | Nome futuro, assente nel runtime |
| `snapshot.verify` | `verifySnapshot` | Verifica integrità e utilizzabilità dello snapshot | Una copia file non costituisce verifica |
| `snapshot.restore` | `restoreSnapshot` | Ripristina con esito verificato | Nome futuro, assente nel runtime |
| `commit.atomic` | `saveMemory`, `saveMemories`, `deleteMemory`, `saveLink`, `saveLinks` | Tutti i write path reali sostituiscono atomicamente il proprio singolo file | Non implica transazione multi-file, lock o protezione lost update |
| `lock.acquire` | `acquireLock` | Acquisisce un lock con ownership e failure semantics definite | La sola firma non dimostra esclusione sicura |
| `lock.release` | `releaseLock` | Rilascia il lock posseduto in modo verificato | La sola firma non dimostra ownership |
| `rollback` | `rollback` | Ripristina lo stato precedente di un'operazione definita | Nome futuro per storage; il transaction manager separato non vale come storage capability |

## 5. Stati

- `supported`: struttura callable, dichiarazione `supported` e `verified: true` sono tutte presenti.
- `partial`: la dichiarazione è `partial`, oppure dichiara `supported` senza verifica comportamentale.
- `unsupported`: il metodo richiesto manca/non è callable, oppure il backend dichiara `unsupported`.
- `unknown`: la struttura esiste ma manca una dichiarazione valida o la capacità non è dichiarata.

`partial` e `unknown` non vengono promossi a `supported` da `hasStorageCapability()`.

## 6. Dichiarazione canonica del backend

La forma principale è una proprietà dati own `capabilities`; non viene chiamato un metodo `getCapabilities()` e un getter non viene eseguito.

```js
storage.capabilities = {
  schemaVersion: 1,
  statuses: {
    "memory.readAll": { status: "supported", verified: true },
    "cluster.readAll": { status: "partial", verified: false },
    "commit.atomic": { status: "unsupported", verified: false }
  }
};
```

Ogni entry richiede uno stato noto e un booleano `verified`. Una capacità omessa resta `unknown` se strutturalmente presente. I backend legacy senza dichiarazione sono tollerati, ma non ricevono supporto implicito. `JsonMemoryStorage` non viene modificato dal FIX 3 e resta quindi undeclared.

## 7. API e report

- `inspectStorageCapabilities(storage)` valida l'input, legge descriptor, distingue `missing`, `not-callable` e `callable`, e restituisce un plain object senza timestamp. Non invoca read, write, getter o servizi.
- `hasStorageCapability(storage, capability)` accetta soltanto identificatori V1 e verifica lo stato complessivo `supported`.
- `assertStorageCapabilities(storage, requiredCapabilities)` restituisce il report se tutti i requisiti sono `supported`; altrimenti lancia `StorageCapabilityError` con elenco ordinato e stati, senza dati di memoria.
- `getMissingStorageCapabilities()` restituisce lo stesso elenco senza lanciare.
- `validateCapabilityDeclaration()` verifica soltanto schema e vocabolario della dichiarazione.

Il report separa per ogni capacità `requiredMethods`, dettaglio strutturale dei metodi, `structural`, `declared`, `behaviorallyVerified` e `status`.

## 8. Matrice reale di JsonMemoryStorage

La matrice deriva dall'ispezione del codice e da test effettuati esclusivamente sotto `os.tmpdir()`. `Declared` è sempre `unknown` perché il backend legacy non espone `capabilities`. Lo stato è quello conservativo restituito dall'API; una prova comportamentale esterna non sostituisce la dichiarazione backend.

| Capacità | Structural | Declared | Verified dal FIX 3 | Stato | Evidenza e limitazioni |
|---|---:|---:|---:|---:|---|
| `memory.readAll` | supported | unknown | sì | unknown | `loadMemories`; array di plain object verificato |
| `memory.readOne` | supported | unknown | sì | unknown | `getMemory`; hit e `null` verificati |
| `memory.writeOne` | supported | unknown | sì | unknown | `saveMemory`; round-trip verificato |
| `memory.writeAll` | supported | unknown | sì | unknown | `saveMemories`; riscrive integralmente la object map |
| `memory.deleteOne` | supported | unknown | sì | unknown | `deleteMemory`; post-delete verificato |
| `link.readAll` | supported | unknown | sì | unknown | `loadLinks`; array verificato |
| `link.writeAll` | supported | unknown | sì | unknown | `saveLinks`; riscrittura completa del file |
| `link.writeOne` | supported | unknown | sì | unknown | `saveLink`; round-trip verificato |
| `link.deleteOne` | unsupported | unknown | no | unsupported | `deleteLink` assente |
| `cluster.readAll` | supported | unknown | no | unknown | `loadClusters()` restituisce sempre `[]`; nessuna persistenza |
| `cluster.readOne` | unsupported | unknown | no | unsupported | `getCluster` assente |
| `cluster.writeOne` | unsupported | unknown | no | unsupported | `saveCluster` assente |
| `cluster.deleteOne` | unsupported | unknown | no | unsupported | `deleteCluster` assente |
| `snapshot.create` | unsupported | unknown | no | unsupported | metodo assente |
| `snapshot.verify` | unsupported | unknown | no | unsupported | metodo assente |
| `snapshot.restore` | unsupported | unknown | no | unsupported | metodo assente |
| `commit.atomic` | unsupported | unknown | no | unsupported | `_writeJson` usa scrittura diretta; nessun commit atomico |
| `lock.acquire` | unsupported | unknown | no | unsupported | metodo assente |
| `lock.release` | unsupported | unknown | no | unsupported | metodo assente |
| `rollback` | unsupported | unknown | no | unsupported | metodo storage assente |

`JsonMemoryStorage` salva una JSON object map per utente e kind. I salvataggi batch e singoli terminano in `fs.writeFileSync` sul file finale; questo dimostra una riscrittura completa, non un commit atomico. Non sono stati simulati failure, lock o transazioni.

### Stato dopo FIX 4

La matrice precedente resta l'evidenza storica del FIX 3. Il FIX 4 ha integrato `AtomicJsonCommit` e aggiunto a ogni istanza una dichiarazione own `capabilities`; non va quindi reinterpretata retroattivamente come se fosse esistita nel FIX 3.

| Gruppo | Structural | Declared | Verified dal FIX 4 | Stato dopo FIX 4 | Limite |
|---|---:|---:|---:|---:|---|
| Memory read/write/delete | supported | supported | sì | supported | Nessun lock o controllo lost update |
| Link read/write | supported | supported | sì | supported | `link.deleteOne` resta unsupported |
| `cluster.readAll` | supported | partial | stub verificato | partial | Restituisce sempre `[]`; nessuna persistenza |
| Cluster CRUD restante | unsupported | unsupported | no | unsupported | Metodi assenti |
| `commit.atomic` | supported | supported | sì | supported | Atomic replace per singolo file e per i cinque write path reali |
| Snapshot | unsupported | unsupported | no | unsupported | Nessuna API snapshot |
| Lock | unsupported | unsupported | no | unsupported | Nessuna esclusione multi-processo |
| `rollback` | unsupported | unsupported | no | unsupported | Backup `.bak` non è rollback applicativo |

Nel FIX 3 il metodo strutturale futuro provvisorio era `commitAtomic`. Il FIX 4 ha dimostrato un'incompatibilità con il vincolo di API pubblica invariata: la garanzia è trasversale ai cinque metodi di scrittura già esistenti. La mappatura interna del capability contract è stata quindi circoscritta a tali metodi, senza aggiungere una nuova API pubblica.

## 9. `writeAll` non è `commit.atomic`

`memory.writeAll` e `link.writeAll` descrivono l'ampiezza logica del payload. `commit.atomic` descrive invece una proprietà di visibilità e failure: nessun osservatore deve vedere uno stato parziale e un errore non deve lasciare il file finale corrotto o a metà. La riscrittura completa del file finale non soddisfa automaticamente tale proprietà.

## 10. `loadClusters` non è cluster persistence

Entrambi gli storage reali espongono `loadClusters`, ma nessuno offre il CRUD cluster richiesto dai moduli teorici. In `JsonMemoryStorage`, `loadClusters()` restituisce sempre un array vuoto senza leggere o scrivere un file. La struttura è quindi rilevabile, ma il supporto semantico non è verificato.

## 11. Requisiti per componenti futuri

Ogni nuovo componente deve dichiarare le capacità minime richieste e chiamare `assertStorageCapabilities()` prima di operare. Un CandidateSelector read-only potrà richiedere `memory.readAll`; un ClusterConsolidator dovrà richiedere le capacità cluster effettivamente usate; un TransactionManager che promette atomicità dovrà richiedere `commit.atomic` e, secondo il disegno futuro, snapshot/rollback/lock.

L'asserzione non deve contenere dati persistiti e non autorizza scritture. I backend legacy devono essere adattati o dotati di dichiarazione soltanto in un fix esplicito accompagnato da test comportamentali.

## 12. Decisioni rinviate

- recovery dopo crash e policy del backup atomico introdotto dal FIX 4;
- ownership, timeout e stale-lock handling;
- formato, retention e verifica degli snapshot;
- semantica transazionale multi-file memoria/link;
- CRUD e persistenza cluster;
- adapter dichiarativo per `JsonMemoryStorage` e `MemoryStorage`;
- autorità e versionamento delle evidenze `verified`;
- integrazione del capability check nei componenti runtime.

## 13. Esempio sintetico

```js
const required = ["memory.readAll", "cluster.readAll"];
assertStorageCapabilities(syntheticStorage, required);
```

L'esempio esprime requisiti e non accede a dati reali. Con il backend corrente l'asserzione fallisce conservativamente finché una dichiarazione verificata non viene introdotta da un fix successivo.

## 14. Stato dopo FIX 8

Le matrici FIX 3 e FIX 4 sopra restano evidenza storica e non sono riscritte retroattivamente. Il FIX 8 introduce il record canonico descritto in `CLUSTER_PERSISTENCE_V1` e implementa il CRUD cluster reale in `JsonMemoryStorage`.

| Capacità | Structural | Declared | Verified dal FIX 8 | Stato dopo FIX 8 | Limite |
|---|---:|---:|---:|---:|---|
| `cluster.readAll` | supported | supported | sì | supported | Valida ogni record del file utente; corruzioni non nascoste |
| `cluster.readOne` | supported | supported | sì | supported | Recupero per ID con key object map verificata |
| `cluster.writeOne` | supported | supported | sì | supported | Replay sequenziale idempotente; nessun overwrite silenzioso |
| `cluster.deleteOne` | supported | supported | sì | supported | Elimina soltanto l'ID richiesto |
| `commit.atomic` | supported | supported | sì | supported | Ora copre anche i write cluster, sempre per singolo file |
| Snapshot | unsupported | unsupported | no | unsupported | `.bak` non è snapshot |
| Lock | unsupported | unsupported | no | unsupported | Lost update multi-processo ancora possibile |
| `rollback` | unsupported | unsupported | no | unsupported | Nessun rollback applicativo |

Il vocabolario e la mappatura dei quattro metodi cluster erano già presenti in `StorageCapabilityContract.js`; non è stato necessario modificarli. Il principio conservativo del FIX 3 resta invariato: soltanto metodi callable, dichiarazione `supported` e `verified: true` producono stato `supported`.

La frase conclusiva dell'esempio della sezione 13 descrive lo stato storico precedente. Dopo FIX 8 l'asserzione sintetica `memory.readAll` + `cluster.readAll` riesce su `JsonMemoryStorage`, mentre richieste di snapshot, lock o rollback continuano a fallire conservativamente.

## 15. Stato dopo FIX 10

Le matrici FIX 3, FIX 4 e FIX 8 restano evidenza storica e non vengono riscritte retroattivamente. Il FIX 10 introduce `FileLockManager` e integra una lock key condivisa per utente in tutti i writer memory, link e cluster di `JsonMemoryStorage`.

| Capacità | Structural | Declared | Verified dal FIX 10 | Stato dopo FIX 10 | Limite |
|---|---:|---:|---:|---:|---|
| `lock.acquire` | supported | supported | sì | supported | Lock file `wx`, owner/token e timeout; nessuna stale recovery automatica |
| `lock.release` | supported | supported | sì | supported | Verifica handle, owner/token e doppia release |
| `commit.atomic` | supported | supported | sì | supported | Resta sostituzione atomica del singolo file |
| `snapshot.create/verify/restore` | unsupported | unsupported | no | unsupported | Snapshot RAM transazionale non è API storage |
| `rollback` | unsupported | unsupported | no | unsupported | Il ripristino circoscritto FIX 10 non è rollback storage generale |

Il transaction runner richiede `memory.readAll`, `memory.writeAll`, `commit.atomic`, `lock.acquire` e `lock.release`. Il lock impedisce i lost update verificati tra writer cooperanti dello stesso utente. Un crash può lasciare un lock stale; recovery e journal persistente restano rinviati.
## Nota operativa post-FIX 14

`JsonMemoryStorage.inspectUserLock()` e `recoverStaleUserLock()` delegano il controllo operativo del lock utente. Non costituiscono nuove capability storage generali: snapshot e rollback restano unsupported e stale recovery richiede metadata, host/PID/età e autorizzazione esplicita.
