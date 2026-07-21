# Project Delta 0 Audit - Memoria_Orbitale_Autonomo

Data audit: 2026-06-26  
Root analizzata: `/home/francesco/MemoriaOrbitale/Memoria_Orbitale_Autonomo`  
Regola applicata: audit read-only del repository; nessun contenuto privato delle memorie riportato.

## 1. Executive Summary

Questo progetto oggi e un prototipo locale di memoria persistente per assistente personale, costruito attorno al concetto di Memoria Orbitale: le memorie non sono direttamente contesto del modello, ma un bacino dinamico da cui selezionare, pesare e promuovere frammenti rilevanti.

Il repository contiene piu sottosistemi:

| Sottosistema | Scopo | Stato generale |
|---|---|---|
| Core Memoria Orbitale | Salvataggio memorie, recall, activation, decay, link, echo, lifecycle | Parziale / sperimentale |
| Chat locale/Ollama | CLI conversazionale con gate memoria e modelli Ollama/OpenAI opzionale | Implemented ma sperimentale |
| Automation Codex | Coda fix, state machine, prompt export, log, verifica | Implemented ma molto grande |
| Planner | Scan/suggest/import/plan automatico per fix | Implemented, euristico |
| Cockpit frontend | UI React/Vite per visualizzare e manipolare rete memoria | Implemented come prototipo, data-heavy |
| Dati memoria | JSON runtime con memorie, link, eventi echo e import OpenAI | Reale/runtime, alto rischio privacy |
| Script diagnostici | Import, inspect echo, sync cockpit, test manuali | Parziale / operativo |
| Documentazione | Roadmap, planner, batch, checkpoint, stack PDF | Parziale |

Stato generale: **parziale e sperimentale**. Il progetto ha componenti funzionanti e una direzione architetturale chiara, ma mescola ancora sorgente, runtime data, export privati, backup, build output e dashboard generata. Il rischio principale non e l'assenza di codice, ma la separazione insufficiente tra codice, dati personali, artifact generati e automazione.

## 2. Mappa Directory

Directory principali rilevate:

| Directory | Scopo presunto | File principali / contenuto | Stato | Rischio | Git: tracciare / ignorare |
|---|---|---|---|---|---|
| `apps/` | Applicazioni frontend, oggi cockpit React | `orbitale-cockpilot/` | Sorgente + build + dipendenze locali | Alto | Tracciare sorgente/config; ignorare `node_modules`, `dist`, `.env`, zip, build |
| `apps/orbitale-cockpilot/src/` | Frontend cockpit | `App.tsx`, componenti, `initialData.ts` | Sorgente + dati generati | Alto | Tracciare componenti; spostare/ignorare `initialData.ts` data-heavy o sostituirlo con loader |
| `apps/orbitale-cockpilot/dist/` | Build Vite/server generata | asset bundle circa 73 MB | Generato | Alto | Ignorare sempre |
| `apps/orbitale-cockpilot/node_modules/` | Dipendenze installate | pacchetti npm circa 215 MB | Runtime/dev locale | Medio | Ignorare sempre |
| `automation/` | Engine fix Codex e planner | `codex_runner.js`, `planner.js`, `fix_queue.json`, `logs/`, `planner-output/` | Sorgente + stato + artifact | Medio/alto | Tracciare engine, prompt base e queue se deliberato; ignorare output/log massivi salvo checkpoint scelti |
| `automation/logs/` | Artifact fix/batch | batch, prompt, diff, report fix | Generato / audit trail | Medio | Tracciare solo log essenziali; ignorare run temporanei se crescono |
| `automation/planner-output/` | Output scan/suggest/import/plan | `scan-report.*`, `suggested-fixes.*` | Generato | Basso/medio | Ignorare; gia in `.gitignore` |
| `automation/prompts/` | Template prompt | `base_codex_prompt.md` | Sorgente | Basso | Tracciare |
| `core/` | Motore memoria orbitale | moduli JS core | Sorgente | Medio | Tracciare |
| `docs/` | Documentazione | roadmap, planner, batch, checkpoint, PDF stack, zip ignorato | Sorgente/documenti + artifact | Medio | Tracciare `.md` utili; valutare PDF; ignorare zip |
| `scripts/` | Script operativi | `import_openai_export.js`, `inspect_echo_state.js` | Sorgente operativo | Medio | Tracciare |
| `orbitale_chat_data/` | Runtime memoria chat locale | memorie/link/eventi per user locale | Dati reali runtime | Alto privacy | Ignorare sempre; backup cifrato fuori repo se necessario |
| `keblo_data/` | Dataset memoria legacy/prototipo | `keblo_user_memories.json`, `keblo_user_links.json` | Dati runtime | Alto privacy | Ignorare sempre |
| `imports/` | Export OpenAI importati | conversazioni shard e manifest | Export privato | Alto privacy | Ignorare sempre |
| `backups/` | Backup manuali/import/dev diff | `openai_import/`, `dev_diffs/` | Backup / storico locale | Alto privacy | Ignorare; archiviare fuori repo |
| `backup_orbitale_chat_data/` | Backup dati chat orbitale | copia memorie/link | Backup runtime | Alto privacy | Ignorare; archiviare fuori repo |
| `tmp_orbitale_data/` | Output test diagnostici JSON storage | memorie/link diagnostiche | Temporaneo | Basso/medio | Ignorare e pulire periodicamente |
| `tmp_orbitale_bridge_data/` | Output test bridge | memorie/link diagnostiche | Temporaneo | Basso/medio | Ignorare e pulire periodicamente |
| `openai_export_backup/` | Backup export OpenAI, da verificare | nessun file rilevante in audit | Backup placeholder | Medio | Ignorare |
| `__pycache__/` | Cache Python | `.pyc` | Generato | Basso | Ignorare |
| `.git/` | Database Git | history e object store | VCS interno | Medio | Non toccare |

File top-level principali:

| File | Scopo | Stato | Rischio Git |
|---|---|---|---|
| `chat_orbitale_ollama.js` | CLI chat memoria + Ollama/OpenAI opzionale | Sorgente attivo | Tracciare |
| `sync_orbitale_to_cockpit.js` | Genera `initialData.ts` da dati runtime | Script operativo | Tracciare, ma attenzione output |
| `test_orbitale_minimo.js` | Diagnostici manuali multipli | Test/script manuale | Tracciare se usato |
| `keblo_*.py`, `Keblo_ChatDualLLM(daTestare).py` | Prototipi/legacy Python | Legacy/partial | Tracciare se ancora rilevanti |
| `orbitale_output.log` | Log runtime | Generato | Ignorare |
| `orbitale_visual.html` | Visualizzazione generata | Generato | Ignorare |

## 3. Architettura Generale

### Memoria Orbitale Core

Il core e in `core/` ed e composto da moduli specializzati:

- `Keblomemory.js`: orchestratore principale, crea memorie, recall, reinforce, decay, compress, stats e link.
- `JsonMemoryStorage.js`: persistenza JSON su disco.
- `ActivationEngine.js`, `DualActivation.js`, `EnergyStabilizer.js`: dinamica di attivazione/stati.
- `Link.js`, `LinkManager.js`, `ClusterEngine.js`, `GravitationalField.js`: relazioni e campo semantico.
- `MemoryEventLogger.js`, `EchoStateBuilder.js`, `EchoReinforcementPolicy.js`: logging echo, aggregazione stato e policy dry-run.
- `MemoryLifecycle.js`: stati COLD/WARM/HOT/CONSCIOUS/SUPPRESSED/DECAYED e transizioni.
- `MemorySignalExtractor.js`, `TimeAwareness.js`, `WorldStateTracker.js`: segnali, tempo e stato mondo.

Il core e modulare a livello file, ma `Keblomemory.js` resta il punto di accoppiamento piu grande.

### Chat Locale/Ollama

`chat_orbitale_ollama.js` e la CLI principale. Usa:

- `KebloMemory` con `JsonMemoryStorage` su `orbitale_chat_data`.
- `MemorySignalExtractor` per classificare input.
- gate di contesto (`analyzePresentContext`, `recallOptionsForPolicy`, `promoteToConsciousContext`).
- `MemoryEventLogger` per eventi append-only.
- Ollama primario/fallback e OpenAI opzionale via env.

Il flusso e:

1. input utente;
2. estrazione segnali;
3. gate latente;
4. recall candidati;
5. promotion a conscious context;
6. logging echo/promoted/suppressed;
7. prompt al modello;
8. eventuale salvataggio memoria utente/assistant e link semantici.

### Automazione Codex

`automation/codex_runner.js` e un engine esteso per coda fix, stati, preflight, prompt, diff, verifica e report. La state machine supporta `pending`, `prepared`, `running`, `verified`, `completed`, `failed`.

`automation/fix_queue.json` e lo stato operativo della pipeline. Al momento dell'audit contiene 22 fix, con conteggio rilevato: 18 `completed`, 4 `failed`.

### Planner

`automation/planner.js` scansiona file, produce suggerimenti, importa fix in coda e scrive report in `automation/planner-output`. Ignora esplicitamente directory dati/build come `automation/logs`, `node_modules`, `dist`, `orbitale_chat_data`, `keblo_data`, `imports`.

### Cockpit Frontend

`apps/orbitale-cockpilot` e una app React/Vite con:

- `App.tsx`: stato centrale, tabs, chat, arena, investigator, mutazioni locali.
- `OrbitalArena.tsx`: visualizzazione SVG orbitale/costellazione, overlay echo.
- `CognitiveInvestigator.tsx`: rightbar/pannello analisi nodo e sistema.
- `JaceChat.tsx`: chat frontend verso `/api/chat`.
- `server.ts`: backend Express/Gemini per estrazione/risposta, da verificare in dettaglio.
- `initialData.ts`: dataset enorme generato da runtime data.

### Dati Memoria

`orbitale_chat_data` contiene il dataset reale principale:

| File | Dimensione | Conteggio non sensibile |
|---|---:|---:|
| `francesco_memories.json` | circa 95 MB | 40.712 record |
| `francesco_links.json` | circa 17 MB | 30.694 record |
| `francesco_memory_events.jsonl` | circa 10 KB | 36 eventi |

Questi dati sono runtime/privati e non vanno committati.

### Logging Eventi Memoria

Gli eventi sono JSONL append-only, sanitizzati da `MemoryEventLogger`, con tipi `echoed`, `promoted`, `suppressed`, `recall_summary`. `EchoStateBuilder` li aggrega in metriche per memoryId.

### Script Diagnostici

Script principali:

- `scripts/inspect_echo_state.js`: stampa metadata echo aggregati, non contenuto memoria.
- `scripts/import_openai_export.js`: importa shard export OpenAI verso `orbitale_chat_data`, con backup.
- `sync_orbitale_to_cockpit.js`: trasforma dati runtime in `initialData.ts`.
- `test_orbitale_minimo.js`: diagnostici manuali estesi.
- `view_orbite.js`, `visualize_orbitale.js`: visualizzazione/analisi legacy.

### Documentazione

Documenti presenti:

- `docs/MEMORIA_ORBITALE_ROADMAP.md`
- `docs/PLANNER.md`
- `docs/AUTOFIX_BATCH.md`
- `docs/checkpoints/memoria_orbitale_v0.7.md`
- `docs/stack/Stack Memoria Orbitale Universale.pdf`

La documentazione e utile ma ancora piu roadmap/checkpoint che specifica tecnica completa.

## 4. File Principali

| File | Responsabilita | Dipendenze principali | Input / Output | Rischio tecnico | Stato |
|---|---|---|---|---|---|
| `chat_orbitale_ollama.js` | CLI chat, gate memoria, prompt, chiamate modello, logging eventi | `readline`, `KebloMemory`, `JsonMemoryStorage`, `MemoryEventLogger`, `MemorySignalExtractor`, fetch/Ollama/OpenAI | Input stdin/env/dati JSON; output console, memorie/link/eventi | Alto: molti ruoli in 813 linee, endpoint hardcoded di default, dati reali | Implemented / sperimentale |
| `core/Keblomemory.js` | Orchestratore memoria: remember, recall, reinforce, decay, compress, stats, link | Activation/link/retrieval/index/dual/compressor/storage | Input content/query/options; output memory/results/update storage | Alto: 956 linee, molte euristiche, accoppiamento alto | Implemented / partial |
| `core/MemoryEventLogger.js` | Logging append-only eventi echo/promoted/suppressed/summary | `fs`, `path` | Input eventi; output JSONL sanitizzato | Medio: scrittura best-effort con warning, schema minimo | Implemented |
| `core/EchoStateBuilder.js` | Aggrega eventi JSONL in EchoState per memoryId | `fs`, `normalizeConcepts` | Input JSONL/event array; output stati metadata | Medio: legge file intero, conta anche eventi summary con memoryId se presenti | Implemented |
| `core/Link.js` | Modello link cognitivo, tipi, reinforce, decay, merge | `crypto.randomUUID` | Input data link; output JSON link | Basso/medio: modello semplice, nessuna validazione source/target | Implemented |
| `automation/codex_runner.js` | State machine fix, prompt/export, preflight, checks, diff, report, batch | `fs`, `path`, `child_process`, Git | Input `fix_queue.json`/CLI; output queue/log/report/diff | Alto: 3025 linee, molte modalita, puo mutare queue | Implemented ma complesso |
| `automation/planner.js` | Scan repository, suggerisci fix, importa fix, report plan | `fs`, `path` | Input repo/queue; output planner-output e queue se import | Medio/alto: euristiche meccaniche, import modifica queue | Implemented / euristico |
| `apps/orbitale-cockpilot/src/App.tsx` | Shell UI, stato memorie/link, tabs, mutazioni, chat API | React, `initialData`, componenti, lucide | Input localStorage/API/user; output UI/localStorage | Alto: usa dataset enorme, contiene azioni delete/purge locali, possibile bug di scope da verificare | Implemented / partial |
| `apps/orbitale-cockpilot/src/components/OrbitalArena.tsx` | SVG arena orbitale/costellazione, pan/zoom, overlay echo | React, lucide, types | Input memorie/link/stato UI; output SVG interattivo | Medio/alto: render su decine di migliaia di nodi potenzialmente costoso; duplicazione condizione rilevata | Implemented / partial |
| `apps/orbitale-cockpilot/src/components/CognitiveInvestigator.tsx` | Rightbar analisi nodo/sistema, tag/domain hint, metriche, azioni | React, lucide, types | Input memorie/link/selected; output panel e callbacks | Medio: contiene azioni distruttive lato UI; duplicazione icona rilevata | Implemented / partial |
| `apps/orbitale-cockpilot/src/initialData.ts` | Dataset frontend generato | `types.ts` | Export `INITIAL_MEMORIES`, `INITIAL_LINKS` | Alto: 90 MB, 1.619.481 linee, data-heavy, privacy/bundle | Generated / data-heavy |
| `scripts/inspect_echo_state.js` | Diagnostico echo state metadata-only | `EchoStateBuilder`, `fs`, `path` | Input JSONL eventi; output JSON metadata | Basso/medio: legge file completo | Implemented |

## 5. Stato Memoria Orbitale

Principio chiave: **memoria != contesto**. La memoria e **potenziale di contesto**, cioe una riserva persistente di tracce che possono diventare contesto solo dopo gating, scoring e promozione.

Stato attuale:

| Area | Presente | Descrizione | Manca / rischio |
|---|---|---|---|
| Memoria persistente | Si | JSON storage locale per memorie e link | Persistenza file intero, rischio performance/corruzione |
| Recall | Si | Scoring testo + activation + echo + link boost | Mancano test automatici robusti e metriche di qualita |
| Gate latente | Si | `analyzePresentContext` decide se recall serve | Regole hardcoded nello script chat |
| ConsciousContextGate | Parziale | `promoteToConsciousContext` seleziona memorie candidate per prompt | Non e modulo core separato; integrazione lifecycle non ancora end-to-end |
| Echo events | Si | JSONL append-only con echoed/promoted/suppressed/summary | Pochi eventi rispetto a dataset; schema minimale |
| Echo state | Si | `EchoStateBuilder` calcola echoCount, promotedCount, suppressedCount, energy, dormant | Non persistito come indice separato |
| Suppression | Si | Topic suppression in chat + evento suppressed | Manca policy centrale riusabile per tutti i client |
| Link semantici | Si | Link types e rinforzo/creazione in chat/core | Dedup e qualita link da consolidare |
| Lifecycle | Si, recente | `MemoryLifecycle.js` calcola stati e transizioni | Non ancora integrato in `KebloMemory`, EchoState inspect o cockpit |
| Decay/compression | Si | `decayAll`, `ColdMemoryCompressor` | Serve separare decay da cancellazione/prune link in policy chiara |

Cosa manca per consolidare:

- Modulo gate consapevole separato da `chat_orbitale_ollama.js`.
- Integrazione lifecycle in output recall/echo/cockpit.
- Test automatici per recall, suppression, echo, lifecycle e import.
- Storage indicizzato o database leggero per evitare lettura/scrittura JSON enormi.
- Policy esplicita: nessuna cancellazione memoria reale senza comando amministrativo.

## 6. Stato UI / Cockpit

Struttura frontend:

| Parte | File | Ruolo |
|---|---|---|
| Entry React | `src/main.tsx` | Mount app |
| Shell dashboard | `src/App.tsx` | Stato memorie/link, tabs, localStorage, azioni |
| Arena orbitale | `src/components/OrbitalArena.tsx` | SVG interattivo, pan/zoom, orbite, link, overlay echo |
| Rightbar/investigator | `src/components/CognitiveInvestigator.tsx` | Analisi nodo/sistema, domain hint, tag, metriche |
| Chat UI | `src/components/JaceChat.tsx` | Chat cockpit verso API locale |
| Tipi | `src/types.ts` | Memory, Link, EchoState |
| Dati iniziali | `src/initialData.ts` | Export statico enorme |
| Smoke test | `scripts/smoke-frontend-structure.mjs` | Verifica struttura base frontend |

Elementi presenti:

- Canvas/SVG orbital arena con due layout: `orbital` e `constellation`.
- Overlay echo: dormant/warm/promoted/decayed/inhibited.
- Rightbar con tab chat/investigator/data.
- Cognitive investigator con metriche aggregate, tag filter, domain hint basato su tag.
- Smoke test strutturale per file e import principali.

Criticita principali:

- `initialData.ts` e enorme: circa 90 MB, 1.619.481 linee, circa 40.706 memorie e 30.692 link incorporati nel bundle.
- `dist/assets/index-*.js` e circa 76 MB: bundle troppo grande per uso normale.
- `node_modules` locale circa 215 MB: ignorato, ma aumenta peso workspace.
- Build/lint potenzialmente lenti per TypeScript che deve parseare `initialData.ts`.
- `App.tsx` contiene funzioni UI che eliminano nodi/link dal localStorage (`handleDeleteMemory`, `handlePurgeDecayed`); non toccano runtime data server, ma sono pericolose se confuse con gestione reale.
- `OrbitalArena.tsx` renderizza potenzialmente decine di migliaia di elementi SVG: rischio performance alto.
- `CognitiveInvestigator.tsx` contiene una duplicazione visibile di `DomainIcon`; da verificare.
- `OrbitalArena.tsx` contiene una duplicazione della condizione `highlightedTag`; da verificare.

## 7. Stato Automation Engine

`automation/fix_queue.json`:

- Forma: oggetto con `supportedStates`, `allowedTransitions`, `fixes`.
- Stati supportati: `pending`, `prepared`, `running`, `verified`, `completed`, `failed`.
- Conteggio rilevato: 22 fix totali, 18 completed, 4 failed.
- Rischio: e sia configurazione sia stato operativo. Va protetto da modifiche accidentali.

State machine:

| Stato | Transizioni rilevate |
|---|---|
| `pending` | `prepared`, `failed` |
| `prepared` | `running`, `failed` |
| `running` | `verified`, `failed` |
| `verified` | `completed`, `failed` |
| `completed` | nessuna |
| `failed` | nessuna nella queue attuale |

Batch mode e prompt export:

- `codex_runner.js` genera batch plan, next fix, prompt, codex-ready prompt, manifest, scope check, verification, final report.
- `automation/logs/` contiene batch e fix artifacts fino a `fix-022`.
- I log sono utili per tracciabilita, ma possono crescere rapidamente.

Limiti attuali:

- `codex_runner.js` e molto grande (3025 linee) e contiene molte responsabilita.
- La distinzione tra artifact da versionare e artifact runtime non e ancora rigida.
- Alcune funzioni eseguono comandi e modificano queue: serve disciplina operativa.
- La verifica e spesso command-based, non test suite strutturata.

Cosa e pronto:

- Coda e state machine.
- Export prompt.
- Scope/diff/check/report.
- Batch planning.

Cosa non e pronto:

- Separazione pulita tra orchestrazione, validazione queue, rendering report, command execution.
- Test automatici dell'automazione.
- Politica univoca su quali log committare.

## 8. Stato Planner

`automation/planner.js` supporta:

- `--scan`: legge repository filtrando directory ignorate e genera report.
- `--suggest`: genera fix suggeriti da euristiche su file grandi/TODO/modularizzazione.
- `--import`: importa suggerimenti in `fix_queue.json`.
- `--plan`: esegue scan + suggest + import e produce planner-run.

Limiti euristici:

- Misura dimensioni, TODO, package, script e aree modularizzazione.
- Non comprende davvero priorita di prodotto o rischio privacy oltre alle regole codificate.
- I suggerimenti sono meccanici: utili per backlog tecnico, non equivalenti a roadmap strategica.
- L'import modifica la queue: deve essere trattato come operazione controllata.

Differenza chiave:

- Suggerimento meccanico: "file grande, modularizzare".
- Suggerimento strategico: "prima separare dati privati e storage, poi ottimizzare UI".

Il planner e utile come radar, non come decisore autonomo.

## 9. Dati, Runtime, Backup, Scarti

| Categoria | Dove | Azione consigliata | Rischio privacy | Rischio repo sporco |
|---|---|---|---|---|
| Dati reali memoria | `orbitale_chat_data/`, `keblo_data/` | Tenere localmente, ignorare, backup cifrato fuori repo | Alto | Alto |
| Export OpenAI | `imports/` | Archiviare fuori repo, cancellare dal workspace quando non serve | Alto | Alto |
| Backup import | `backups/openai_import/` | Archiviare fuori repo | Alto | Alto |
| Backup dev diff | `backups/dev_diffs/` | Tenere solo se utile, altrimenti archiviare | Medio | Medio |
| Backup chat | `backup_orbitale_chat_data/` | Archiviare fuori repo | Alto | Alto |
| Runtime eventi | `orbitale_chat_data/*.jsonl` | Tenere runtime, esportare solo metadata se necessario | Medio/alto | Medio |
| File temporanei | `tmp_orbitale_*` | Pulire periodicamente | Basso/medio | Medio |
| Build frontend | `apps/orbitale-cockpilot/dist/` | Eliminabile, rigenerabile | Basso | Alto |
| Dipendenze | `apps/orbitale-cockpilot/node_modules/` | Eliminabile, reinstallabile | Basso | Alto |
| Planner output | `automation/planner-output/` | Ignorare, rigenerare | Basso | Medio |
| Automation logs | `automation/logs/` | Conservare selettivamente | Medio | Medio |
| Zip | `docs/memoria-orbitale.zip`, `apps/orbitale-cockpilot/memoria-orbitale.zip` | Ignorare/archiviare | Da verificare | Medio |
| Log runtime | `orbitale_output.log` | Ignorare/pulire | Medio | Medio |
| Visual HTML generato | `orbitale_visual.html` | Ignorare/rigenerare | Da verificare | Medio |

Metriche non sensibili rilevate:

| Area | Conteggio / dimensione |
|---|---:|
| Memorie runtime principali | 40.712 |
| Link runtime principali | 30.694 |
| Eventi echo JSONL | 36 |
| Import conversazioni OpenAI | 327 conversazioni in 4 shard |
| `initialData.ts` | circa 90 MB / 1.619.481 linee |
| `apps/orbitale-cockpilot/dist` | circa 73 MB |
| `apps/orbitale-cockpilot/node_modules` | circa 215 MB |

## 10. Git Hygiene

Dovrebbe stare in Git:

- `core/*.js`
- `chat_orbitale_ollama.js`
- `automation/codex_runner.js`
- `automation/planner.js`
- `automation/prompts/base_codex_prompt.md`
- `scripts/*.js`
- `apps/orbitale-cockpilot/src` esclusi dataset generati pesanti
- config frontend (`package.json`, `tsconfig.json`, `vite.config.ts`, `.env.example`)
- documentazione `.md`
- test/smoke script

Non dovrebbe stare in Git:

- `orbitale_chat_data/`
- `keblo_data/`
- `imports/`
- `backups/`
- `backup_orbitale_chat_data/`
- `tmp_orbitale_*`
- `node_modules/`
- `dist/`
- `*.log`
- `*.pyc`, `__pycache__/`
- zip e export privati
- dataset frontend generati con contenuti personali

Da mettere/confermare in `.gitignore`:

- Gia presenti: runtime data, imports, backups, dist, node_modules, planner-output, log, zip.
- Da verificare: `backup_orbitale_chat_data/` e `openai_export_backup/` non risultano esplicitamente nominati; `backups/` copre solo `backups`, non `backup_orbitale_chat_data`.
- Da valutare: ignorare `apps/orbitale-cockpilot/src/initialData.ts` dopo aver introdotto un loader dati alternativo.

Pericoloso committare:

- Qualsiasi file in `orbitale_chat_data`, `keblo_data`, `imports`, backup.
- `initialData.ts` nello stato attuale, perche replica dati memoria nel frontend.
- Bundle `dist` se include dati privati incorporati.
- Log runtime contenenti prompt, path, nomi o conversazioni.
- `.env` o `.env.local`.

Nota: `apps/orbitale-cockpilot/package-lock.json` e ignorato dalla root `.gitignore`. Per build riproducibili, conviene decidere esplicitamente se tracciare un lockfile depurato oppure usare un package manager lock alternativo. Stato attuale: da verificare.

## 11. Rischi Tecnici Principali

### Alto

| Rischio | Impatto |
|---|---|
| Dati personali mescolati a workspace e frontend (`initialData.ts`) | Privacy, bundle enorme, commit accidentali |
| Storage JSON monolitico da circa 95 MB | Performance, corruzione, lentezza import/recall |
| `initialData.ts` tracciato come sorgente | Build lenta, diff ingestibili, rischio storico Git |
| `codex_runner.js` monolitico | Modifiche rischiose, difficile testare |
| UI che visualizza/renderizza decine di migliaia di nodi SVG | Performance e UX instabili |
| Chat script con gate, storage, prompt e modello nello stesso file | Accoppiamento e regressioni |

### Medio

| Rischio | Impatto |
|---|---|
| Test automatici limitati | Regressioni non intercettate |
| Planner euristico puo importare fix meccanici | Backlog rumoroso o priorita errate |
| Echo/lifecycle non integrati end-to-end | Stato cognitivo calcolabile ma non usato ovunque |
| Backup duplicati nel workspace | Confusione e rischio commit |
| Lockfile frontend ignorato | Riproducibilita install/build da verificare |

### Basso

| Rischio | Impatto |
|---|---|
| Cache Python e log locali | Rumore workspace |
| Documenti zip duplicati | Peso e ambiguita |
| Script legacy Python/top-level | Confusione se non classificati |

## 12. Debito Tecnico

Debiti principali:

1. File enormi: `initialData.ts`, `francesco_memories.json`, bundle dist.
2. Dati mescolati al frontend: il cockpit incorpora dataset reale come TypeScript.
3. Accoppiamento alto: `Keblomemory.js`, `chat_orbitale_ollama.js`, `codex_runner.js`.
4. Assenza di test unitari/integrazione sistematici per core recall/gate/echo/lifecycle.
5. Runtime data e memoria reale dentro workspace.
6. Automazione molto grande e con molte modalita operative nello stesso file.
7. UI con azioni distruttive locali e rendering non virtualizzato.
8. Import OpenAI e backup nello stesso root del codice.
9. Echo/lifecycle presenti ma non ancora normalizzati come contract tra core, chat e UI.
10. Legacy/prototipi Python e JS non classificati formalmente.

## 13. Roadmap Consigliata

Massimo 10 passi ordinati:

1. **Subito: protezione dati/Git.** Confermare `.gitignore`, rimuovere dal tracciamento futuro ogni dataset generato o privato, in particolare valutare `initialData.ts`.
2. **Subito: separare cockpit data loader.** Sostituire `initialData.ts` enorme con snapshot ridotto, API locale o file esterno ignorato.
3. **Subito: introdurre test minimi core.** Test per `MemoryEventLogger`, `EchoStateBuilder`, `MemoryLifecycle`, recall base e suppression.
4. **Subito: definire contract memoria.** Schema stabile per `Memory`, `Link`, `EchoState`, `LifecycleState`.
5. **Poi: estrarre ConsciousContextGate.** Portare gate/promotion fuori da `chat_orbitale_ollama.js` in modulo core testabile.
6. **Poi: storage scalabile.** Valutare JSON shard, SQLite o indice append-only per evitare file monolitici.
7. **Poi: alleggerire automation.** Spezzare `codex_runner.js` in queue/state/artifact/check/report.
8. **Poi: UI performance.** Virtualizzazione/filtri/top-N e rendering progressivo per arena.
9. **Poi: policy backup.** Spostare import/export/backup fuori repo o in archivio cifrato.
10. **Non toccare ora:** refactor massivo del core o cancellazione legacy finche non esistono test e backup verificati.

## 14. Delta 0 Finale

Oggi esiste:

- Un core di memoria orbitale reale e operativo, ma ancora sperimentale.
- Una chat locale che usa gate, recall e promotion per trasformare memoria in contesto.
- Un sistema echo append-only con stato aggregabile.
- Una policy di reinforcement e un lifecycle calcolabile.
- Una dashboard React ricca, ma alimentata da dati enormi incorporati.
- Un motore di automazione fix abbastanza avanzato, con coda e artifact.
- Dati reali consistenti e import OpenAI gia trasformati in memoria.

Cosa e maturo:

- La direzione architetturale: memoria come potenziale, gate come promozione, echo come feedback.
- Alcuni moduli puri: logger eventi, echo state builder, lifecycle, link model.
- La disciplina dei fix controllati e artifact.

Cosa e sperimentale:

- Recall e scoring.
- Gate consapevole.
- Integrazione echo/lifecycle nel flusso completo.
- Cockpit con dataset reale.
- Automazione monolitica.
- Storage file-based su dataset grande.

Cosa serve per Delta 1:

- Separazione netta tra codice e dati.
- Test minimi e contratti stabili.
- Loader dati cockpit non incorporato nel bundle.
- Gate consapevole modulare e testabile.
- Storage piu robusto o almeno sharding/indici.
- Politica Git/privacy applicata prima di nuove feature.

Delta 0 conclusione: il progetto e gia un prototipo funzionante e ricco, ma la priorita non deve essere aggiungere complessita. La priorita e stabilizzare confini, dati, test e contratti, cosi Delta 1 possa crescere senza portarsi dietro rischi privacy e debito strutturale.
