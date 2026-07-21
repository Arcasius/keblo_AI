# RECALL_ROUTER_INTEGRATION_V1

## 1. Scopo

Il FIX 12 integra il contratto read-only del FIX 11 nel runtime DEV. Chat, `KebloMemory.getContextForKeblo()` e `OrbitaleBridge` usano una pipeline RecallRouter; il recall legacy diretto resta retrocompatibile per i chiamanti non migrati.

## 2. Runtime precedente

Il percorso precedente chiamava direttamente `KebloMemory.recall()`. Il default `mutateOnRecall: true` poteva aggiornare activation/access e propagare activation durante retrieval. Echo, activation e link boost concorrevano allo score; filtri historical/orbital e slicing erano decisi dai chiamanti. Chat possedeva inoltre una selezione cosciente successiva.

## 3. Posizione del router

Per una istanza runtime vengono creati un adapter legacy e un RecallRouter. `setRecallRouter()` registra esplicitamente la dipendenza su KebloMemory e rifiuta la sostituzione con una diversa istanza. Non esiste import circolare né creazione automatica nel costruttore.

## 4. Classifier

`MemoryTierClassifier` normalizza senza mutare e produce tier, reason code, origine legacy e contratto sorgente. `memoryKind: super_memory` è core soltanto insieme a `storageTier: core`; una super-memory diversa è incompatibile.

## 5. Mapping legacy tier

- `storageTier: warm` → warm;
- `storageTier: deep` → deep;
- `memoryDepth: deep` o `historical`, in assenza di tier esplicito → deep;
- altre memorie untiered non-super, incluse `normal`, `temporary` e `core` → warm;
- `memoryDepth: core` non equivale a storage core;
- `orbitalLevel` short/medium/long non determina il tier.

I campi espliciti prevalgono. Non avviene persistenza o migrazione.

## 6. Adapter legacy

`createLegacyRecallAdapter({ kebloMemory, userId })` espone retriever core, warm e deep V1. `userId` è esplicito nelle integrazioni persistenti; può essere omesso da adapter sintetici il cui backend non usa identità. Ogni retriever richiede tier corrispondente e `mutate: false`, chiama soltanto `recallReadOnly()` e crea una copia adattata. Lo score `_score` viene trasferito senza boost aggiuntivi o valori inventati.

La vista adattata aggiunge `storageTier` solo alle memorie classificate tramite regole legacy e un `memoryKind` compatibile quando assente. Non restituisce `sourceSnapshot` e non modifica il backend object.

## 7. recallReadOnly

`KebloMemory.recallReadOnly(userId, query, options)` delega al recall esistente forzando sempre `mutateOnRecall: false`. Non aggiorna activation, orbital state, lastAccess o accessCount, non propaga activation e non salva.

Il metodo legacy `recall()` conserva firme e default precedenti: senza `mutateOnRecall` continua a mutare come prima; `mutateOnRecall: false` continua a essere rispettato.

## 8. Filtri prima e dopo link/Echo

Il nuovo filtro `tier` usa esclusivamente `MemoryTierClassifier`. Viene applicato alla collezione iniziale prima del warm concept index, Echo e base scoring, e nuovamente prima dell'output. Poiché le mappe score/link sono costruite solo dai candidati del tier, un vicino deep non contribuisce al link boost warm e un candidato Echo deep non entra nella route warm.

## 9. Request builder

`buildRecallRequest()` richiede query e limit espliciti. Produce mode, includeDeep e fallback chiusi. Non esiste default o massimo cinque. Il fallback resta disabilitato salvo `allowDeepFallback: true`; in quel caso la soglia esplicita è il limit richiesto dal chiamante.

## 10. Comandi deep

Sono riconosciuti soltanto come prefissi case-insensitive:

- `cerca nello storico completo`;
- `cerca in tutta la memoria`;
- `search full history`.

Il prefisso viene rimosso e deve lasciare una query utile. Parole isolate come ieri, passato, ricordo, storico, tempo o anni fa non attivano deep. `includeDeep: true` resta disponibile via API indipendentemente dal comando.

## 11. getContextForKeblo

Con router registrato, `getContextForKeblo()` costruisce una request, invoca il router una volta, applica opzionalmente reinforcement ai soli ID finali e converte soltanto `results` nel contesto. Suppressed e invalid non entrano nel prompt. `reinforce: false` mantiene il percorso integralmente read-only.

Senza router registrato resta il fallback legacy documentato, per compatibilità; non viene creato un router nascosto.

## 12. Chat e bridge

La chat crea adapter/router una volta accanto alla singola istanza KebloMemory e registra lo stesso router. Il budget `candidateLimit` resta una decisione esistente della chat, non una capacità massima della memoria. Il router sostituisce la chiamata diretta; la selezione cosciente opera sulle viste finali e solo gli ID promossi vengono rinforzati.

`OrbitaleBridge`, che chiamava direttamente recall, crea pigramente una sola pipeline legata al primo user ID dell'istanza. Un user differente viene rifiutato esplicitamente per evitare un router silenziosamente associato allo storage sbagliato. `getContext()` usa quel medesimo percorso.

Nessun prompt, routing Ollama/OpenAI o chiamata modello è stato modificato dal contratto d'integrazione.

## 13. Reinforcement singolo

`reinforceRecallSelection()` deduplica ID, carica la map una volta e applica la formula legacy diretta `activation + 0.03`, con ricalcolo orbitale, lastAccess e accessCount `+1`. Usa una sola `saveMemories` batch. Con JsonMemoryStorage l'intera lettura/modifica/scrittura avviene sotto `withUserLock`, riusando il lock handle.

Solo gli ID finali vengono considerati. Source soppresse, invalid e risultati oltre limit non sono passati al metodo. Le super-memory sono ignorate: non ricevono activation, lastAccess, accessCount o campi orbitali inventati. La propagazione link legacy non viene eseguita nella pipeline router perché muterebbe memorie non selezionate.

## 14. Super-memory

Le super-memory core partecipano al ranking senza boost arbitrario. Se coprono source raw, la soppressione avviene prima del reinforcement. Il loro schema consolidato non viene alterato dal percorso recall.

## 15. Limit

Router e adapter non introducono `5`. Chat conserva i budget contestuali già configurati (`candidateLimit`), `getContextForKeblo` conserva il proprio default contestuale di 3 e OrbitaleBridge conserva il default contestuale di 5. Sono scelte dei chiamanti e non top limit della memoria; un limit di almeno 12 restituisce almeno 12 risultati validi.

## 16. Retrocompatibilità

`recall(query)` e `recall(query, opzioniLegacy)` non cambiano semantica. Il nuovo filtro `tier` è opt-in e usato dall'adapter. Il fallback di `getContextForKeblo` conserva il vecchio percorso in assenza di dependency injection. Il bridge conserva forma testuale e vista memory-like esterna.

## 17. Test

I test usano MemoryStorage o adapter sintetici. Coprono classifier flat/nested/hybrid, comandi, route, isolamento tier link/Echo, read-only, registrazione, getContext, singolo reinforcement, batch/lock, retrocompatibilità legacy, dodici risultati e controllo statico della chat. Non avvengono rete, modelli o accessi ai dati reali.

## 18. Garanzie

- core+warm default e deep solo esplicito/fallback;
- retrieval legacy sempre read-only dietro adapter;
- filtro tier prima e dopo scoring;
- un solo reinforcement della selezione finale;
- nessun reinforcement di suppressed/invalid/truncated o super-memory;
- nessun doppio access increment;
- una pipeline per istanza/user runtime integrato;
- nessuna dipendenza da daemon o modello.

## 19. Rischi residui

Il ranking continua a usare lo score legacy prodotto dentro ciascun retriever, pur senza boost aggiunto dal router. La chat mantiene una promotion policy propria e log di eventi; l'osservabilità unificata e adapter multi-user richiedono lavoro futuro. Un retriever esterno diverso dall'adapter V1 deve dimostrare autonomamente il rispetto di `mutate: false`.

## 20. Rollback manuale

Il rollback dell'integrazione consiste nel rimuovere bootstrap adapter/router da chat/bridge e la registrazione DI, riportando i chiamanti al percorso legacy. I nuovi metodi e classifier sono additive e non richiedono migrazioni o rollback dati. Nessun rollback automatico o daemon è introdotto.
