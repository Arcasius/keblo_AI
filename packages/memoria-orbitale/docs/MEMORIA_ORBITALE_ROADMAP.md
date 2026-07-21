# Memoria Orbitale Roadmap

## Stato attuale

La Memoria Orbitale non e piu solo archivio.

memoria != contesto

memoria = potenziale di contesto

Il sistema deve quindi trattare la memoria come una struttura latente che puo
diventare contesto solo quando gate, risonanza e stato orbitale lo rendono
opportuno.

## Componenti presenti

- Base Identity Context
- LatentMemoryGate
- ConsciousContextGate
- EchoResonanceScore
- MemoryEventLogger

## Step architetturali

1. fix-015 EchoStateBuilder
   - Aggrega gli eventi Echo JSONL per memoryId.
   - Produce stato Echo senza stampare contenuto privato.

2. fix-016 Inspect Echo State
   - Aggiunge uno script di debug per vedere nodi vibranti.
   - Mostra solo metadata: echoEnergy, promotedCount, latentPresence e concepts.

3. fix-017 Graph Echo Overlay
   - Porta EchoState nel grafo orbitale come overlay visuale.
   - Distingue nodi dormienti, caldi, promossi, decaduti e inibiti.

4. fix-018 Topic Suppression Gate
   - Riconosce richieste esplicite di cambio tema.
   - Scrive eventi suppressed append-only senza cancellare memorie.

5. fix-019 Concept Warm Memory Index
   - Costruisce un indice leggero concept -> candidate memories in RAM.
   - Riduce lo scoring globale selezionando prima per area e poi per EchoScore.

6. fix-020 Semantic Link Upgrade
   - Distingue link temporali da link semantici reali.
   - Mantiene compatibilita con i link legacy e con dialogue_sequence.

7. fix-021 Echo Reinforcement Policy
   - Traduce Echo, promotion, co-echo, decadimento e suppression in un piano di update.
   - Mantiene una policy inizialmente conservativa e non distruttiva.

8. fix-022 Cold Warm Hot Lifecycle
   - Introduce lifecycle COLD, WARM, HOT, CONSCIOUS, SUPPRESSED, DECAYED.
   - Integra lifecycle con EchoState e ConsciousContextGate.

## Ordine consigliato

L'ordine consigliato e quello della coda:

1. EchoStateBuilder
2. Inspect Echo State
3. Graph Echo Overlay
4. Topic Suppression Gate
5. Concept Warm Memory Index
6. Semantic Link Upgrade
7. Echo Reinforcement Policy
8. Cold Warm Hot Lifecycle

Questa sequenza parte dalla lettura non distruttiva degli eventi, aggiunge
ispezione e visualizzazione, poi introduce gate, indice, link semantici, policy
di rinforzo e lifecycle.

## Regola operativa

Un solo fix puo essere running per volta.

Ogni fix deve restare piccolo, verificabile e append-only quando lavora su eventi
o dati memoria. Nessun fix deve marcare automaticamente lo stato completed.

## Stato backend Ippocampo post-HACT-1

Stato canonico:

- `SYNTHETIC_END_TO_END_VERIFIED`;
- `REAL_RUNTIME_DISABLED`;
- `DEFAULT_ACTIVATION_MODE_OFF`.

HACT-1 aggiunge il contratto puro di activation `OFF | SHADOW | LIVE`.
L'assenza di configurazione produce sempre OFF a ogni nuova istanza. SHADOW
non riceve autorizzazione commit. LIVE richiede token esatto, capability commit
esplicita e attestazione storage compatibile, ma HACT-1 non collega ancora il
wiring operativo e non esegue cicli.

Passi futuri, ciascuno come fix separato:

1. composition root backend che costruisca una nuova decisione gate per ciclo;
2. preflight reale read-only conforme al contratto HACT-1;
3. shadow runner esplicito senza capability commit;
4. autorizzazione distinta del wiring LIVE e delle policy di commit.

Nessuno di questi passi è attivato automaticamente da HACT-1.

## Stato backend Ippocampo post-HACT-2

Stato canonico:

- `ACTIVATION_GATE_READY`;
- `CONTROL_PLANE_READY`;
- `DEFAULT_MODE_OFF`;
- `REAL_RUNNER_NOT_WIRED`;
- `REAL_RUNTIME_DISABLED`.

HACT-2 aggiunge un controller volatile e un dispatcher HTTP framework-neutral
per status, selezione modalità, run singolo e stop cooperativo. Controller e
dispatcher sono verificati soltanto con dipendenze fake e non ricevono un
runner reale.

Il dispatcher non è montato: l'unico entrypoint HTTP rinvenuto appartiene
all'app frontend, si auto-avvia e non espone un confine di autorizzazione
riutilizzabile. Il prossimo fix deve individuare o introdurre, con
autorizzazione esplicita, un composition root backend autenticato; non deve
montare silenziosamente il control plane nel server frontend.

## Stato backend Ippocampo post-HACT-2B

Stato canonico:

- `ACTIVATION_GATE_READY`;
- `CONTROL_PLANE_READY`;
- `HTTP_MOUNT_BLOCKED_BACKEND_AUTHORIZATION_BOUNDARY_REQUIRED`;
- `DEFAULT_MODE_OFF`;
- `REAL_RUNNER_NOT_WIRED`;
- `REAL_RUNTIME_DISABLED`.

Il preflight di integrazione Keblo non ha individuato un singolo backend
operativo con autenticazione e autorizzazione server-side riusabili. I backend
candidati sono non avviati, incoerenti con il frontend corrente oppure usano
soltanto configurazioni di autenticazione di sviluppo non adatte a un control
plane sensibile.

Il repository autonomo non espone inoltre HACT-2 tramite package, export o
workspace stabile. HACT-2B non ha montato endpoint e non ha creato import
relativi o assoluti fra repository.

Ordine dei prossimi fix:

1. designare un composition root Keblo canonico e verificare il suo confine di
   autorizzazione server-side;
2. esporre un entrypoint HACT versionato e stabile dal repository autorevole;
3. riprendere il mount HACT-2 con runner ancora assente e default OFF.

## Stato backend Ippocampo post-HACT-3

Stato canonico:

- `ACTIVATION_GATE_READY`;
- `CONTROL_PLANE_READY`;
- `HTTP_MOUNT_DEFERRED_TO_KEBLO_SERVER`;
- `STANDALONE_CLI_READY`;
- `DEFAULT_MODE_OFF`;
- `LIVE_RUNTIME_DISABLED`;
- `REAL_SHADOW_RUN_NOT_EXECUTED`.

HACT-3 corregge la sequenza architetturale: prima del futuro backend Keblo è
disponibile un composition root core riutilizzabile e una CLI manuale locale.
La CLI parte sempre OFF, supporta preflight SHADOW e un singolo ciclo bounded
esplicito, ma LIVE e commit restano disabilitati.

Il futuro backend dovrà importare l'entrypoint
`core/hippocampus/index.js`, iniettare le proprie dipendenze e riusare lo stesso
composition root. HACT-2B resta rinviato e non richiede modifiche al frontend
in questa fase.

## Stato backend Ippocampo post-HACT-3B

Stato canonico:

- `HACT3_CLI_CONTRACT_VERIFIED`;
- `HACT3_REAL_COMPOSITION_PREVIOUSLY_NOT_WIRED=false`;
- `HACT3_REAL_COMPOSITION_FIXED`;
- `HIPPOCAMPUS_REAL_SHADOW_PREFLIGHT_BLOCKED_CONFIGURATION`;
- `REAL_SHADOW_RUN_NOT_EXECUTED`;
- `LIVE_RUNTIME_DISABLED`.

Il standalone composition root dispone ora di preflight reale read-only e
diagnostica sanitizzata per ogni componente. Il runner SHADOW reale resta
componibile ma non è stato avviato. La preflight non legge contenuti dei
ricordi e non possiede capability commit.

Prima di una nuova preflight devono essere configurati esplicitamente
`HIPPOCAMPUS_MEMORY_DATA_DIR`, `HIPPOCAMPUS_QWEN_TIMEOUT_MS`, `PRIMARY_MODEL` e
`PRIMARY_OLLAMA_URL`. Il prossimo passo non può usare fallback né modificare
automaticamente `.env`; soltanto dopo configurazione esplicita è ammessa una
nuova preflight read-only come fix separato.

## Stato backend Ippocampo post-HACT-4

Stato canonico:

- `LEGACY_FLAT_SHADOW_PROJECTION_READY`;
- `HIPPOCAMPUS_REAL_SHADOW_RUN_PASSED`;
- `REAL_SHADOW_CANDIDATES_SELECTED=20`;
- `AUTHORITATIVE_MEMORY_WRITES=0`;
- `COMMIT_CALLS=0`;
- `LIVE_RUNTIME_DISABLED`.

Il runtime standalone SHADOW dispone della projection versionata read-only
dal contratto flat storico al descriptor tecnico del planner. CandidateSelector
globale e memoria autorevole restano invariati. L'unico ciclo reale
autorizzato ha selezionato 20 candidati, creato 20 entry nella sola cache
embedding dedicata e non ha prodotto cluster, SuperMemory persistite o commit.

HACT-4 non autorizza promozione LIVE, processing-state write o migrazione dei
record storici. Qualunque evoluzione richiede un fix separato e autorizzazione
esplicita.

## Stato backend Ippocampo post-HACT-5

Stato canonico:

- `HIPPOCAMPUS_SHADOW_RERUN_IDEMPOTENT`;
- `REAL_SHADOW_CACHE_HITS=20`;
- `EMBEDDING_CACHE_MODIFIED=false`;
- `AUTHORITATIVE_MEMORY_WRITES=0`;
- `PROCESSING_STATE_WRITES=0`;
- `COMMIT_CALLS=0`;
- `LIVE_RUNTIME_DISABLED`.

HACT-5 rende i failure report SHADOW diagnostici e sanitizzati, con reason code
e fase chiusi e metriche parziali già verificate preservate. La cache esistente
è risultata compatibile in sola lettura e il solo rerun reale autorizzato ha
riusato tutti i 20 embedding senza BGE o upsert.

Ippocampo non è ancora collegato a `chat_orbitale_ollama`; la CLI standalone è
attualmente uno strumento operativo manuale. Daemon e commit LIVE restano fix
futuri separati e richiedono autorizzazione esplicita.

## Stato backend Ippocampo post-HACT-6

Stato canonico:

- `REAL_SHADOW_VERIFIED_READY_FOR_COMMIT_BRIDGE_DESIGN`;
- `MAX_CANDIDATES_100_PROJECTED=100`;
- `PLANNED_CANDIDATES=99`;
- `DUPLICATE_CONTENT_EXCLUDED=1`;
- `REAL_SHADOW_CLUSTERS=5`;
- `REAL_SHADOW_SUPERMEMORY_RAM=5`;
- `AUTHORITATIVE_MEMORY_WRITES=0`;
- `PROCESSING_STATE_WRITES=0`;
- `COMMIT_CALLS=0`;
- `LIVE_RUNTIME_DISABLED`.

HACT-6 ha spiegato il 99/100 come deduplica intenzionale per contenuto dopo il
limite della projection. Non risultano perdita silenziosa, errore di conteggio
o off-by-one. I vincoli dei cinque cluster sono enforced dal percorso riuscito,
ma la prova per-cluster non è persistita (`EVIDENCE_NOT_PERSISTED`).

La chat è già consumer di `RecallRouter`, ma non è collegata al bounded runtime,
al daemon o al commit bridge. Le SuperMemory SHADOW restano esclusivamente in
RAM. Nessuna integrazione è stata implementata da HACT-6.

I soli tre fix successivi sono:

1. **HACT-7 — commit bridge:** artifact bounded frozen, processing legacy
   esplicito, source claim, journal/recovery e transaction atomica;
2. **HACT-8 — daemon/chat integration:** bounded path nel daemon con guard
   esistenti e SuperMemory persistita consumabile dal RecallRouter, senza commit
   dal turno chat o auto-start;
3. **HACT-9 — controlled LIVE pilot:** singolo pilot approvato, bounded,
   journalizzato e verificato end-to-end.

HACT-7 deve chiudere i finding P1 prima di autorizzare HACT-9. LIVE resta
disabilitato.

## Stato backend Ippocampo post-HACT-7

Stato verificato:

- `HIPPOCAMPUS_BOUNDED_COMMIT_BRIDGE_READY_NO_REAL_COMMIT`;
- bounded commit bridge V1 implementato e isolato;
- prepare SHADOW read-only disponibile;
- commit subordinato a gate LIVE, capability server-side e conferma esatta;
- transazione, processing taxonomy e boundary journal/recovery storici riusati;
- dati reali, processing reale e commit reali invariati;
- daemon, chat, RecallRouter e CLI LIVE non collegati;
- `LIVE_RUNTIME_DISABLED`.

HACT-8 e HACT-9 restano separati e non sono autorizzati da questa modifica.

## Stato backend Ippocampo post-HACT-8

Stato verificato:

- `HIPPOCAMPUS_DAEMON_CHAT_INTEGRATION_READY_DEFAULT_OFF`;
- command background OFF/SHADOW isolato;
- default OFF senza runtime/provider/storage initialization;
- run-once e intervallo esplicito con guard anti-overlap;
- stop cooperativo SIGINT/SIGTERM;
- LIVE rifiutato e HACT-7 non invocabile in SHADOW;
- chat ancora indipendente e read-only via RecallRouter;
- storage condiviso documentato, nessun dato reale modificato;
- `LIVE_RUNTIME_DISABLED`.

HACT-9 controlled LIVE pilot resta non autorizzato.
## HACT-9 — Controlled LIVE pilot (2026-07-18)

Stato verificato: BLOCKED fail-closed. Gate e percorso fake sono implementati e
testati; l'unica preflight reale si è fermata con
`CONFIGURATION_INCOMPLETE`. Nessun dato autorevole è stato letto o modificato,
nessun backup era necessario e nessun commit è stato invocato.

Verdetto: `HIPPOCAMPUS_CONTROLLED_LIVE_PILOT_BLOCKED`.
