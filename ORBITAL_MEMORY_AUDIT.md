# ORBITAL_MEMORY_AUDIT

Audit read-only eseguito nella root `keblo_dev` il 2026-07-06.

Vincoli rispettati:
- nessun codice di produzione modificato;
- nessun file spostato o cancellato;
- unico file creato: `ORBITAL_MEMORY_AUDIT.md`;
- comandi eseguiti in lettura e `node --check` sintattico.

Nota worktree: erano gia presenti modifiche non mie in `server.js`, `public/index.html`, `project_nexus/nexus_deep_auditor.js`, piu la cartella non tracciata `Memoria_Orbitale_Autonomo/`. Non sono state toccate.

## 1. Executive Summary

Keblo oggi ha tre livelli di "memoria":

1. **Conversation history**: `conversation_repo.js` salva turni in JSONL per utente sotto `storage/users/<userId>/conversation.jsonl`. E' la memoria realmente usata nel prompt LLM tramite ultimi scambi "green".
2. **Short memory / intent state**: `intent_memory_router.js` mantiene in sessione una memoria breve conversazionale (`shortMemory`) usata per intent, dominio, topic, risposta e prompt directives.
3. **Memoria orbitale shadow**: `src/memory/orbitale/*` carica un motore CommonJS copiato sotto `src/memory/orbitale/engine/core`, ma oggi non entra nel prompt della chat principale. Viene salvata solo in modo shadow quando l'utente marca un turno con confidence/traffic green tramite `/api/set-confidence`, se `ORBITALE_MEMORY_ENABLED=true`.

`Memoria_Orbitale_Autonomo` e' piu avanzata: contiene modello dati orbitale, link, activation, dual activation, decay, cold compression, echo events JSONL, latent gate, conscious gate, import OpenAI e cockpit. Pero' non e' pronta per essere innestata brutalmente dentro Keblo: e' CommonJS, mescola core/runtime data/tooling/UI, ha storage JSON full-file non transazionale per dataset grandi, dipende da embedding service non forniti per cluster/gravita', e alcuni moduli fisici hanno bug runtime.

Decisione architetturale consigliata: **non copiare direttamente la cartella autonoma dentro la chat**. Estrarre/normalizzare il core utile dietro un solo servizio:

`memory/orbital/OrbitalMemoryService.js`

La chat deve parlare solo con `OrbitalMemoryService.recall()` e `OrbitalMemoryService.ingestTurn()`. Qdrant/embedding devono essere opzionali. L'import OpenAI deve restare offline/staging. La memoria richiamata deve passare da un gate prima di entrare nel prompt. Se la memoria avanzata fallisce, Keblo deve degradare alla storia JSONL attuale.

## 2. Mappa Keblo Attuale

### Entrypoint e backend

| Componente | Cosa fa | Chiamato da | Legge/scrive | Stabilita | Adatto a ricevere memoria orbitale |
|---|---|---|---|---|---|
| `package.json` | Progetto ESM (`"type":"module"`), script `start: node server.js`, dipendenze Express, session, multer, node-cron, pg, sharp, stripe, node-fetch. | npm/node | `package-lock.json`, `node_modules` | Stabile ma minimale: niente script test/lint. | Si, ma servono dipendenze esplicite se si introduce Qdrant/embedding. |
| `server.js` | Monolite Express: auth/session, static UI, chat SSE, upload immagini, PubMed, world brief, reminders, Project Nexus, cockpit orbitale read-only, fix timeline. | `node server.js` | `users.json`, `storage/users`, `storage/system`, `orbitale_memory_data`, API esterne/locali | Funziona ma fragile per dimensione e molte responsabilita. | Si solo tramite adapter esterno; non va riempito con logica core memoria. |
| `public/index.html` | UI pubblica principale. | Express static | asset frontend, API server | Non analizzato in dettaglio per non espandere scope; file gia modificato dall'utente. | Deve ricevere solo API diagnostiche, non logica memoria. |
| `keblo_engine.js` | Pipeline interna: token budget, card logic, preprocess immagini, decide LLM text vs vision, chiama `llm_router`. | `/api/chat` in `server.js` | stato sessione, immagini in `storage/users/<id>/chat_images` | Abbastanza stabile, ma non fa recall memoria avanzata. | Buon punto di ingresso per passare `intentAnalysis` arricchito da recall. |
| `llm_router.js` | Costruzione prompt, sanitize risposta, streaming Ollama, vision chat. Inserisce `intentAnalysis.promptDirectives` e storia. | `keblo_engine.js` | Ollama locale `localhost:11434`; no storage | Stabile ma accoppiato a prompt e debug log. | Deve ricevere un blocco memoria gia filtrato, non chiamare core orbitale. |

### Chat pipeline corrente

Flusso attuale in `server.js:/api/chat`:

1. autentica sessione;
2. salva il turno utente con `appendTurn`;
3. calcola emozione con `emotions/emotion_pipeline.js` via LLM locale `localhost:11436`;
4. legge storia green con `readLastGreenExchanges(userId, 8)`;
5. calcola `intentAnalysis` con `analyzeConversationTurn`;
6. legge world brief se rilevante;
7. opzionalmente cerca PubMed;
8. costruisce `finalInputText`;
9. chiama `processInput({ text: finalInputText, images }, state, history, mood, onChunk, intentAnalysis)`;
10. `keblo_engine.js` chiama `gptReplyStream` o `gptVisionReplyStream`;
11. `llm_router.js` costruisce prompt con:
    - stile fisso;
    - ora attuale;
    - mood;
    - `INTENT ROUTER E MEMORY STATE`;
    - cronologia green;
    - domanda attuale;
12. salva risposta assistant come `traffic: "yellow"`, `confidence: 0.5`.

Punto critico: **la memoria orbitale non partecipa a questo prompt**. La storia conversazionale green e' il contesto lungo effettivo.

### Conversazioni e memoria standard

| Componente | Cosa fa | Chiamato da | Dati | Fragilita | Decisione |
|---|---|---|---|---|---|
| `conversation_repo.js` | JSONL append-only per turni; lettura ultimi turni, green exchanges, search testuale, semantic search via rerank news. | `server.js`, route history, chat | `storage/users/<userId>/conversation.jsonl` | `readLastTurns/readAllTurns` leggono tutto il file o lo split completo; scala male su storia enorme. | Da mantenere come audit log conversazionale e fallback. |
| `memory_store.js` | Salva card in array JSON sotto `storage/memory/<userId>.json`. | `keblo_engine.js` importa `saveCard`, card logic | `storage/memory/*.json` | Non crea `storage/memory`; scrittura full-file; poco usato. | Non duplicare: e' memoria card/legacy, non core ricordi. |
| `intent_memory_router.js` | Router intent + shortMemory. File contiene duplicati/backup: due blocchi con stessi export (`DEFAULT_SHORT_MEMORY`, `analyzeConversationTurn`, ecc.). | `server.js` | stato sessione `req.session.user.state.shortMemory` | Fragile: duplicazione massiva, rischio confusione manutentiva; sintatticamente ok. | Mantenere come router/gate alto livello; non sostituire con memoria orbitale. |
| `domain_aware_intent_router.js` | Classifica dominio: social work, technical/Keblo, health, news. | `intent_memory_router.js` | solo testo/storia green | Stabile/euristico. | Utile prima del recall orbitale. |

### Memoria orbitale gia in Keblo

| Componente | Cosa fa | Chiamato da | Dati | Fragilita | Decisione |
|---|---|---|---|---|---|
| `src/memory/orbitale/index.js` | Export adapter, formatter, temporal builder. | `server.js` | n/a | Stabile. | Tenere come precedente prototipo, ma rimpiazzare con servizio piu pulito. |
| `src/memory/orbitale/OrbitaleMemoryAdapter.js` | Bridge ESM -> CommonJS con `vm`; carica `engine/core/Keblomemory.js` e `JsonMemoryStorage.js`. Offre `recall`, `buildContext`, `saveUser`, `saveAssistant`. | `server.js` shadow path | `orbitale_memory_data/<userId>_memories.json`, `<userId>_links.json` | Fragile: loader `vm`, cache custom, full-file JSON, link euristici, nessun isolamento transazionale. | Non usarlo come cuore finale; utile come compat layer temporaneo. |
| `server.js` `saveOrbitaleShadowTurn` | Salva in memoria orbitale solo turni green, su conferma confidence. | `/api/set-confidence` | `conversation.jsonl`, `orbitale_memory_data` | Shadow sicuro, non invasivo. | Da mantenere come fallback durante migrazione. |
| `/api/orbitale/status`, `/api/orbitale/graph` | API read-only per cockpit orbitale. | UI | `orbitale_memory_data` | Buone diagnostiche, ma normalizzano solo JSON esistenti. | Estendere dopo adapter, non prima. |

### Moduli laterali

| Modulo | Cosa fa | Storage/API | Stabilita | Nota integrazione |
|---|---|---|---|---|
| `scheduler.js` | Ogni 60s controlla reminders, fired/follow-up/ricorrenze. | `storage/users/<id>/reminders.json` | Semplice; legge directory utenti. | Da lasciare separato; la memoria orbitale puo solo ricevere segnali post-turno. |
| `world_brief_scheduler.js` | `node-cron` alle 07:05 per `buildWorldBrief()`. | `world_brief.js` / storage world brief | Stabile. | Non duplicare. |
| `time_parser.js` | Parser date italiane per reminders. | n/a | Limitato ma chiaro. | Utile come fonte temporale per ingestion. |
| `news_pipeline.js` | Serper news/search, reranker HTTP, summary Ollama. | Serper, reranker, Ollama `11435` | Dipende da servizi esterni/env. | Non e' memoria; puo produrre eventi/fatti con fonte. |
| `pubmed_search.js` | Query Postgres `keblo_med` con credenziali hardcoded. | Postgres localhost | Funzionale ma high risk per config hardcoded. | Medical module separato; memoria deve registrare fonte/confidenza. |
| `project_nexus/*` | Scanner, analyzer, audit, deep audit AI, storage, prompt Codex. | `storage/users/<id>/nexus` | Importante ma separato. | Non duplicare; eventualmente indicizzare snapshot/audit come source `project_nexus`. |
| `emotions/*` | Pipeline mood/EMA. | storage emozioni | Non auditata in profondita. | Segnale utile per memoria, non memoria primaria. |

### Test

Keblo ha `test_news.js`, `project_nexus/test_nexus_scan.js`, `emotions/test.js`, ma `package.json` non espone script test. `node --check server.js` passa. Non esiste test end-to-end chat/memoria.

## 3. Mappa Memoria_Orbitale_Autonomo

### Architettura generale

`Memoria_Orbitale_Autonomo` contiene:

- `core/`: motore memoria CommonJS.
- `chat_orbitale_ollama.js`: CLI con gate latente/consapevole e modello Ollama/OpenAI opzionale.
- `scripts/import_openai_export.js`: import export OpenAI in memorie storiche.
- `orbitale_chat_data/`, `imports/`, `backups/`: dati runtime/import/backup.
- `apps/orbitale-cockpilot/`: cockpit React/Vite con dataset enorme e build/dipendenze incluse.
- `automation/`: planner/fix runner/logs.
- `docs/`: roadmap, audit interno, checkpoint.

Stato: **prototipo avanzato, non prodotto integrabile direttamente**.

### Core modules

| Modulo | Responsabilita | Input | Output | Dipendenze | Maturita | Problemi | Integrabilita |
|---|---|---|---|---|---|---|---|
| `core/Keblomemory.js` | Orchestratore: `remember`, `recall`, `reinforce`, `decayAll`, `compress`, `getContextForKeblo`, stats. | userId, content/query/options | memorie, risultati con `_score`, aggiornamenti storage | Activation, LinkManager, Compressor, MemoryIndex, RetrievalBiasCorrector, IncrementalMaintenance, DualActivation | Medio: e' il cuore piu utile | 956 righe, molte euristiche hardcoded (Marco, ASO, Keblo), storage full scan, muta su recall se non disattivato. | Si, ma dietro adapter e con `mutateOnRecall:false` nel primo rollout. |
| `core/MemoryNode.js` | Modello ricordo con `content`, `orbital`, `cluster`, `embedding_ref`, access/decay. | data, userId | object JSON | crypto | Medio/basso | Il core attuale spesso usa plain object, non istanze MemoryNode. | Adattare schema, non imporre classe runtime. |
| `core/Link.js` | Modello link cognitivo, weight, decay, reinforce. | link data, userId | JSON link | crypto | Medio | Non sempre usato: molti link sono plain object. | Usare schema normalizzato e funzioni pure. |
| `core/LinkManager.js` | Cap dinamico link, decay peso, prune, propagazione. | link, activation, storage | link aggiornati | storage | Medio | Assume `reinforcementCount`; non valida source/target. | Integrabile in daemon manutenzione. |
| `core/MemoryIndex.js` | Indici RAM by id/orbit/cluster/type/user/text/time. | memory list | mappe/query | n/a | Medio | `Keblomemory.recall` non lo sfrutta davvero per evitare full scan; orbit field misto `orbital.level` vs `orbitalLevel`. | Utile come cache read-only dopo normalizzazione. |
| `core/ActivationEngine.js` | Formula activation, orbital state, energia globale. | activation/reinforcement/time | score/livello | n/a | Buono | Parametri duplicati/override in `Keblomemory`. | Integrabile. |
| `core/DualActivation.js` | Canale cognitivo/affettivo. | dualState, reinforcement, stimulus | dualState aggiornato | ActivationEngine | Buono | Affective non decade temporalmente: scelta da validare. | Integrabile. |
| `core/RetrievalBiasCorrector.js` | Scoring retrieval e bias correction. | query/candidates/embeddingService | ranked/corrected | embedding opzionale | Medio | Parte embedding richiede servizio non presente. | Usare solo scoring non-vector all'inizio. |
| `core/ColdMemoryCompressor.js` | Identifica/comprime memoria fredda, prune link freddi, entropy monitor. | memories/storage | memorie compresse | storage | Medio | Compressione distruttiva di metadata; va resa reversibile/append-only. | Staging prima, poi daemon con backup/rollback. |
| `core/IncrementalMaintenance.js` | Manutenzione incrementale batch. | storage/user | report | storage | Medio | Non letto in profondita; non scheduler autonomo completo. | Integrabile dopo test. |
| `core/MemorySignalExtractor.js` | Estrae domini, entita, tempo, tono, importanza, depth, trivialita. | testo | signals/tags | n/a | Buono | Euristico italiano; duplicabile con intent router Keblo se non coordinato. | Integrare come ingestion signal, non sostituire intent router. |
| `core/TimeAwareness.js` | Decora memorie con eta, validita temporale, superseded/stale. | memory list/current input | memorie decorate | n/a | Buono | Euristico; usa tempo relativo. | Molto utile nel gate prompt. |
| `core/WorldStateTracker.js` | Stato mondo/spaziale/validita da memorie. | memories/input | world state prompt | n/a | Medio | Specifico e linguistico; non confondere con `world_brief`. | Staging. |
| `core/MemoryEventLogger.js` | Eventi JSONL append-only `echoed/promoted/suppressed/recall_summary`. | events | `<user>_memory_events.jsonl` | fs/path | Buono | Best-effort, schema minimo. | Integrare subito per metriche non invasive. |
| `core/EchoStateBuilder.js` | Aggrega eventi echo per memoryId. | JSONL/eventi | echo state | fs | Buono | Legge tutto il JSONL; ok per piccoli log. | Integrare in diagnostica. |
| `core/EchoReinforcementPolicy.js` | Produce piano dry-run di rinforzo/inibizione/link da echo state. | states, memories, links | plan dry-run | n/a | Buono/staging | Non applica realmente; va collegato a TransactionManager futuro. | Staging. |
| `core/MemoryLifecycle.js` | Stati COLD/WARM/HOT/CONSCIOUS/SUPPRESSED/DECAYED. | memory, echoState, gateDecision | lifecycle object | n/a | Buono/staging | Non integrato end-to-end in `Keblomemory`. | Integrare in recall metadata, non nel prompt grezzo. |
| `core/ClusterEngine.js` | Cluster embedding, centroidi, split/merge. | storage + embeddingService | cluster | embeddingService, storage cluster | Basso/staging | Dipende da metodi storage non implementati in `JsonMemoryStorage` (`saveCluster`, `getCluster`, `deleteCluster`) e da embedding service assente. | Non integrare subito. |
| `core/GravitationalField.js` | Campo gravitazionale semantico su embedding. | memoryId/userId | influence/updates | embeddingService, storage cluster | Basso/sperimentale | `self` fuori scope a righe 54 e 141; embedding service assente; media field usa variabile fuori scope. | Non integrare finche riscritto/testato. |
| `core/OrbitalDinamics.js` | Decay/reinforce/getActiveContext/distribuzione orbitale. | storage + embeddingService | memoria/link aggiornati | MemoryNode/Link methods | Basso/sperimentale | Nome typo `Dinamics`; assume `memory.recalculateOrbitalLevel()`, `link.decay()`, `m.isCold()` su plain JSON. | Lasciare staging/riscrivere. |
| `core/EnergyStabilizer.js` | Normalizza energia globale, entropia, inject energy. | storage/user | report/updates | MemoryNode methods | Basso/sperimentale | `self` fuori scope riga 184; assume `recalculateOrbitalLevel()` su plain JSON. | Non integrare prima di fix. |
| `core/MemoriaOrbitaleConCampi.js` | Wrapper che combina gravita/energia/memory types. | storage/embedding | sistema avanzato | moduli sperimentali | Basso | Dipende dai moduli fragili sopra. | Scartare per ora. |
| `core/MemoryTypes.js` | Tipi memoria e retrieval embedding. | storage/embedding | memories/search | embeddingService | Basso/medio | Dipende da embedding service non presente. | Staging. |
| `core/OrbitaleBridge.js` | Bridge semplice a `KebloMemory` + `JsonMemoryStorage`. | dataDir/user | remember/recall | core | Medio | CommonJS; non risolve gate/service boundary. | Utile come ispirazione adapter. |

### Storage e dati

| Area | Presenza | Valutazione |
|---|---|---|
| JSON full-file | Si: `JsonMemoryStorage` legge/scrive oggetti JSON per memorie/link. | Semplice ma non scala bene a decine di migliaia di ricordi; scrittura full-file a ogni save. |
| JSONL append-only | Si solo per `MemoryEventLogger` echo events. | Buono: da estendere per ingestion log. |
| TransactionManager | Non trovato come modulo reale. | Manca rollback applicativo. |
| JSONLStorage | Non trovato come modulo reale. | Da creare se si vuole append-only serio. |
| QdrantClient | Non trovato. | Qdrant non e' obbligatorio nel codice letto; bene per fallback, ma manca integrazione vector reale. |
| EmbeddingService | Non trovato come implementazione concreta. | Cluster/gravita/vector retrieval non sono eseguibili end-to-end senza adapter. |
| Cockpit data | `apps/orbitale-cockpilot/src/initialData.ts` enorme generato. | Non va integrato in Keblo runtime. |
| Import OpenAI | `scripts/import_openai_export.js` genera memorie `mem_openai_*`, link `dialogue_sequence/continuation`, backup e dedup per id stabile. | Buono come offline import, ma non nel runtime chat. |

### API e scheduler autonomi

- Non esiste una `MemoryAPI` core stabile in `core/`.
- `apps/orbitale-cockpilot/server.ts` e' un backend prototipo per cockpit, non API runtime memoria da innestare in Keblo.
- `chat_orbitale_ollama.js` e' una CLI, non servizio.
- Non ho trovato `MaintenanceScheduler` o `DistributedScheduler` come moduli runtime. La manutenzione e' funzione/metodo, non daemon affidabile.

### Gate, attivazione e recall

`chat_orbitale_ollama.js` contiene i pezzi piu maturi da estrarre:

- `analyzePresentContext`: gate latente. Decide se fare recall, se permettere memoria storica/OpenAI, link traversal, mutate on recall, limiti candidati e chars.
- `recallOptionsForPolicy`: traduce policy in opzioni (`excludeTags`, `excludeMemoryDepths`, `excludeOrbitalLevels`).
- `promoteToConsciousContext`: gate consapevole. Ordina per promotion rank, limita duplicati, chars e numero memorie.
- `MemoryEventLogger`: scrive eventi `echoed/promoted/suppressed/summary`.

Questi sono piu importanti di cluster/gravita/Qdrant per una prima integrazione sicura.

## 4. Confronto Memoria Standard Keblo vs Memoria_Orbitale_Autonomo

| Funzione | Keblo attuale | Memoria_Orbitale_Autonomo | Differenza | Vantaggio autonoma | Rischio integrazione | Decisione consigliata |
|---|---|---|---|---|---|---|
| Storage memoria | JSONL conversazioni + JSON card + shadow JSON orbitale opzionale. | JSON full-file memorie/link + JSONL eventi echo. | Keblo archivia turni; autonoma modella ricordi. | Ricordi separati dalla chat. | Full-file JSON lento/corrompibile su dataset grandi. | Adapter con append-only staging e fallback. |
| Modello dati ricordo | Turno `{role,text,ts,traffic,confidence,meta}`. | Memory con `type, content, activation, orbitalLevel, memoryDepth, tags, dualState, meta`. | Autonoma molto piu ricca. | Timestamp, orbita, energia, depth, fonte. | Schema misto `orbital.*`/flat fields. | Normalizzare DTO Keblo. |
| Temporalita | Timestamp turni + `getTimeAgo`; short memory topic. | `TimeAwareness`, validity, stale/current/completed, temporal links import. | Autonoma ragiona su validita temporale. | Riduce uso di fatti scaduti. | Euristiche da testare. | Integrare nel formatter recall. |
| Decadimento | Non c'e' decay conversazioni. | `decayAll`, activation decay, cold compression. | Autonoma dinamica. | Evita contesto vecchio dominante. | Puo mutare/cancellare troppo. | Solo daemon dry-run iniziale. |
| Rinforzo | Traffic/confidence manuale; shadow save green. | Reinforce on access, dual activation, echo policy. | Autonoma rinforza uso reale. | Memorie utili emergono. | Recall mutativo puo gonfiare rumore. | `mutateOnRecall:false` in chat; rinforzo in maintenance. |
| Link semantici | Nessuno nella memoria standard; shadow link euristici. | LinkManager, semantic/continuation/dialogue_sequence. | Autonoma ha grafo. | Traversal e co-echo. | Link rumorosi su import massive. | Usare link solo dopo gate. |
| Link temporali | Conversation order implicito JSONL. | Import OpenAI crea `dialogue_sequence` con gap class. | Autonoma esplicita sequenza. | Ricostruzione storica. | Link sequenziali possono contaminare semantic recall. | Separare link temporali da semantici. |
| Cluster | No. | ClusterEngine embedding. | Solo autonoma. | Potenziale scala/temi. | Embedding/storage cluster mancanti. | Staging. |
| Ricerca/recall | Ultimi green exchange + search testuale/rerank. | Recall scoring testo+activation+echo+link. | Autonoma seleziona ricordi. | Migliore pertinenza se gate corretto. | Score piatti su input generici. | Gate prima del recall. |
| Retrieval bias correction | Sanitizer risposta e prompt rules; no recall bias. | `RetrievalBiasCorrector`, penalties generic/duplicate. | Autonoma piu avanzata. | Meno duplicati e generic assistant. | Embedding path incompleto. | Integrare scoring non-vector. |
| Compressione memoria fredda | No. | `ColdMemoryCompressor`. | Solo autonoma. | Scala a lungo termine. | Compressione metadata non reversibile. | Staging con backup. |
| Import ricordi OpenAI | No. | Script import con dedup id stabile, chunk, backup. | Solo autonoma. | Recupera storia pregressa. | Import massive e rumore. | Offline staging, non chat runtime. |
| JSONL append-only | Conversazioni si; memoria no; eventi no. | Eventi echo si. | Entrambi parziali. | Event log buono per audit. | Memorie principali ancora full JSON. | Creare ingestion JSONL. |
| Vector store/Qdrant | No. | Non trovato Qdrant reale; embedding richiesto da moduli. | Nessuno pronto. | Possibilita futura. | Se reso obbligatorio rompe tutto. | Opzionale con fallback lexical. |
| Embedding service | Reranker HTTP usato per news/conversation search. | Interfaccia implicita embeddingService, non implementata. | Keblo ha servizio rerank, autonoma richiede embedding. | Futuro semantic retrieval. | Dipendenza mancante. | Non bloccare MVP. |
| API memoria | `/api/orbitale/status/graph` read-only. | Nessuna API core stabile; cockpit separato. | Keblo ha API diagnostica minima. | Autonoma ha logica ma non endpoint. | Duplicare API crea caos. | Unificare sotto Keblo. |
| Metriche | LLM token/speed, route meta, orbitale status counts. | EchoState, stats, lifecycle, cockpit metrics. | Autonoma piu ricca. | Diagnostica memoria utile. | Dataset cockpit enorme. | Integrare API diagnostica leggera. |
| Scheduler/daemon | Reminders e world brief scheduler. | Maintenance funzioni, automation planner, non daemon runtime. | Keblo ha scheduler attivi. | Autonoma ha manutenzione cognitiva. | Mancanza rollback. | Nuovo daemon separato e disabilitabile. |
| Robustezza transazionale | JSONL append per conversazioni; atomic rename in reminders; vari full writes. | Import usa atomic rename/backups; storage core no transaction. | Entrambi parziali. | Import e' piu sicuro dello storage runtime. | Corruzione JSON su crash. | Transaction/backup prima di write massive. |
| Integrazione chat | Centrale e stabile: server -> engine -> llm_router. | CLI separata. | Autonoma non integrata in web chat. | Gate gia sperimentato. | Copia brutale rompe SSE/chat. | Adapter read-only prima. |
| Integrazione prompt LLM | Prompt usa intent directives e history. | CLI inserisce memoryContext system invisibile. | Autonoma ha conscious context. | Migliora personalizzazione. | Rischio rumore e allucinazione memoria. | Inserire blocco breve, citabile solo se richiesto. |
| Gate consapevole/latent memory | Solo shortMemory/context shift. | Latent gate + conscious gate. | Autonoma molto superiore. | Memoria non entra sempre nel prompt. | Oggi funzioni dentro CLI. | Estrarre in `OrbitalRecallGateway`. |
| Separazione grezza/consolidata | Conversation JSONL vs shortMemory; non consolidata. | Historical/deep/normal/temporary/core, cold/hot lifecycle. | Autonoma piu ricca. | Migrazione controllata. | Stati non integrati end-to-end. | Definire stati Keblo. |
| Scala molti ricordi | JSONL history ok per append, recall no. | 40k+ dataset esistente, ma full scan/full write. | Autonoma ha dati grandi ma non storage scalabile. | Esperienza reale su scala. | Performance alta. | Indice/cache + staging. |
| Rischio rumore nel contesto | Limitato a ultimi green exchange. | Alto se gate debole/import massive. | Autonoma piu potente e piu rischiosa. | Gate riduce rumore se applicato. | Input banali possono richiamare memorie storiche se policy errata. | Gate obbligatorio e budget chars. |

## 5. Bug, Incoerenze e Rischi Bloccanti

| Gravita | File/riga | Problema | Fix consigliato |
|---|---|---|---|
| BLOCKER | `Memoria_Orbitale_Autonomo/core/GravitationalField.js:54`, `:141` | Usa `self.G` nei metodi, ma `const self = this` e' locale al constructor e non visibile. Runtime `ReferenceError` appena si calcola influenza/potenziale. | Sostituire con `this.G`; aggiungere test. |
| BLOCKER | `Memoria_Orbitale_Autonomo/core/EnergyStabilizer.js:184` | Usa `self.stabilize` fuori scope. Runtime `ReferenceError` in `injectEnergy`. | Usare `this.stabilize`; testare `injectEnergy`. |
| BLOCKER | `Memoria_Orbitale_Autonomo/core/OrbitalDinamics.js:30`, `:37`, `:128` | Assume metodi `memory.recalculateOrbitalLevel()`, `link.decay()`, `m.isCold()` su dati JSON plain. `JsonMemoryStorage` restituisce oggetti plain. | Convertire a funzioni pure o reidratare MemoryNode/Link; test con JsonMemoryStorage reale. |
| BLOCKER | `Memoria_Orbitale_Autonomo/core/ClusterEngine.js:57`, `:122`, `:139`, `:146`, `:197`, `:213` | Usa `saveCluster/getCluster/deleteCluster`, non implementati in `JsonMemoryStorage`. | Estendere storage o disabilitare cluster finche non c'e' backend. |
| HIGH | `Memoria_Orbitale_Autonomo/core/ClusterEngine.js`, `GravitationalField.js`, `MemoryTypes.js`, `RetrievalBiasCorrector.js` | Richiedono `embeddingService`, ma non esiste implementazione concreta. | Definire `EmbeddingService` opzionale con fallback lexical; non importare questi moduli nel runtime chat. |
| HIGH | `Memoria_Orbitale_Autonomo/core/JsonMemoryStorage.js` | Ogni `saveMemory/saveLink` legge e riscrive tutto il file JSON. Con 40k ricordi e 30k link diventa lento e fragile. | Introdurre append-only log + compaction o SQLite; usare lock/atomic write. |
| HIGH | `Memoria_Orbitale_Autonomo/chat_orbitale_ollama.js` | Gate e prompt sono dentro CLI; endpoint hardcoded (`100.127.150.67`, `localhost`), userId fisso `francesco`. | Estrarre gate in moduli puri e passare config/env da Keblo. |
| HIGH | `Memoria_Orbitale_Autonomo/scripts/import_openai_export.js:445-450`, `:661-676` | Import applicato scrive direttamente su `orbitale_chat_data`; fa backup, ma non ha staging/validation dedup semantica, solo id stabile. | Importare in staging, generare report, poi promuovere con soglie e dedup semantic/temporal. |
| HIGH | `server.js:109`, `:127-209`, `:1954` | Memoria orbitale Keblo e' solo shadow su confidence green; non c'e' recall in chat. | Aggiungere read-only recall gateway prima di LLM, disabilitabile. |
| HIGH | `server.js:1406-1769` | Route chat e' monolitica; world/PubMed/intent/LLM/storage tutti in un blocco. | Integrare memoria tramite adapter piccolo per non aumentare il monolite. |
| MEDIUM | `intent_memory_router.js:14` e `:1358` | Duplicazione massiva del router nello stesso file. Sintassi ok ma manutenzione fragile. | In batch separato, rimuovere backup commentato/duplicato solo dopo test. |
| MEDIUM | `Memoria_Orbitale_Autonomo/core/OrbitalDinamics.js` | Nome file typo `Dinamics`; richiesta menziona anche `OrbitalDynamics`. | Rinominare solo in batch controllato con alias compatibile. |
| MEDIUM | `src/memory/orbitale/OrbitaleMemoryAdapter.js` | Caricamento CommonJS via `vm.runInThisContext` dentro progetto ESM. | Sostituire con boundary esplicito o convertire core a ESM/adapter CJS stabile. |
| MEDIUM | `pubmed_search.js` | Credenziali Postgres hardcoded (`keblo/keblo123`). | Spostare in env e documentare fallback health. |
| MEDIUM | `memory_store.js` | Scrive `storage/memory/<user>.json` senza creare la directory. | `fs.mkdirSync(BASE_PATH,{recursive:true})`. |
| MEDIUM | `conversation_repo.js` | `readAllTurns` e search leggono tutto il JSONL in memoria. | Streaming/tail index per storie grandi. |
| MEDIUM | `llm_router.js` | Logga prompt completo in console. Con memoria personale avanzata aumentera' leakage locale. | Ridurre log o redigere memory block. |
| MEDIUM | `Memoria_Orbitale_Autonomo/apps/orbitale-cockpilot/src/initialData.ts` | Dataset enorme generato nel frontend. | Sostituire con API paginata; non portarlo in Keblo. |
| LOW | `server.js` | Commenti e backup route `/api/chat` dentro commento lungo. | Pulizia futura, non in questa fase. |

`node --check` passa per: `server.js`, `Memoria_Orbitale_Autonomo/chat_orbitale_ollama.js`, `GravitationalField.js`, `EnergyStabilizer.js`, `OrbitalDinamics.js`. I bug sopra sono runtime/contrattuali, non sintattici.

## 6. Architettura di Integrazione Consigliata

Struttura proposta:

```text
keblo_dev/
  memory/
    orbital/
      OrbitalMemoryService.js
      OrbitalMemoryAdapter.js
      OrbitalRecallGateway.js
      OrbitalIngestionPipeline.js
      OrbitalMaintenanceDaemon.js
      MemorySignalAdapter.js
      ConsciousMemoryGate.js
      storage/
        OrbitalStorage.js
        JsonOrbitalStorage.js
        JsonlEventStore.js
        VectorStoreAdapter.js
      core/
        KebloMemoryCore.js
        ActivationEngine.js
        LinkManager.js
        TimeAwareness.js
        EchoStateBuilder.js
        MemoryLifecycle.js
      importers/
        OpenAIImportService.js
      metrics/
        OrbitalMetricsCollector.js
      legacy/
        OrbitaleShadowAdapter.js
```

Principi:

- Keblo resta il sistema principale.
- La chat non importa `Keblomemory.js`, `GravitationalField`, `ClusterEngine` o storage profondi.
- Unico punto di accesso: `OrbitalMemoryService`.
- `Qdrant`/embedding opzionali: se mancano, recall lexical+activation.
- Import OpenAI offline, mai nella route `/api/chat`.
- Gate obbligatorio prima del prompt.
- Ricordo normalizzato: `id`, `text`, `role`, `source`, `timestamp`, `confidence`, `energy`, `orbitalLevel`, `memoryDepth`, `lifecycle`, `links`, `tags`.
- Fallback totale: se memoria avanzata fallisce, chat continua con storia green attuale.

Flusso finale:

```text
Utente scrive
-> Keblo /api/chat riceve messaggio
-> appendTurn conversation JSONL
-> intent/domain router
-> OrbitalMemoryService.recall({ userId, text, intentAnalysis })
-> OrbitalRecallGateway decide latent policy
-> ConsciousMemoryGate seleziona max N ricordi e max chars
-> llm_router costruisce prompt con blocco memoria filtrato
-> LLM risponde
-> appendTurn assistant
-> MemorySignalExtractor / ingestion post-turno
-> OrbitalMemoryService.ingestTurn({ user, assistant, route, confidence })
-> storage append-only + snapshot JSON
-> maintenance daemon
-> consolidamento / decadimento / link / compressione / metriche
```

Posizionamento nel codice attuale:

- `server.js` deve chiamare solo `OrbitalMemoryService.recall` prima di `processInput`.
- `keblo_engine.js` e `llm_router.js` ricevono un campo `memoryContextBlock` dentro `intentAnalysis` o parametro dedicato.
- `conversation_repo.js` resta sorgente audit/fallback.
- `src/memory/orbitale/OrbitaleMemoryAdapter.js` resta legacy fino a migrazione.

## 7. Piano Batch di Implementazione

| Batch | Obiettivo | File da creare | File da modificare | Test | Rischio | Rollback | Done |
|---|---|---|---|---|---|---|---|
| 0 - Audit e mappa | Chiudere audit e decisioni. | `ORBITAL_MEMORY_AUDIT.md` | Nessuno | review manuale | Basso | eliminare solo report se richiesto | Report approvato. |
| 1 - Fix bloccanti autonoma | Rendere core non crashante in staging. | test mirati in staging | `GravitationalField.js`, `EnergyStabilizer.js`, `OrbitalDinamics.js`, storage cluster o disabilitazione | `node --check`, unit su metodi bug | Medio | revert batch | Nessun blocker runtime noto. |
| 2 - Normalizzazione moduli core | Separare moduli puri da CLI/data. | `memory/orbital/core/*` | nessun server chat | unit pure | Medio | rimuovere nuova dir | Core importabile senza CLI. |
| 3 - OrbitalMemoryService adapter | Creare boundary unico. | `OrbitalMemoryService.js`, `OrbitalMemoryAdapter.js`, storage fallback | `package.json` solo se serve script test | unit service con temp dir | Medio | feature flag off | `recall/ingest` no-op/fallback funzionano. |
| 4 - Import OpenAI staging | Import offline in staging. | `importers/OpenAIImportService.js`, staging dir | script import derivato | dry-run + count/dedup | Alto privacy/rumore | cancellare staging | Report import approvabile. |
| 5 - Recall read-only nella chat | Inserire recall senza scrivere/mutare. | `OrbitalRecallGateway.js`, `ConsciousMemoryGate.js` | `server.js`, `keblo_engine.js`/`llm_router.js` minimo | chat smoke, trivial input no recall, explicit recall si | Medio | env flag off | Chat invariata se flag off, memoria visibile se on. |
| 6 - Ingestion post-turno | Salvare segnali dopo risposta. | `OrbitalIngestionPipeline.js`, `JsonlEventStore.js` | `server.js` post append assistant | unit + chat smoke | Medio | flag off + ignore new data | JSONL append e snapshot coerenti. |
| 7 - Gate latente/consapevole | Portare policy CLI in moduli testati. | gate modules | service config | test policy matrix | Medio | fallback no memory | Input banali non richiamano storico. |
| 8 - Daemon manutenzione | Decay/link/compress dry-run. | `OrbitalMaintenanceDaemon.js` | server startup opzionale | dry-run report | Alto se mutativo | dry-run only/flag off | Nessuna mutazione senza apply. |
| 9 - API diagnostica memoria | Status, recall debug, echo state. | metrics/API module | `server.js` routes leggere | API tests manuali | Basso | remove routes/flag | API read-only. |
| 10 - UI diagnostica memoria | Integrare cockpit leggero in UI Keblo. | componenti UI | `public/index.html`/assets | browser smoke | Medio | hide feature flag | Nessun dataset enorme bundle. |
| 11 - Test end-to-end | Coprire chat + recall + fallback. | test e fixtures | `package.json` scripts | e2e/local mocked LLM | Medio | skip feature flag | CI/local test ripetibile. |
| 12 - Migrazione controllata | Passare da memoria standard a orbitale. | migration scripts | config/env | canary utenti | Alto | tornare a history green | Metriche migliori senza regressioni chat. |

## 8. Cosa Integrare Subito, Staging, Scartare

Integrare subito:

- Gate latente e consapevole da `chat_orbitale_ollama.js`, ma estratti in moduli puri.
- `MemorySignalExtractor` come supporto ingestion.
- `TimeAwareness` nel formatter.
- `MemoryEventLogger` + `EchoStateBuilder` per metriche append-only.
- `Keblomemory.recall` in read-only (`mutateOnRecall:false`) dietro adapter.

Lasciare in staging:

- Import OpenAI.
- Cold compression.
- Echo reinforcement policy applicativa.
- Lifecycle nel prompt.
- Cockpit orbitale.
- Cluster/embedding/gravita/energia.

Scartare o riscrivere prima dell'uso:

- `GravitationalField` attuale.
- `EnergyStabilizer` attuale.
- `OrbitalDinamics` attuale.
- `MemoriaOrbitaleConCampi` come wrapper runtime.
- Dataset frontend statico `initialData.ts` come modello per Keblo.
- Loader ESM->CJS via `vm` come boundary finale.

## 9. Lista File Piu Importanti

Keblo:

- `server.js`
- `keblo_engine.js`
- `llm_router.js`
- `conversation_repo.js`
- `intent_memory_router.js`
- `domain_aware_intent_router.js`
- `src/memory/orbitale/OrbitaleMemoryAdapter.js`
- `src/memory/orbitale/TemporalContextBuilder.js`
- `src/memory/orbitale/PromptMemoryFormatter.js`
- `scheduler.js`
- `world_brief_scheduler.js`
- `news_pipeline.js`
- `pubmed_search.js`
- `project_nexus/nexus_storage.js`

Memoria autonoma:

- `Memoria_Orbitale_Autonomo/core/Keblomemory.js`
- `Memoria_Orbitale_Autonomo/core/JsonMemoryStorage.js`
- `Memoria_Orbitale_Autonomo/core/MemorySignalExtractor.js`
- `Memoria_Orbitale_Autonomo/core/TimeAwareness.js`
- `Memoria_Orbitale_Autonomo/core/MemoryEventLogger.js`
- `Memoria_Orbitale_Autonomo/core/EchoStateBuilder.js`
- `Memoria_Orbitale_Autonomo/core/MemoryLifecycle.js`
- `Memoria_Orbitale_Autonomo/core/EchoReinforcementPolicy.js`
- `Memoria_Orbitale_Autonomo/chat_orbitale_ollama.js`
- `Memoria_Orbitale_Autonomo/scripts/import_openai_export.js`
- `Memoria_Orbitale_Autonomo/docs/MEMORIA_ORBITALE_ROADMAP.md`
- `Memoria_Orbitale_Autonomo/docs/PROJECT_DELTA_0_AUDIT.md`

## 10. Ordine Esatto dei Prossimi Fix

1. Fix runtime `self` in `GravitationalField.js` e `EnergyStabilizer.js` oppure escludere questi moduli dal barrel/runtime.
2. Rendere `OrbitalDinamics.js` compatibile con plain JSON o metterlo fuori servizio.
3. Definire schema unico `OrbitalMemoryDTO` per Keblo.
4. Creare `OrbitalMemoryService` no-op + JSON fallback, feature flag off.
5. Estrarre `analyzePresentContext`, `recallOptionsForPolicy`, `promoteToConsciousContext` dalla CLI autonoma.
6. Collegare recall read-only alla chat con budget: max 3-5 memorie, max 1500-2500 chars, `mutateOnRecall:false`.
7. Aggiungere eventi JSONL per `echoed/promoted/suppressed/summary`.
8. Import OpenAI solo in staging e solo dopo report dedup.
9. Daemon manutenzione in dry-run.
10. API diagnostica e UI leggera.

Conclusione: **Memoria_Orbitale_Autonomo puo diventare il nuovo cuore memoria di Keblo, ma solo tramite adapter, gate e rollout read-only iniziale**. Il valore reale e' nel modello ricordo + gate + echo/lifecycle, non nei moduli fisici sperimentali ne' nel cockpit statico.
