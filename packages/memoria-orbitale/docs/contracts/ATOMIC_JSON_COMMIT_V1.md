# ATOMIC_JSON_COMMIT_V1

## 1. Obiettivo

Questo contratto descrive la sostituzione atomica di un singolo file JSON introdotta dal FIX 4 e integrata in tutti i write path memoria/link di `JsonMemoryStorage`. Il formato pubblico resta una JSON object map indicizzata per ID, serializzata con indentazione di due spazi e senza newline aggiuntivo.

## 2. Algoritmo

Per ogni target, `atomicWriteJson(filePath, value, options)` esegue:

1. validazione degli argomenti e dei tipi serializzabili;
2. una sola chiamata `JSON.stringify(value, null, 2)` e parse di controllo;
3. creazione ricorsiva della directory parent;
4. apertura esclusiva di un temp univoco nella stessa directory;
5. scrittura completa, `fsync` e chiusura del temp;
6. rilettura e parse del temp;
7. eventuale validator semantico sul valore riletto;
8. se il target esiste, rilettura e validazione della versione precedente;
9. scrittura esclusiva, `fsync`, validazione e rename atomico di un backup-temp verso `<target>.bak`;
10. rename atomico del temp verso il target;
11. `fsync` della directory quando supportato;
12. rimozione dei residui temp e backup-temp dopo errori gestiti.

## 3. Naming

- Target: nome invariato, per esempio `<userId>_memories.json`.
- Backup stabile: `<target>.bak`.
- Temp di commit: `.<basename>.write.<pid>.<randomUUID>.tmp`.
- Temp di backup: `.<basename>.backup.<pid>.<randomUUID>.tmp`.

PID e UUID sono dettagli tecnici non prevedibili e non entrano nel contenuto persistito. Tutti i file intermedi risiedono nella stessa directory del target, condizione necessaria per il rename atomico sullo stesso filesystem.

## 4. Garanzie

- Il file finale osservabile dopo il rename è un documento JSON completo prodotto da un singolo writer.
- Prima del rename finale, errori di serializzazione, temp write, validazione o backup lasciano invariato il target precedente.
- Un target precedente valido viene conservato in `.bak` prima della sostituzione.
- Un target precedente corrotto non sostituisce un backup valido già esistente.
- Temp e backup-temp vengono rimossi dopo successo o errori gestiti, salvo un errore di cleanup esplicitamente segnalato.
- L'input non viene modificato e il risultato non contiene payload memoria/link.

## 5. Non-garanzie

Il protocollo non offre:

- lock o isolamento tra processi;
- protezione da lost update read-modify-write;
- ordine deterministico o scelta del writer vincente;
- transazione multi-file memoria + link;
- rollback applicativo;
- snapshot versionati o restore;
- crash recovery di Ippocampo.

Il backup `.bak` è soltanto l'ultima versione valida precedente osservata dal singolo commit. Non implementa le capability snapshot o rollback.

## 6. Serializzazione e validazione

Sono rifiutati `undefined` top-level, funzioni, simboli, `BigInt`, riferimenti circolari, risultati `JSON.stringify` uguali a `undefined` e payload non rileggibili. Gli errori non includono il payload.

`validateJsonFile(filePath)` è read-only e restituisce soltanto `{ valid, filePath, bytes }`; non restituisce il documento parsato. Il validator opzionale di `atomicWriteJson` viene eseguito sul valore riletto dal temp, prima di backup e rename. Un rifiuto lascia invariato il target.

## 7. Backup

Il backup viene creato solo quando il target esiste ed è JSON valido. I byte della versione precedente vengono scritti in un backup-temp esclusivo, sincronizzati, riletti e validati; soltanto dopo avviene il rename verso `.bak`. Un secondo commit sostituisce `.bak` con la versione valida immediatamente precedente osservata da quel commit.

Con writer concorrenti, in assenza di lock, il backup resta JSON valido ma non è garantito che rappresenti il predecessore globale dell'ultimo writer: ciascun writer può avere osservato la stessa versione iniziale. Questo è parte del rischio lost update ancora aperto.

## 8. Fsync e finestra dopo rename

Il temp viene sincronizzato prima della validazione. Dopo il rename finale viene aperta e sincronizzata la directory, comportamento verificato sull'ambiente Linux corrente. Solo gli errori noti che indicano fsync-directory non supportato (`EBADF`, `EINVAL`, `EISDIR`, `ENOTSUP`, `EPERM`) producono `directorySynced: false`; gli altri vengono segnalati.

Se il rename finale è riuscito e il successivo fsync della directory fallisce, `AtomicJsonCommitError.committed` è `true`: il target può essere già cambiato e l'errore non promette il contrario. Questa finestra non può essere trattata come un fallimento pre-commit.

## 9. Errori

`AtomicJsonCommitError` espone `code`, `phase`, `cause` quando disponibile e `committed`. I codici stabili sono:

- `ERR_ATOMIC_JSON_INVALID_ARGUMENT` / `argument`;
- `ERR_ATOMIC_JSON_SERIALIZATION` / `serialization`;
- `ERR_ATOMIC_JSON_TEMP_WRITE` / `temp-write`;
- `ERR_ATOMIC_JSON_VALIDATION` / `validation`;
- `ERR_ATOMIC_JSON_BACKUP` / `backup`;
- `ERR_ATOMIC_JSON_COMMIT` / `commit`;
- `ERR_ATOMIC_JSON_DIRECTORY_SYNC` / `directory-sync`;
- `ERR_ATOMIC_JSON_CLEANUP` / `cleanup`.

Eventuali failure di cleanup associate a un errore principale sono riportate come soli codici tecnici in `cleanupFailures`, senza dati applicativi.

## 10. Integrazione JsonMemoryStorage

`saveMemory`, `saveMemories`, `deleteMemory`, `saveLink` e `saveLinks` attendono `_writeJson()`, ora delegato ad `atomicWriteJson()`. Firme, valori restituiti, nomi finali, object map, `loadMemories()`, `loadLinks()` e metodi di ricerca restano invariati. I loader costruiscono direttamente il nome finale e non enumerano directory, quindi ignorano `.bak` e temp.

Ogni istanza espone una proprietà dati own `capabilities` conforme al FIX 3. Memory e link effettivamente testati sono `supported/verified`; `cluster.readAll` resta `partial`; cluster CRUD, snapshot, lock e rollback restano `unsupported`.

## 11. Confine di `commit.atomic`

Nel FIX 4 `commit.atomic` significa sostituzione atomica e validata di ciascun singolo file finale per tutti i write path reali di `JsonMemoryStorage`. La mappatura strutturale usa i cinque metodi pubblici reali, senza aggiungere un metodo `commitAtomic` e senza cambiare l'API dello storage.

La capability non significa transazione multi-file, serializzazione concorrente, compare-and-swap, lock o rollback. In particolare due writer possono leggere la stessa object map e sostituirla entrambi con documenti completi: il file non è parziale, ma l'aggiornamento del writer precedente può andare perso.

## 12. Test effettuati

I test sotto `os.tmpdir()` coprono creazione, sostituzione, formato, backup successivi, backup valido, serializzazione non valida, circolarità, `BigInt`, validator post-rilettura, failure prima del rename, cleanup, concorrenza, non mutazione, risultato non sensibile e tutti i write path memory/link. Il test concorrente prova soltanto completezza JSON e assenza di temp residui, non assenza di lost update.

## 13. Decisioni rinviate

- lock multi-processo e gestione stale lock;
- prevenzione lost update e controllo versione;
- transazione coordinata memoria/link/cluster;
- snapshot versionati, restore e rollback;
- recovery dopo crash nelle diverse fasi;
- retention o policy del backup `.bak`;
- cluster persistence;
- integrazione di Ippocampo.
