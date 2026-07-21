# MEMORIA ORBITALE — EVOLUTION LOG

## 1. Scopo del documento

Questo file è il documento vivo e autorevole di orientamento dell'evoluzione di Memoria Orbitale. Svolge contemporaneamente il ruolo di roadmap evolutiva, registro cronologico, decision log e punto di passaggio tra Francesco, proprietario e ideatore del progetto, Aiden, custode della continuità concettuale e progettuale, e Codex, responsabile dell'analisi e dell'implementazione tecnica. Deve consentire a chi affronta un intervento futuro di capire cosa esiste, cosa è stato deciso, cosa è stato verificato e quale passo viene dopo.

Non sostituisce la documentazione tecnica dettagliata, i test, gli audit, Git o i contratti versionati. Li collega, ne indica il ruolo e conserva nel tempo il significato delle loro evidenze e delle decisioni che ne derivano.

## 2. Visione del progetto

Memoria Orbitale è la visione di una memoria dinamica per un assistente personale: un sistema capace di conservare le fonti originali, distinguere presente, passato, rilevanza e profondità, e ricostruire connessioni senza cancellarne la provenienza. La sua evoluzione può avvenire attraverso componenti specializzati, ciascuno introdotto con contratti e verifiche espliciti.

Questa è la **visione** complessiva, non la descrizione di funzionalità tutte già operative. La **progettazione** comprende anche livelli e organi ancora da definire o integrare. L'**implementazione reale** corrente è più circoscritta: persistenza JSON, memoria e recall sperimentali, dinamiche orbitali e alcuni moduli specializzati, con differenze ancora aperte tra modello operativo e modelli teorici. Ogni sezione di questo documento deve mantenere distinta la visione dalla progettazione e dal runtime verificato.

## 3. Principi invarianti

1. Nessun dato raw deve essere cancellato durante il consolidamento.
2. Ogni sintesi futura deve conservare provenance verificabile.
3. Tempo, attivazione, profondità e storage sono assi distinti.
4. Nessun nuovo modulo deve leggere direttamente contratti incompatibili.
5. Il JSON operativo rimane autorevole finché una migrazione non viene progettata e verificata.
6. Le operazioni distruttive richiedono backup, validazione e rollback.
7. I nuovi processi devono essere dry-run per default finché non dichiarati sicuri.
8. Il server Keblo non viene modificato durante lo sviluppo della versione DEV sul portatile.
9. Il merge nel server avverrà soltanto dopo completamento e test della versione portatile.
10. La cronologia non deve essere riscritta retroattivamente.

## 4. Ambienti e sorgenti di verità

- **DEV attiva:** versione sul portatile.
- **Server Keblo:** versione precedente, temporaneamente congelata.
- La DEV del portatile è la sorgente di verità per il lavoro corrente.
- Non è autorizzato alcun merge o sincronizzazione automatica verso il server.
- Il futuro merge richiederà audit del server, confronto delle differenze, backup, prova su copia e attivazione progressiva.

I percorsi filesystem dei due ambienti non sono registrati qui perché non fanno parte del contratto evolutivo e, per il server, non sono stati verificati nel percorso corrente.

## 5. Stato reale dell'architettura

Il percorso runtime verificato è:

```text
chat_orbitale_ollama.js
  → KebloMemory
  → JsonMemoryStorage
  → JSON object map per utente
```

Il runtime operativo è prevalentemente flat. La famiglia teorica/legacy nested è separata e non coincide con lo shape creato dalla chat corrente. `loadMemories()` restituisce un array di plain object ottenuto dai valori della object map JSON; non reidrata istanze di classe. Il JSONL è usato per gli eventi append-only Echo, non come storage principale di memorie o link. Moduli teorici e prototipi presenti nel repository non costituiscono, per la sola loro esistenza, runtime integrato.

Il contratto, i campi, le incompatibilità e le decisioni rinviate sono descritti in [ORBITAL_MEMORY_CONTRACT_V1.md](contracts/ORBITAL_MEMORY_CONTRACT_V1.md). Questo log non ne duplica la specifica.

## 6. Roadmap evolutiva

La roadmap è estensibile: le fasi descrivono l'ordine di maturazione attualmente previsto, ma possono ricevere nuovi interventi senza cancellare o rinumerare quelli storici.

### Fase A — Fondamenta e sicurezza

- Contratto dati.
- Normalizzazione.
- Capability dello storage.
- Commit atomico.
- Lock, backup e rollback.

### Fase B — Consolidamento read-only

- Candidate selector.
- Processing state.
- Clustering.
- Maturità.
- Provenance.

### Fase C — Ippocampo

- Sintesi controllata.
- Transazioni.
- RecallRouter.
- Daemon dry-run.
- Recovery e idempotenza.
- Eventuale vector adapter.

### Fase D — Integrazione Keblo

- Audit della versione server.
- Confronto delle differenze.
- Piano di merge.
- Test su copia.
- Attivazione progressiva.

### Fase E — Evoluzioni successive (esplorativa)

Questa fase raccoglie aree ancora da progettare. Non rappresenta specifiche approvate né funzionalità operative:

- Affinità.
- Temporalità avanzata.
- Consolidamento emotivo.
- MCO/meta-cognizione.
- Altre evoluzioni future non ancora definite.

## 7. Dashboard degli interventi

Gli ID sono permanenti. Nuovi interventi devono ricevere nuovi ID in coda; quelli esistenti non vanno rinumerati o cancellati.

| ID | Intervento | Fase | Stato | Ultimo aggiornamento | Evidenza |
|---|---|---|---|---|---|
| FIX 1 | Audit contract fixture | A | COMPLETED | 2026-07-12 | Contratto V1, 6 fixture sintetiche, 7/7 test superati |
| FIX 2 | Memory contract normalizer | A | COMPLETED | 2026-07-12 | Normalizzatore read-only; 14/14 test dedicati e 21/21 combinati superati |
| FIX 3 | Storage capability contract | A | COMPLETED | 2026-07-12 | Contratto V1; 19/19 test dedicati e 40/40 combinati superati |
| FIX 4 | Atomic JSON commit | A | COMPLETED | 2026-07-12 | Atomic replace singolo file; 13/13 test dedicati e 53/53 combinati superati |
| FIX 5 | Read-only consolidation plan | B | COMPLETED | 2026-07-12 | Piano dry-run deterministico e immutabile; 19/19 test dedicati e 72/72 combinati superati |
| FIX 6 | Processing state contract | B | COMPLETED | 2026-07-12 | State machine V1 revisionata; 17/17 test dedicati e 90/90 combinati superati |
| FIX 7 | ClusterEngine adapter | B | COMPLETED | 2026-07-12 | Adapter read-only e math pure; 21/21 test dedicati e 111/111 combinati superati |
| FIX 8 | Cluster persistence | B | COMPLETED | 2026-07-12 | Cluster CRUD e capability verificati; suite FIX 1–8 124/124 superata |
| FIX 9 | SynthesisEngine contract | C | COMPLETED | 2026-07-12 | Provider esplicito e JSON/provenance rigorosi; 29/29 dedicati e 153/153 combinati superati |
| FIX 10 | Transactional consolidation commit | C | COMPLETED | 2026-07-12 | Lock per utente, super-memory e source in singolo commit; 20/20 dedicati e 174/174 combinati superati |
| FIX 11 | RecallRouter read-only | C | COMPLETED | 2026-07-12 | Router isolato read-only; 26/26 dedicati e 200/200 combinati superati |
| FIX 12 | RecallRouter integration | C | COMPLETED | 2026-07-12 | Pipeline runtime unica, retrieval read-only e reinforcement finale; 27/27 dedicati e 227/227 combinati superati |
| FIX 13 | HippocampusDaemon single-process | C | COMPLETED | 2026-07-12 | Dry-run default, maturity/claim/commit orchestrati; 18/18 dedicati e 246/246 combinati superati |
| FIX 14 | Recovery/idempotency | C | COMPLETED | 2026-07-12 | Journal, recovery e stale-lock policy verificati; 37/37 dedicati e 265/265 combinati superati |
| FIX 15 | Vector index adapter | C | COMPLETED | 2026-07-12 | Adapter derivato/non autorevole; 20/20 dedicati e 285/285 combinati superati |

Stati ammessi per questa dashboard: `PLANNED`, `IN_PROGRESS`, `COMPLETED`, `BLOCKED`, `SUPERSEDED`, `DEFERRED`.

## 8. Decisioni architetturali

Gli ADR hanno ID stabili e non riutilizzabili.

### ADR-MO-001 — Sorgente di verità DEV

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Il lavoro corrente avviene sulla DEV del portatile, mentre il server Keblo contiene una versione precedente.
- **Decisione:** La DEV sul portatile è la sorgente di verità corrente; il server resta congelato.
- **Motivazione:** Evitare divergenze e modifiche premature all'ambiente server.
- **Conseguenze:** Nessun merge automatico; l'integrazione server richiederà il percorso controllato della Fase D.

### ADR-MO-002 — Contratti flat e nested distinti

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Il runtime chat crea il contratto flat, mentre vari moduli teorici consumano uno shape nested incompatibile.
- **Decisione:** Flat e nested restano contratti distinti fino all'introduzione di un normalizzatore verificato.
- **Motivazione:** Evitare conversioni implicite, perdita di campi e precedenze arbitrarie.
- **Conseguenze:** I nuovi moduli non possono trattare i due shape come alias; il FIX 2 dovrà produrre una vista non mutante.

### ADR-MO-003 — Separazione degli assi semantici

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Nomi e valori esistenti possono indurre a confondere dinamica orbitale, profondità logica e collocazione fisica.
- **Decisione:** `orbitalLevel`, `memoryDepth` e il futuro `storageTier` sono assi differenti.
- **Motivazione:** Impedire migrazioni o policy basate su equivalenze non verificate.
- **Conseguenze:** Ogni mapping futuro richiederà un contratto e test dedicati.

### ADR-MO-004 — Conservazione dei raw

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Il consolidamento potrebbe produrre sintesi e forme derivate.
- **Decisione:** I raw non saranno eliminati o compressi distruttivamente da Ippocampo.
- **Motivazione:** Preservare fonti originali, reversibilità e provenance.
- **Conseguenze:** Sintesi e consolidamenti dovranno essere additivi e collegati alle fonti.

### ADR-MO-005 — Avvio read-only di Ippocampo

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Persistenza, transazioni, recovery e idempotenza non sono ancora sufficientemente definite.
- **Decisione:** Ippocampo verrà costruito inizialmente in modalità read-only/dry-run.
- **Motivazione:** Rendere osservabili selezione e pianificazione prima di autorizzare scritture.
- **Conseguenze:** Le capacità mutanti richiederanno fix successivi e verifiche esplicite.

### ADR-MO-006 — Ruolo non autorevole del vector index

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Un eventuale Qdrant/vector index può accelerare il recupero ma introduce uno stato derivato.
- **Decisione:** Qdrant o un altro vector index non sarà inizialmente una fonte autorevole.
- **Motivazione:** Mantenere il JSON operativo come fonte verificabile fino a una migrazione progettata.
- **Conseguenze:** L'indice dovrà essere ricostruibile e non potrà sostituire i dati sorgente.

### ADR-MO-007 — Ambito dell'Evolution Log

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Ippocampo è una fase del progetto, non il suo confine definitivo.
- **Decisione:** L'Evolution Log riguarda l'intero progetto Memoria Orbitale, non soltanto Ippocampo.
- **Motivazione:** Conservare continuità attraverso organi, livelli e architetture future.
- **Conseguenze:** Roadmap, dashboard, ADR e cronologia accoglieranno evoluzioni successive mantenendo la storia esistente.

### ADR-MO-008 — Precedenza flat campo per campo nelle memorie hybrid

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Una memoria può contenere contemporaneamente campi del contratto flat operativo e del contratto nested basato su `orbital`.
- **Decisione:** Nella vista canonica il campo flat, quando presente, prevale sul corrispondente campo nested; il nested viene letto soltanto se il campo flat è assente. La regola si applica campo per campo e conserva come valori espliciti anche `0`, `null`, `false`, stringa vuota e `undefined`.
- **Motivazione:** Il contratto flat è il contratto operativo corrente e la presenza strutturale non può essere confusa con il valore truthy del campo.
- **Conseguenze:** Le memorie hybrid restano riconoscibili tramite `sourceContract: "hybrid"`; la normalizzazione non sincronizza, migra o modifica i due shape sorgente.

### ADR-MO-009 — Capacità storage esplicite e conservative

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** I componenti presenti e futuri richiedono capacità memory, link, cluster e transazionali diverse, mentre la sola presenza di un metodo non prova completezza o sicurezza semantica.
- **Decisione:** Le capacità dello storage devono essere esplicite e conservative; la presenza di un metodo non prova supporto semantico. Struttura callable, dichiarazione backend e verifica comportamentale restano evidenze distinte.
- **Motivazione:** Impedire che stub, riscritture complete o firme future vengano interpretati come cluster persistence, atomic commit, lock, snapshot o rollback verificati.
- **Conseguenze:** I backend legacy senza dichiarazione restano `unknown` quando il metodo esiste; `hasStorageCapability()` restituisce `true` soltanto per capacità strutturalmente presenti, dichiarate `supported` e marcate come verificate.

### ADR-MO-010 — Sostituzione atomica per singolo file

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Le scritture dirette sul file JSON finale potevano produrre troncamenti o documenti parziali in caso di errore durante la riscrittura.
- **Decisione:** `JsonMemoryStorage` usa temp nella stessa directory, fsync, validazione, backup `.bak`, rename atomico e fsync directory per ogni singolo file memoria, link o cluster.
- **Motivazione:** Proteggere validità e sostituzione del documento finale mantenendo invariati formato, object map e API pubbliche.
- **Conseguenze:** La capacità `commit.atomic` riguarda esclusivamente il singolo file e i write path verificati; non equivale a lock, prevenzione lost update, transazione multi-file, snapshot o rollback.

### ADR-MO-011 — Piano di consolidamento read-only e senza limite implicito

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** La selezione per Ippocampo deve diventare osservabile prima di introdurre processing state, clustering, sintesi o qualsiasi scrittura.
- **Decisione:** Il piano V1 è esclusivamente dry-run, deterministico e profondamente immutabile; le memorie legacy non classificate sono rinviate per default e richiedono opt-in esplicito; non esiste un limite predefinito di cinque memorie.
- **Motivazione:** Separare una classificazione conservativa e riproducibile dalle future decisioni di state machine e dai limiti di batching del modello.
- **Conseguenze:** Il piano non autorizza commit, non contiene testo raw e può includere 12, 100 o più candidate; processing state, cluster e prompt batching restano responsabilità di fix successivi.

### ADR-MO-012 — Processing esplicito, versionato e revisionato

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Il ciclo futuro di consolidamento richiede stati e tentativi verificabili senza reinterpretare automaticamente le memorie legacy.
- **Decisione:** Processing è una state machine esplicita, versionata e revisionata; nessuna memoria legacy viene considerata `raw` implicitamente. `consolidated` è terminale nel V1.
- **Motivazione:** Rendere deterministiche candidature, tentativi, fallimenti, retry e release, preparando precondizioni verificabili per un futuro commit.
- **Conseguenze:** Ogni transizione incrementa `revision`, conserva o pulisce `attempt_id` secondo contratto e dichiara stato/revision/timestamp attesi. L'optimistic concurrency è un requisito futuro e non è implementata dal FIX 6.

### ADR-MO-013 — Clustering operativo read-only separato dal legacy

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Il `ClusterEngine` storico dipende da storage, metodi di classe e scritture, mentre il percorso di consolidamento richiede prima un risultato osservabile e riproducibile.
- **Decisione:** Il clustering operativo usa adapter read-only su plain object, embedding provider esplicito e funzioni matematiche pure; il `ClusterEngine` legacy resta isolato e invariato.
- **Motivazione:** Separare normalizzazione, provider, matematica e persistenza, impedendo mutazioni o assunzioni runtime durante la formazione dei cluster candidati.
- **Conseguenze:** Il V1 usa complete-link greedy deterministico con confronto diretto `similarity >= threshold`, minimo 3 e nessun massimo predefinito. Persistenza, split/merge avanzati, maturità e sintesi restano futuri.

### ADR-MO-014 — Cluster persistiti immutabili e idempotenza single-process

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** I cluster candidati FIX 7 richiedono persistenza senza mutare le memorie sorgenti e senza confondere retry equivalenti o versioni embedding differenti.
- **Decisione:** I cluster persistiti sono record immutabili, atomici, con provenance e idempotency key; la garanzia idempotente resta single-process finché non esiste un lock.
- **Motivazione:** Rendere verificabili identità, origine, embedding e round-trip mantenendo esplicito il confine delle garanzie concorrenti.
- **Conseguenze:** ID, key e fingerprint vengono ricalcolati; replay sequenziali equivalenti non duplicano né riscrivono; conflitti non fanno overwrite. Lock, prevenzione lost update e transazioni memoria + cluster restano futuri.

### ADR-MO-015 — Sintesi isolata, versionata e con provenance strutturale

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** La sintesi richiede testo sorgente e un modello, ma non deve incorporare trasporto, storage o commit né produrre output non verificabili.
- **Decisione:** La sintesi usa provider esplicito, prompt versionato, output JSON rigoroso e provenance per ogni elemento; il motore non accede allo storage e non effettua commit.
- **Motivazione:** Isolare il confine modello, rendere deterministici request e result e impedire che source mancanti, output incompleti o attribution inesistente entrino nel percorso futuro di consolidamento.
- **Conseguenze:** Qwen/Ollama richiederà un adapter di trasporto separato; il FIX 10 dovrà gestire il commit transazionale. La verifica di schema, copertura e ID è strutturale e non costituisce prova fattuale perfetta del testo generato.

### ADR-MO-016 — Commit di consolidamento atomico nel singolo file memoria

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Super-memory e source transition devono diventare visibili insieme, senza lost update tra writer cooperanti o cancellazione dei raw.
- **Decisione:** Super-memory e aggiornamento source sono committati nello stesso file memoria sotto lock per utente, con optimistic precondition, replay idempotente e rollback circoscritto.
- **Motivazione:** Rendere indivisibile il confine persistito del consolidamento V1 e verificabile ogni transizione prima e dopo la sostituzione atomica.
- **Conseguenze:** Le source usate diventano `consolidated`, le rejected diventano `failed` e i raw restano integralmente conservati. Snapshot/rollback storage generale, stale-lock recovery e crash recovery restano non implementati.

### ADR-MO-017 — Recall routing read-only e deep esplicito

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Il recall legacy combina mutazioni, scoring e accesso ai tier senza un confine read-only verificabile; l'integrazione runtime richiede prima un contratto isolato.
- **Decisione:** RecallRouter è read-only, core+warm per default, deep soltanto esplicito, ranking senza boost arbitrari e reinforcement rinviato alla selezione finale.
- **Motivazione:** Rendere visibili e deterministiche route, deduplica, provenance di tier e soppressione delle source coperte, impedendo accessi deep o mutazioni implicite.
- **Conseguenze:** Non esiste alcun limite implicito di cinque; il chiamante fornisce il budget finale. L'adattamento dei retriever legacy e l'eventuale reinforcement una sola volta restano al FIX 12.

### ADR-MO-018 — Pipeline runtime unica con reinforcement finale

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Il router isolato deve usare lo scoring legacy senza ereditarne mutazioni implicite o consentire che Echo/link attraversino i confini tier.
- **Decisione:** Il runtime usa un'unica pipeline RecallRouter; i retriever legacy sono read-only e il reinforcement avviene una volta dopo la selezione finale.
- **Motivazione:** Separare retrieval e mutazione, rendere deep esplicito e impedire doppio incremento o reinforcement di risultati soppressi.
- **Conseguenze:** `recall()` legacy resta retrocompatibile; chat, contesto Keblo e bridge registrano il router. Mapping e comandi deep sono chiusi e versionati; daemon e ulteriori orchestrazioni restano futuri.

### ADR-MO-019 — Orchestratore single-process con commit doppiamente autorizzato

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** I componenti di selezione, clustering, sintesi e commit sono verificati separatamente ma richiedono un ordine operativo che non introduca auto-run, commit implicito o lock durante il modello.
- **Decisione:** HippocampusDaemon è single-process, dry-run per default, commit con doppia autorizzazione, maturity gate esplicito e nessuna chiamata modello sotto lock.
- **Motivazione:** Rendere controllabile l'intera pipeline mantenendo separati pianificazione, claim, inferenza e persistenza.
- **Conseguenze:** Commit legacy è vietato; content hash viene riverificato prima del commit. Journal, recovery crash e stale-lock recovery restano al FIX 14.

### ADR-MO-020 — Journal persistente e recovery storage-first

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Un crash può interrompere la pipeline tra claim, modello, commit memoria e acknowledgement journal, lasciando stato persistito valido ma cronologia incompleta.
- **Decisione:** Ogni commit Ippocampo è journaled; recovery è dry-run per default, riconcilia lo storage prima di mutare e non ricostruisce output modello non persistiti.
- **Motivazione:** Rendere osservabili e recuperabili le crash window senza inferire sintesi, cancellare record o duplicare super-memory.
- **Conseguenze:** Stale lock è recuperabile solo con metadata validi, età, host locale, PID morto e doppia conferma. Stati misti, non attribuibili o semanticamente duplicati restano bloccati.

### ADR-MO-021 — Vector index derivato con reidratazione obbligatoria

- **Data:** 2026-07-12
- **Stato:** Accettata
- **Contesto:** Un indice vettoriale può accelerare ricerca e clustering, ma non deve duplicare autorità o introdurre testo privato e stato non verificabile.
- **Decisione:** Il vector index è derivato e non autorevole; point ID e payload sono deterministici/versionati, mentre ogni risultato deve essere reidratato e verificato contro il JSON.
- **Motivazione:** Rendere l'indice eliminabile e ricostruibile, con stale point scartabili e nessun effetto sul dato canonico in caso di failure provider.
- **Conseguenze:** FIX 15 non crea client/collection Qdrant, embedding o retriever runtime. L'attivazione richiede un gate separato e controllato.

## 9. Cronologia append-only

**Questa sezione è append-only.** Le voci pubblicate non devono essere eliminate, riscritte retroattivamente o riordinate per nascondere l'ordine degli eventi. Correzioni, rollback e nuove evidenze vanno aggiunti come nuove voci datate.

### 2026-06-26 — Audit pre-Ippocampo

L'audit read-only ha rilevato un runtime flat operativo e un'architettura nested separata e non integrata end-to-end. Ha evidenziato rischi di persistenza e la necessità di congelare un contratto canonico osservato prima di costruire il consolidamento. L'audit non ha modificato runtime o dati.

### 2026-07-12 — FIX 1 — Contratto dati V1

**Stato:** IN_PROGRESS

File creati:

- `docs/contracts/ORBITAL_MEMORY_CONTRACT_V1.md`;
- `test/contracts/memory-contract-fixtures.test.js`;
- sei fixture sintetiche in `test/fixtures/memory-contract/`.

Risultati verificati:

- 7 test eseguiti, 7 pass, 0 fail;
- fixture composte esclusivamente da dati sintetici;
- nessuna modifica al runtime;
- nessuna modifica ai dati reali.

Scoperte da preservare:

- lo storage principale è una JSON object map;
- `loadMemories()` restituisce un array di plain object;
- i valori `memoryDepth` osservati sono `temporary`, `normal`, `deep`, `historical`;
- `core` è accettato o generabile dal runtime, ma non è stato osservato nei dati DEV esaminati;
- i timestamp del runtime flat sono prevalentemente epoch in millisecondi;
- i contratti flat e nested sono congelati come contratti distinti.

Il controllo globale `git diff --check` risultava influenzato da whitespace preesistente in `chat_orbitale_ollama.js`, file non modificato dal FIX 1. Questa evidenza va mantenuta distinta dal risultato del fix.

### 2026-07-12 — FIX 2 — Memory contract normalizer read-only

**Stato:** COMPLETED

Il FIX 2 è transitato da `PLANNED` a `IN_PROGRESS` durante implementazione e verifica ed è stato marcato `COMPLETED` soltanto dopo il superamento di tutti i controlli richiesti.

File creati:

- `core/MemoryContractNormalizer.js`;
- `test/contracts/memory-contract-normalizer.test.js`.

Risultati verificati:

- `node --check` superato per modulo e test;
- 7/7 test delle fixture del FIX 1 superati;
- 14/14 test dedicati al normalizzatore superati;
- 21/21 test combinati superati;
- nessuna fixture esistente modificata e nessuna fixture hybrid aggiunta;
- nessun import di storage, `MemoryNode`, Qwen, Ollama o servizi esterni;
- nessuna modifica al runtime, ai dati reali o al server.

Decisioni e comportamento congelati:

- precedenza flat campo per campo nelle memorie hybrid, formalizzata in ADR-MO-008;
- rilevamento strutturale dei contratti `flat`, `nested`, `hybrid` e `unknown`;
- valori falsy espliciti preservati e distinti dai campi assenti;
- timestamp conservati senza conversione o rigenerazione;
- campi futuri letti soltanto se presenti, senza inferenze;
- campi sconosciuti preservati in una copia plain e separata `sourceSnapshot`;
- input non mutato e nessun riferimento mutabile condiviso con l'output.

### 2026-07-12 — FIX 3 — Storage capability contract

**Stato:** COMPLETED

Il FIX 3 è transitato da `PLANNED` a `IN_PROGRESS` durante analisi, implementazione e verifica ed è stato marcato `COMPLETED` soltanto dopo il superamento dei controlli richiesti.

File creati:

- `core/StorageCapabilityContract.js`;
- `docs/contracts/STORAGE_CAPABILITY_CONTRACT_V1.md`;
- `test/storage/storage-capability-contract.test.js`.

Risultati verificati:

- `node --check` superato per modulo e test;
- 7/7 test delle fixture FIX 1 superati;
- 14/14 test del normalizzatore FIX 2 superati;
- 19/19 test dedicati al capability contract superati;
- 40/40 test combinati superati;
- round-trip memory singola, batch e link verificati esclusivamente in directory temporanee sotto `os.tmpdir()`;
- `loadClusters()` verificato come stub vuoto non persistente;
- nessun accesso ai dati reali e nessuna modifica al runtime o al server.

Matrice sintetica di `JsonMemoryStorage`:

- memory read/write singola e batch: metodi strutturalmente presenti e round-trip verificati, ma stato contrattuale `unknown` perché il backend legacy non dichiara capacità;
- link read/write singola e batch: strutturalmente presenti e verificati, ma stato contrattuale `unknown`; `link.deleteOne` non supportato;
- `cluster.readAll`: metodo presente ma stub non persistente, supporto semantico non verificato; restante cluster CRUD non supportato;
- snapshot, atomic commit, lock e rollback: non supportati;
- i salvataggi JSON riscrivono direttamente il file finale e non provano atomicità.

Decisione stabile:

- capacità strutturale, dichiarata e verificata sono separate secondo ADR-MO-009;
- la dichiarazione canonica futura è la proprietà dati versionata `storage.capabilities`;
- nessuna capacità `partial` o `unknown` soddisfa `hasStorageCapability()` o le asserzioni dei componenti futuri.

### 2026-07-12 — FIX 4 — Atomic JSON commit

**Stato:** COMPLETED

Il FIX 4 è transitato da `PLANNED` a `IN_PROGRESS` durante implementazione e verifica ed è stato marcato `COMPLETED` soltanto dopo il superamento di tutti i controlli richiesti.

File creati:

- `core/AtomicJsonCommit.js`;
- `docs/contracts/ATOMIC_JSON_COMMIT_V1.md`;
- `test/storage/json-atomic-commit.test.js`.

File modificati:

- `core/JsonMemoryStorage.js`;
- `core/StorageCapabilityContract.js`, limitatamente alla mappatura strutturale incompatibile di `commit.atomic`;
- `docs/contracts/STORAGE_CAPABILITY_CONTRACT_V1.md`;
- `test/storage/storage-capability-contract.test.js`;
- `docs/MEMORIA_ORBITALE_EVOLUTION.md`.

Risultati verificati:

- `node --check` superato per moduli e test del FIX 4;
- 7/7 test FIX 1, 14/14 test FIX 2 e 19/19 test capability superati;
- 13/13 test atomic commit superati;
- 53/53 test combinati superati;
- failure injection prima del rename: target invariato e temp rimosso;
- 12 writer concorrenti: finale JSON completo appartenente a un writer e nessun temp residuo;
- tutti i test di scrittura eseguiti sotto `os.tmpdir()` e nessun dato reale modificato.

Comportamento introdotto:

- serializzazione canonica invariata, temp esclusivo, fsync, rilettura/validazione, backup atomico `.bak`, rename finale e fsync directory;
- `saveMemory`, `saveMemories`, `deleteMemory`, `saveLink` e `saveLinks` usano il percorso atomico mantenendo firme e valori restituiti;
- `JsonMemoryStorage` espone la dichiarazione capability own prevista dal FIX 3;
- memory e link verificati sono `supported`; `cluster.readAll` resta `partial`; cluster CRUD, snapshot, lock e rollback restano `unsupported`;
- `commit.atomic` è `supported` soltanto nel confine di sostituzione atomica del singolo file.

Rischi preservati:

- il rischio di JSON finale parziale o troncato è mitigato per gli errori gestiti dal protocollo;
- lost update tra writer concorrenti resta aperto;
- lock multi-processo, transazioni multi-file e rollback restano assenti;
- `.bak` non è snapshot versionato né rollback applicativo.

### 2026-07-12 — FIX 5 — Read-only consolidation plan

**Stato:** COMPLETED

Il FIX 5 è transitato da `PLANNED` a `IN_PROGRESS` durante implementazione e verifica ed è stato marcato `COMPLETED` soltanto dopo il superamento di tutti i controlli richiesti.

File creati:

- `core/consolidation/CandidateSelector.js`;
- `core/consolidation/ConsolidationPlan.js`;
- `docs/contracts/CONSOLIDATION_PLAN_V1.md`;
- `test/consolidation/read-only-consolidation-plan.test.js`.

File aggiornato:

- `docs/MEMORIA_ORBITALE_EVOLUTION.md`, esclusivamente per dashboard, ADR, cronologia e stato corrente.

Risultati verificati:

- `node --check` superato per i due moduli e il test del FIX 5;
- 7/7 test FIX 1, 14/14 test FIX 2, 19/19 test FIX 3 e 13/13 test FIX 4 superati separatamente;
- 19/19 test dedicati al piano di consolidamento superati;
- 72/72 test combinati superati;
- selezione senza limite verificata con 12 e 100 candidate sintetiche;
- nessun accesso allo storage o ai dati reali, nessun modello o cluster invocato;
- nessuna modifica a runtime, dati reali o server.

Comportamento congelato:

- ogni plain memory object passa attraverso `MemoryContractNormalizer`;
- decisioni `eligible`, `excluded` e `deferred` con reason code V1 stabili;
- legacy non classificato `deferred` per default e candidabile soltanto con `allowLegacyUnclassified: true` visibile nel piano;
- `maxCandidates: null` per default, senza top-five implicito; un limite esplicito rinvia e spiega ogni entry eccedente;
- deduplica conservativa per ID e SHA-256 del testo UTF-8 esatto, senza testo nel risultato;
- piano dry-run privato, deterministico, profondamente immutabile e validabile tramite ricalcolo del `planId`;
- un futuro runner richiederà soltanto `memory.readAll`; non è stato aggiunto dal FIX 5.

Decisioni rinviate:

- state machine e vocabolario definitivo di `processingState` al FIX 6;
- segnali lifecycle/Echo, maturità, clustering, batching, sintesi e provenance ai fix dedicati;
- qualsiasi scrittura, commit o autorizzazione operativa futura.

### 2026-07-12 — FIX 6 — Processing state contract

**Stato:** COMPLETED

Il FIX 6 è transitato da `PLANNED` a `IN_PROGRESS` durante implementazione e verifica ed è stato marcato `COMPLETED` soltanto dopo il superamento di tutti i controlli richiesti.

File creati:

- `core/consolidation/ProcessingState.js`;
- `docs/contracts/PROCESSING_STATE_CONTRACT_V1.md`;
- `test/consolidation/processing-state-contract.test.js`.

File allineati:

- `core/consolidation/CandidateSelector.js`;
- `core/consolidation/ConsolidationPlan.js`, limitatamente ai due nuovi reason code deferred richiesti dal selector;
- `docs/contracts/CONSOLIDATION_PLAN_V1.md`;
- `test/consolidation/read-only-consolidation-plan.test.js`;
- `docs/MEMORIA_ORBITALE_EVOLUTION.md`, esclusivamente per dashboard, ADR, cronologia e stato corrente.

Risultati verificati:

- `node --check` superato per ProcessingState, CandidateSelector, ConsolidationPlan e i due test di consolidamento;
- 7/7 test FIX 1, 14/14 test FIX 2, 19/19 test FIX 3 e 13/13 test FIX 4 superati separatamente;
- 20/20 test aggiornati FIX 5 superati;
- 17/17 test dedicati FIX 6 superati;
- 90/90 test combinati superati;
- nessun accesso allo storage o ai dati reali, nessuna scrittura, modello, lock o cluster invocato;
- nessuna modifica a runtime, fixture precedenti, dati reali o server.

Comportamento congelato:

- stati canonici esatti `raw`, `candidate`, `synthesizing`, `consolidated`, `failed`, senza alias;
- sette transizioni V1 esplicite; self transition e ogni altra coppia vietate;
- `consolidated` terminale nel V1;
- revision intera e incrementata esattamente di uno per piano;
- timestamp epoch millisecondi esplicito e non decrescente, mai generato internamente;
- `attempt_id` richiesto durante sintesi e preservato in successo/fallimento;
- errore strutturato obbligatorio solo in `failed`; retry e reset puliscono tentativo ed errore;
- transition plan deterministico, privato, profondamente immutabile e validabile tramite SHA-256;
- CandidateSelector considera soltanto `raw` esplicito eleggibile, rinvia `candidate` e `failed`, esclude `synthesizing` e `consolidated`, e lascia legacy assente non classificato.

Decisioni rinviate:

- confronto optimistic concurrency effettivo nello storage su stato, revision e timestamp;
- persistenza, commit, lock, recovery, idempotenza e policy di retry;
- migrazione esplicita delle memorie legacy;
- ClusterEngine adapter e ogni attività FIX 7.

### 2026-07-12 — FIX 7 — ClusterEngine Adapter read-only

**Stato:** COMPLETED

Il FIX 7 è transitato da `PLANNED` a `IN_PROGRESS` durante implementazione e verifica ed è stato marcato `COMPLETED` soltanto dopo il superamento di tutti i controlli richiesti.

File creati:

- `core/clustering/ClusterMath.js`;
- `core/clustering/ClusterEngineAdapter.js`;
- `docs/contracts/CLUSTER_ENGINE_ADAPTER_V1.md`;
- `test/clustering/cluster-engine-adapter.test.js`.

File aggiornato:

- `docs/MEMORIA_ORBITALE_EVOLUTION.md`, esclusivamente per dashboard, ADR, cronologia e stato corrente.

Risultati verificati:

- `node --check` superato per i due moduli e il test FIX 7;
- 7/7 test FIX 1, 14/14 test FIX 2, 19/19 test FIX 3 e 13/13 test FIX 4 superati separatamente;
- 20/20 test FIX 5 e 17/17 test FIX 6 superati separatamente;
- 21/21 test dedicati FIX 7 superati;
- 111/111 test combinati superati;
- 12 e 100 candidati processati senza limite implicito;
- nessun accesso allo storage o ai dati reali, nessuna scrittura, rete, modello, lock o cluster persistito;
- nessuna modifica a runtime, fixture, dati reali o server.

Comportamento congelato:

- funzioni pure per validazione embedding, cosine, centroide, densità, isolamento e fingerprint;
- provider V1 esplicito che riceve soltanto `memoryId` ed `embeddingRef`;
- `ConsolidationPlan` obbligatoriamente validato e soli `candidateIds` processati;
- ogni candidato plain passa attraverso `MemoryContractNormalizer`;
- algoritmo `complete-link-greedy-v1`, ordinato per ID e con soglia diretta;
- policy default `similarityThreshold: 0.70`, `minClusterSize: 3`, `maxClusterSize: null`;
- gruppi sotto minimo spiegati e gruppi oltre un massimo esplicito interamente rinviati senza perdita di membri;
- cluster ID e centroid fingerprint SHA-256 deterministici;
- output privato, profondamente immutabile e sempre `persisted: false`;
- failure provider e embedding invalidi isolati e ordinati indipendentemente dal completamento async.

Legacy e limiti:

- `core/ClusterEngine.js` resta legacy/teorico, invariato e non integrato nell'adapter;
- non esiste nel repository un file `CluasterEngine.js` da sincronizzare;
- l'euristica greedy non garantisce ottimo globale e la densità non equivale a maturità;
- persistenza cluster, schema persistito, split/merge, maturità e sintesi sono rinviati;
- FIX 8 non è stato iniziato.

### 2026-07-12 — FIX 8 — Cluster Persistence

**Stato:** COMPLETED

Il FIX 8 è transitato da `PLANNED` a `IN_PROGRESS` durante implementazione e verifica. La chiusura è sospesa perché il test FIX 4 contiene aspettative capability pre-FIX 8 ma il file non è autorizzato per la modifica.

File creati:

- `core/clustering/ClusterRecord.js`;
- `docs/contracts/CLUSTER_PERSISTENCE_V1.md`;
- `test/clustering/cluster-persistence.test.js`.

File aggiornati:

- `core/JsonMemoryStorage.js`;
- `core/StorageCapabilityContract.js`, limitatamente ai write path cluster della capability `commit.atomic`;
- `docs/contracts/STORAGE_CAPABILITY_CONTRACT_V1.md`;
- `test/storage/storage-capability-contract.test.js`;
- `test/storage/json-atomic-commit.test.js`, limitatamente alle aspettative capability post-FIX 8;
- `docs/MEMORIA_ORBITALE_EVOLUTION.md`.

Risultati verificati:

- `node --check` superato per ClusterRecord, JsonMemoryStorage e i test richiesti;
- 13/13 test dedicati FIX 8 superati;
- 19/19 test capability e 13/13 test atomic commit superati;
- tutti i 111 test FIX 1–7 superati come parte della suite;
- 124/124 test combinati superati soltanto durante la prova con il minimo allineamento delle aspettative capability FIX 4, poi ripristinato per rispettare lo scope dei file;
- `git diff --check` superato sui soli file FIX 8;
- test storage eseguiti esclusivamente sotto `os.tmpdir()`, con cleanup e senza residui temp;
- hash e metadati degli 11 file dati reali verificati invariati senza stamparne il contenuto;
- nessuna modifica a memorie sorgenti, dati reali, server, fixture o legacy ClusterEngine.

Comportamento introdotto:

- record cluster V1 snake_case stretto, plain, copiato e profondamente congelato;
- provenance tramite source memory ID esatti, univoci e ordinati;
- provider, modello, versione e dimensione embedding espliciti;
- centroide inline autorevole, validato e protetto da fingerprint;
- ID derivato dalla idempotency key e `candidate_cluster_id` conservato separatamente;
- record fingerprint semantico indipendente da timestamp e piano equivalente;
- `loadClusters`, `getCluster`, `saveCluster`, `deleteCluster` e ricerca opzionale per idempotency key;
- object map per utente in `<dataDir>/<userId>_clusters.json`;
- replay sequenziale equivalente senza duplicato o riscrittura e conflitti senza overwrite;
- atomic replace e backup `.bak` per le scritture cluster;
- quattro capability cluster dichiarate `supported/verified`.

Garanzie e limiti:

- cluster CRUD e persistenza cluster sono risolti nel confine V1;
- le memorie sorgenti non vengono modificate, assegnate o eliminate;
- nessuna processing transition, sintesi, chiamata modello o migrazione legacy è stata introdotta;
- idempotenza garantita soltanto per replay sequenziale nello stesso processo/stato letto;
- concorrenza multi-processo, lost update, lock, compare-and-swap e transazioni memoria + cluster restano aperti;
- FIX 9 non è stato iniziato.

### 2026-07-12 — Chiusura FIX 8 dopo riallineamento del test FIX 4

**Stato:** COMPLETED

Il test FIX 4 `test/storage/json-atomic-commit.test.js` è stato aggiornato soltanto nelle quattro aspettative cluster perché descriveva lo stato storico precedente a una capability successivamente evoluta dal FIX 8. La voce storica del FIX 4 e le matrici storiche FIX 3/FIX 4 restano invariate.

Verifica di chiusura:

- `node --check test/storage/json-atomic-commit.test.js` superato;
- test FIX 4: 13/13 superati;
- test capability: 19/19 superati;
- test FIX 8: 13/13 superati;
- suite completa FIX 1–8: 124/124 superati;
- snapshot, lock e rollback restano `unsupported`;
- `commit.atomic` resta limitato alla sostituzione atomica del singolo file;
- FIX 9 non è stato iniziato.

### 2026-07-12 — FIX 9 — SynthesisEngine Contract

**Stato:** COMPLETED

Il FIX 9 è transitato da `PLANNED` a `IN_PROGRESS` durante implementazione e verifica ed è stato marcato `COMPLETED` soltanto dopo il superamento dei controlli dedicati, della regressione FIX 1–8 e della suite combinata.

File creati:

- `core/synthesis/SynthesisContract.js`;
- `core/synthesis/SynthesisEngine.js`;
- `docs/contracts/SYNTHESIS_ENGINE_V1.md`;
- `test/synthesis/synthesis-engine-contract.test.js`.

File aggiornato:

- `docs/MEMORIA_ORBITALE_EVOLUTION.md`, esclusivamente per dashboard, ADR, cronologia e stato corrente.

Risultati verificati:

- `node --check` superato per i due moduli e il test FIX 9;
- primo run dedicato: 27/29, con due sole asserzioni del nuovo test errate; corrette senza modificare il contratto o indebolire i controlli;
- test dedicati FIX 9 finali: 29/29 superati;
- regressione completa FIX 1–8: 124/124 superati;
- suite combinata FIX 1–9: 153/153 superati;
- timeout verificato con provider cooperativo e provider che ignora `AbortSignal`, incluso cleanup del timer;
- 12 source sintetiche accettate senza limite top-five; input eccedente rifiutato senza truncation;
- nessuna rete, trasporto Qwen/Ollama reale, scrittura storage o modifica dati eseguita.

Comportamento introdotto:

- cluster record V1 validato e risoluzione esatta di `source_memory_ids`;
- normalizzazione condivisa flat/nested/hybrid e descriptor minimo ordinato;
- SHA-256 del testo UTF-8 esatto e request ID deterministico;
- provider esplicito con metadata versionati, response envelope e formato JSON richiesto;
- prompt anti-allucinazione versionato con source delimitate come dati non fidati;
- constraints chiuse, limiti input/output e timeout per chiamata;
- parsing JSON rigoroso senza repair, schema chiuso, confidence `[0,1]` e copertura completa used/rejected;
- provenance obbligatoria per fatti, incertezze e contraddizioni;
- result envelope privato, deterministico, separato, profondamente congelato e rivalidabile;
- nessun accesso storage, commit, processing transition, super-memory o transport integrato.

Garanzie e limiti:

- il testo sorgente attraversa il solo provider configurato perché necessario alla sintesi e non viene conservato nel result o negli errori;
- errori pubblici sintetici non includono testo, prompt, raw response o messaggio provider integrale;
- la validazione prova schema, ID, attribution e copertura, ma non dimostra che ogni affermazione sia semanticamente sostenuta: anti-allucinazione strutturale non equivale a verifica fattuale perfetta;
- batching, evaluation semantica, adapter Qwen/Ollama e commit transazionale restano rinviati;
- FIX 10 non è stato iniziato.

### 2026-07-12 — FIX 10 — Transactional Consolidation Commit

**Stato:** COMPLETED

Il FIX 10 è transitato da `PLANNED` a `IN_PROGRESS` durante implementazione e verifica ed è stato marcato `COMPLETED` soltanto dopo syntax check, test dedicati, storage regression, regressione FIX 1–9 e suite completa.

File creati:

- `core/locking/FileLockManager.js`;
- `core/consolidation/SuperMemoryRecord.js`;
- `core/consolidation/ConsolidationTransaction.js`;
- `docs/contracts/TRANSACTIONAL_CONSOLIDATION_COMMIT_V1.md`;
- `test/consolidation/transactional-consolidation-commit.test.js`.

File aggiornati:

- `core/JsonMemoryStorage.js`, per lock condiviso sui sette writer e API lock;
- `core/MemoryContractNormalizer.js`, con fallback circoscritto `processing.state` quando `processingState` è assente;
- `test/contracts/memory-contract-normalizer.test.js`, per riconoscimento super-memory e precedenza legacy;
- `test/storage/storage-capability-contract.test.js` e `test/storage/json-atomic-commit.test.js`, soltanto per le capability lock realmente verificate;
- `docs/contracts/STORAGE_CAPABILITY_CONTRACT_V1.md`, con stato append-only post-FIX 10;
- `docs/MEMORIA_ORBITALE_EVOLUTION.md`, per dashboard, ADR, cronologia e stato corrente.

Risultati verificati:

- `node --check` superato per tutti i file JavaScript creati o modificati;
- primo run dedicato: 18/20, con due asserzioni privacy ambigue su `prompt_version`, poi rese strutturali;
- secondo run dedicato: 16/20; ha evidenziato una race reale `ENOENT` tra cleanup directory lock e acquire concorrente, corretta rendendo la race recuperabile, oltre a due asserzioni testuali ambigue;
- test dedicati FIX 10 finali: 20/20 superati;
- test storage/capability/atomic: 32/32 superati;
- regressione completa FIX 1–9 aggiornata: 154/154 superati;
- suite combinata FIX 1–10: 174/174 superati;
- 12 memory writer, 8 link writer e due cluster writer concorrenti verificati senza lost update;
- post-commit failure con ripristino snapshot esatto e rollback failure con stato `unknown` verificati tramite override sintetici;
- tutti i test mutanti eseguiti sotto `os.tmpdir()` e nessuna chiamata Qwen/Ollama o rete.

Comportamento introdotto:

- lock file SHA-256 per user key con apertura `wx`, token/owner, timeout, retry, ownership e doppia-release check;
- tutti i writer memory/link/cluster dello stesso utente serializzati; handle già detenuto evita lock annidato;
- `lock.acquire` e `lock.release` dichiarate `supported/verified`; snapshot e rollback generale restano `unsupported`;
- super-memory deterministica `sm_<idempotency-key>`, core/consolidated, senza raw source o prompt;
- transaction plan deterministico con copertura completa e transition role-correct;
- precondition su stato, revision, timestamp e attempt ID prima di qualsiasi write;
- used source `synthesizing → consolidated`; rejected source `synthesizing → failed` con errore stabile;
- raw e campi sconosciuti integralmente preservati;
- super-memory e source salvate con una sola sostituzione atomica del file memoria;
- verifica post-commit, replay idempotente senza write/revision increment e rollback circoscritto sotto lo stesso lock;
- cluster record e file cluster non modificati dal commit.

Garanzie e limiti:

- il rollback FIX 10 è soltanto ripristino dello snapshot RAM del file memoria dopo failure post-commit nello stesso processo;
- non costituisce capability rollback generale, snapshot API, journal o transazione multi-file;
- un crash può lasciare lock stale e può interrompere la finestra di recovery: stale-lock recovery e crash recovery restano al FIX 14;
- raw non vengono cancellati o compressi;
- FIX 11 non è stato iniziato.

### 2026-07-12 — FIX 11 — RecallRouter read-only

**Stato:** COMPLETED

Il FIX 11 è transitato da `PLANNED` a `IN_PROGRESS` durante implementazione e verifica ed è stato marcato `COMPLETED` soltanto dopo syntax check, test dedicati, regressione FIX 1–10 e suite completa.

File creati:

- `core/recall/RecallRouter.js`;
- `docs/contracts/RECALL_ROUTER_V1.md`;
- `test/recall/recall-router-read-only.test.js`.

Risultati verificati:

- `node --check` superato per router e test;
- primo run dedicato: 24/26, per una fixture tier errata e un controllo statico troppo ampio nel solo test, poi corretti senza modificare il contratto;
- test dedicati FIX 11 finali: 26/26 superati;
- regressione completa FIX 1–10: 174/174 superati;
- suite combinata FIX 1–11: 200/200 superati;
- core e warm interrogati in parallelo con output deterministico anche a ordine asincrono differente;
- almeno 12 risultati verificati senza troncamento quando il limite lo consente;
- nessuna rete, storage, scrittura dati o chiamata modello.

Comportamento introdotto:

- retriever espliciti, validati e invocati sempre con `mutate: false`;
- route predefinita core+warm; deep soltanto tramite `includeDeep`, `full-history` o fallback esplicitamente configurato e motivato;
- normalizzazione flat/nested/hybrid, classificazione tier stretta e risultati incompatibili esclusi con reason code;
- deduplica deterministica per ID e contenuto UTF-8 esatto, quindi soppressione configurabile delle source coperte da super-memory;
- `finalScore` uguale allo score del retriever, senza boost di tier, activation, link o freshness;
- limite finale applicato soltanto dopo merge, deduplica, soppressione e ranking; nessun limite implicito di cinque;
- output minimale, separato e profondamente congelato, con stats, suppressed, invalidResults e reinforcement pending puramente informativo;
- `readOnly: true` e `reinforcementApplied: false` invarianti.

Audit legacy documentato senza modifiche:

- `KebloMemory.recall()` può mutare activation/access con `mutateOnRecall`, applicare score legacy, Echo e link boost;
- i filtri legacy usano anche `memoryDepth`/`orbitalLevel` e non costituiscono una classificazione tier V1;
- link boost non impone un confine tier e dovrà essere adattato senza reintrodurre deep;
- `getContextForKeblo`, bridge e chat contengono budget, slicing o interpretazione linguistica che non appartengono al router V1.

Garanzie e limiti:

- il router non importa storage, `KebloMemory`, filesystem, Qdrant, Qwen/Ollama e non applica reinforcement;
- non interpreta comandi linguistici e non integra il runtime;
- un retriever legacy che non garantisce `mutate: false` dovrà essere rifiutato o adattato esplicitamente nel FIX 12;
- scoring avanzato, adapter legacy e reinforcement dopo selezione finale restano rinviati;
- FIX 12 non è stato iniziato.

### 2026-07-12 — FIX 12 — RecallRouter Integration

**Stato:** COMPLETED

Il FIX 12 è transitato da `PLANNED` a `IN_PROGRESS` durante implementazione e verifica ed è stato marcato `COMPLETED` soltanto dopo syntax check, test dedicati, regressione FIX 1–11 e suite combinata completa.

File creati:

- `core/recall/MemoryTierClassifier.js`;
- `core/recall/LegacyRecallAdapter.js`;
- `core/recall/RecallRequestBuilder.js`;
- `docs/contracts/RECALL_ROUTER_INTEGRATION_V1.md`;
- `test/recall/recall-router-integration.test.js`.

File aggiornati:

- `core/Keblomemory.js`, con filtro tier, `recallReadOnly`, dependency injection, reinforcement batch e getContext instradato;
- `chat_orbitale_ollama.js`, con bootstrap e singola pipeline router, preservando le modifiche utente preesistenti;
- `core/OrbitaleBridge.js`, perché chiamava direttamente recall/getContext;
- `docs/contracts/RECALL_ROUTER_V1.md`, con sola nota d'integrazione;
- `docs/MEMORIA_ORBITALE_EVOLUTION.md`, per dashboard, ADR, cronologia e stato corrente.

Mapping legacy verificato:

- `memoryDepth: deep` e `historical` → deep;
- altri record untiered non-super → warm;
- `memoryDepth: core` resta warm legacy e non equivale a storage core;
- `orbitalLevel` non determina il tier;
- super-memory core richiede insieme `memoryKind: super_memory` e `storageTier: core`.

Comandi deep espliciti, riconosciuti solo come prefisso case-insensitive:

- `cerca nello storico completo`;
- `cerca in tutta la memoria`;
- `search full history`.

Parole isolate come ieri, passato, ricordo o storico non attivano deep. Il prefisso viene rimosso solo se resta una query utile; il fallback deep resta opt-in.

Risultati verificati:

- primo run dedicato: 23/25, per un mock privo dello score obbligatorio e un confronto floating-point esatto nel solo test;
- audit successivo con super-memory priva di campi orbitali: 26/27, per una sola asserzione test storica che pretendeva insieme `accessCount: 0` e campo assente, resa coerente mantenendo i controlli di non-invenzione;
- test dedicati FIX 12 finali: 27/27 superati, inclusi JsonMemoryStorage/lock e bridge in directory temporanee;
- regressione completa FIX 1–11: 200/200 superati;
- suite combinata FIX 1–12: 227/227 superati;
- almeno 12 risultati senza top-five implicito;
- nessun accesso a rete/modello e nessuna esecuzione della chat reale.

Garanzie e limiti:

- adapter core/warm/deep chiamano soltanto `recallReadOnly()` e richiedono `mutate: false`;
- il filtro tier precede warm index, Echo, base/link scoring ed è riapplicato prima dell'output;
- source suppressed, invalid, truncated e super-memory non ricevono reinforcement;
- gli ID finali sono deduplicati e rinforzati una volta con una sola batch save sotto lock quando disponibile;
- `recall()` diretto conserva il default mutante e `mutateOnRecall: false` legacy;
- i budget 3/5/10 o `candidateLimit` rimasti sono decisioni contestuali dei chiamanti, non limiti del router;
- nessun daemon Hippocampus, migrazione, modello o server è stato introdotto;
- FIX 13 non è stato iniziato.

### 2026-07-12 — FIX 13 — HippocampusDaemon single-process

**Stato:** COMPLETED

Il FIX 13 è stato marcato `COMPLETED` soltanto dopo syntax check, test daemon, regressione ConsolidationTransaction, regressione FIX 1–12 e suite completa.

File creati:

- `core/hippocampus/MaturityGate.js`;
- `core/hippocampus/SourceClaimTransaction.js`;
- `core/hippocampus/HippocampusDaemon.js`;
- `docs/contracts/HIPPOCAMPUS_DAEMON_V1.md`;
- `test/hippocampus/hippocampus-daemon-single-process.test.js`.

File aggiornati:

- `core/consolidation/ConsolidationTransaction.js`, con precondizione content hash immediatamente prima del commit;
- `test/consolidation/transactional-consolidation-commit.test.js`, con fixture coerente col testo inviato al modello e regressione hash mismatch;
- `docs/contracts/TRANSACTIONAL_CONSOLIDATION_COMMIT_V1.md`;
- `docs/MEMORIA_ORBITALE_EVOLUTION.md`.

Comportamento verificato:

- dry-run/plan default senza provider né write;
- fasi cluster e synthesis con provider espliciti e nessuna persistenza dry-run;
- commit protetto da `commitEnabled: true` e token `COMMIT_HIPPOCAMPUS_V1`;
- scheduler locale esclusivamente dry-run, stop idempotente e guard anti-overlap;
- maturity conservativa con approvazione cluster ID esplicita;
- claim atomico `raw → candidate → synthesizing`, revision +2 e raw/campi sconosciuti preservati;
- legacy ammesso soltanto come opt-in dry-run e sempre vietato in commit;
- modello invocato fuori lock;
- used consolidated, rejected failed e provider failure chiusa come failed;
- policy stop/continue esplicita tra cluster;
- dodici cluster dry-run senza limite implicito di cinque;
- replay senza seconda super-memory;
- report/eventi sanitizzati ed event sink failure isolata.

Content-hash precondition:

- ogni source viene rinormalizzata subito prima di replay/commit;
- SHA-256 è ricalcolato sul testo UTF-8 esatto;
- mismatch con `SynthesisResult.sourceContentHashes` blocca ogni write finale, super-memory e transizione;
- l'errore contiene soltanto ID e causa tecnica, mai il testo.

Risultati:

- primo run daemon: 9/16, con capability fake malformate, controllo statico troppo ampio e mismatch hash reale individuato nella rappresentazione array di `sourceContentHashes`; corretti senza indebolire il runtime;
- test daemon finali: 18/18 superati;
- prima regressione transazione post-hash: 14/21, perché la fixture storica dichiarava al modello `Synthetic source` ma persisteva `RAW`; fixture sintetica riallineata al contratto;
- regressione transazione finale: 21/21 superata;
- suite completa FIX 1–13: 246/246 superata;
- tutte le scritture test sotto `os.tmpdir()`;
- nessuna rete, modello reale, daemon reale o prototipo Hippocampus eseguito.

Limiti aperti:

- un crash dopo claim può lasciare source synthesizing;
- un crash può lasciare lock stale;
- non esistono journal, recovery persistente, coordinamento daemon multi-process o maturità multi-ciclo;
- FIX 14 non è stato iniziato.

### 2026-07-12 — FIX 14 — Recovery, persistent journal e stale-lock handling

**Stato:** COMPLETED

File creati:

- `core/hippocampus/HippocampusJournal.js`;
- `core/hippocampus/RecoveryManager.js`;
- `docs/contracts/HIPPOCAMPUS_RECOVERY_V1.md`;
- `test/hippocampus/hippocampus-recovery.test.js`.

File aggiornati:

- `core/locking/FileLockManager.js`, con metadata PID/host/time, inspect e stale recovery autorizzata;
- `core/JsonMemoryStorage.js`, con sola delega lock utente;
- `core/hippocampus/HippocampusDaemon.js`, con journal obbligatorio, preflight e phase events;
- test e contratti FIX 13/storage strettamente interessati;
- `docs/MEMORIA_ORBITALE_EVOLUTION.md`.

Comportamento introdotto e verificato:

- journal JSONL per user hash, sequence continua, fingerprint, fsync e replay evento idempotente;
- privacy strutturale: nessun testo, prompt, output, centroide, embedding, stack o lock data;
- riparazione autorizzata della sola coda troncata, con fingerprint/size precondition e backup;
- corruzione intermedia, sequence e fingerprint alterati sempre bloccati;
- ricostruzione di run incompleti per cluster/attempt e classificazione delle crash window;
- recovery plan deterministico e dry-run con fingerprint journal/memory;
- claimed/synthesis interrotti attribuibili oltre grace marcati failed una sola volta;
- synthesis output non persistito mai ricostruito;
- cluster orphan registrato senza modificare source o cluster;
- commit valido ma ACK journal mancante riconciliato dallo storage senza seconda super-memory;
- synthesizing non attribuibile, stati misti e duplicati semantici bloccati;
- nessun lock data/journal annidato: checkpoint, primitiva data, rilascio, append journal;
- daemon commit bloccato senza journal/recovery manager o quando preflight richiede recovery;
- failure journal pre-claim senza mutazioni; failure post-commit come `NEEDS_RECONCILIATION`.

Stale-lock policy:

- età da sola non è sufficiente;
- PID vivo non viene mai rimosso;
- host diverso/non verificabile e metadata invalidi richiedono intervento manuale;
- recovery automatica richiede host locale, PID morto, età esplicita, fingerprint invariato e token `RECOVER_STALE_LOCK_V1`;
- race o lock sostituito vengono bloccati.

Risultati:

- primo run recovery: 6/17, per validazione del record journal completo nel percorso interno; corretto separando input semantico ed envelope persistito;
- test FIX 14 + FIX 13 aggiornato: 37/37 superati;
- test lock/storage/transazione: 53/53 superati;
- suite completa FIX 1–14: 265/265 superata;
- tutte le scritture test sotto `os.tmpdir()`;
- nessun daemon/prototipo/provider reale eseguito e nessun dato reale modificato.

Limiti residui:

- nessun distributed lock o consensus;
- PID remoto/non verificabile non è recuperato automaticamente;
- stati ambigui richiedono procedura manuale;
- FIX 15 non è stato iniziato.

### 2026-07-12 — FIX 15 — Vector Index Adapter opzionale e non autorevole

**Stato:** COMPLETED

File creati:

- `core/vector/VectorIndexRecord.js`;
- `core/vector/VectorIndexAdapter.js`;
- `docs/contracts/VECTOR_INDEX_ADAPTER_V1.md`;
- `test/vector/vector-index-adapter.test.js`.

Comportamento verificato:

- kind chiusi memory fragment, super-memory e cluster centroid;
- vector validato con ClusterMath e fingerprint SHA-256 della serializzazione JSON numerica;
- user hash SHA-256, dedup key semantica e UUID deterministico con bit version/variant;
- payload V1 chiuso, filtrabile e privo di testo/content/prompt/source snapshot;
- provider V1 completamente iniettato, senza endpoint, fetch, API key o fallback;
- collection esistente, dimensione e distance validate prima di upsert/search;
- upsert nuovo, replay no-write e conflitto senza overwrite;
- batch completamente validato, ordinato e senza limite implicito di cinque; dodici point verificati;
- search con allowlist, user hash, kind/tier/state/cluster/time filter e raw score invariato;
- delete/inspect limitati ai point ID, senza alcuna scrittura JSON;
- timeout cooperativo/non cooperativo e timer cleanup;
- health check sanitizzato e nessun provider Qdrant reale.

Risultati:

- test dedicati FIX 15: 20/20 superati;
- regressione FIX 1–14: 265/265 superata;
- suite completa FIX 1–15: 285/285 superata;
- syntax e diff check dedicati superati;
- nessuna rete, embedding generation, collection creation, daemon o dato reale coinvolto.

**Queue pre-Ippocampo FIX 1–15: COMPLETATA.**

Questo stato non autorizza l'attivazione sui dati reali. Il prossimo milestone è `HIPPOCAMPUS ACTIVATION GATE`, non iniziato.

Attività successive soggette a nuova autorizzazione:

- provider embedding reale;
- provider Qwen/Ollama reale;
- collection Qdrant esplicita;
- dry-run sul dataset DEV;
- revisione report;
- commit canary su copie sintetiche/staging;
- eventuale attivazione sui dati reali;
- successivo merge controllato in Keblo server.

## 10. Stato corrente

- **Ultimo intervento completato:** FIX 15 — Vector Index Adapter opzionale e non autorevole.
- **Prossimo milestone:** HIPPOCAMPUS ACTIVATION GATE, non iniziato e non autorizzato.
- **Queue:** FIX 1–15 completata.
- **Runtime modificato:** nessuna integrazione vector nel runtime; adapter isolato e opzionale.
- **Dati reali modificati:** no.
- **Server modificato:** no.
- **Blocco corrente:** attivazione reale richiede nuova autorizzazione e completamento dell'Activation Gate.

Il FIX 15 è `COMPLETED`; l'Activation Gate non è iniziato.

## 11. Rischi e debito tecnico aperto

- Incompatibilità tra contratti flat e nested.
- Corruzione o troncamento del singolo file mitigati dal protocollo atomico; recovery da crash da approfondire.
- Lost update tra writer concorrenti ancora possibile, inclusi i file cluster.
- Assenza di lock.
- Cluster CRUD e persistenza cluster V1 risolti; migrazione legacy e vector adapter restano futuri.
- Recall con comportamenti mutanti da separare dal percorso read-only.
- Campi link incompatibili tra moduli o rappresentazioni.
- Moduli che presumono istanze di classe, mentre lo storage carica plain object.
- Compressor con comportamento distruttivo incompatibile con gli invarianti futuri.
- Prototipi Hippocampus auto-avvianti, non equivalenti a un daemon integrato e sicuro.
- Assenza di idempotenza e recovery del consolidamento.
- Worktree con modifiche preesistenti che ogni fix deve identificare e preservare.

Nessuno di questi rischi è dichiarato risolto dai FIX 1–3 o da questo documento.

## 12. Protocollo di aggiornamento

1. Prima di ogni intervento, leggere questo documento.
2. Aggiornare lo stato a `IN_PROGRESS` soltanto quando il lavoro comincia.
3. Segnare `COMPLETED` soltanto dopo test superati.
4. Se i test falliscono, usare `BLOCKED` o lasciare `IN_PROGRESS`, secondo lo stato reale.
5. Aggiornare la dashboard.
6. Aggiungere una voce alla cronologia senza modificare quelle precedenti.
7. Aggiungere un ADR quando viene presa una decisione architetturale.
8. Aggiornare “Stato corrente” e “Prossimo intervento”.
9. Non nascondere regressioni, rollback o tentativi falliti.
10. Distinguere sempre modifiche del fix da modifiche preesistenti.
11. Non includere dati personali o contenuti delle memorie reali.
12. Non trasformare previsioni o idee in funzionalità dichiarate operative.

### 2026-07-13 — Post-implementation audit FIX 1–15 e Ippocampo

**Verdetto:** `NOT_READY`

È stato completato l'audit indipendente e non correttivo documentato in
`docs/HIPPOCAMPUS_POST_IMPLEMENTATION_AUDIT.md`. La suite sicura completa resta
verde (285/285) e i file dati controllati sono invariati, ma l'audit registra 10
finding: 0 P0, 4 P1, 4 P2 e 2 P3. I blocker P1 riguardano ricostruzione journal
multi-cluster, atomicità del recovery sotto user lock, chiusura degli eventi di
failure e presenza dell'userId in chiaro nel claim plan journalizzato.

I blocker non sono dichiarati risolti. Il commit reale resta disabilitato e
`HIPPOCAMPUS ACTIVATION GATE` non è iniziato. Il prossimo milestone è una
remediation esplicitamente autorizzata dei blocker post-audit, seguita da un
nuovo riesame go/no-go prima dell'Activation Gate.

## 13. Post-Audit Remediation Queue

Questa sezione è un addendum append-only allo stato storico precedente. Registra
la pianificazione derivata da `docs/HIPPOCAMPUS_POST_IMPLEMENTATION_AUDIT.md`,
senza dichiarare risolto alcun finding e senza iniziare l'Activation Gate.

### 13.1 Dashboard

| Ordine | Intervento | Finding | Priorità | Stato | Obbligatorio prima dell'Activation Gate |
|---:|---|---|---|---|---|
| 1 | FIX 16 — Journal claim privacy boundary | AUD-P1-004 | P1 | `COMPLETED` | sì |
| 2 | FIX 17 — Multi-cluster journal correlation | AUD-P1-001 | P1 | `COMPLETED` | sì |
| 3 | FIX 18 — Terminal failure lifecycle | AUD-P1-003 | P1 | `COMPLETED` | sì |
| 4 | FIX 19 — Recovery single-user-lock transaction | AUD-P1-002 | P1 | `COMPLETED` | sì |
| 5 | FIX 20 — Recovery composition regression matrix | AUD-P2-002 | P2 | `COMPLETED` | sì |
| 6 | FIX 21 — Persistent recovery status | AUD-P2-001 | P2 | `COMPLETED` | sì |
| 7 | FIX 22 — Synthetic scale budgets and telemetry | AUD-P2-003 | P2 | `COMPLETED` | sì, prima del dry-run DEV |
| 8 | FIX 23 — Vector hydration and stale-point verification | AUD-P2-004 | P2 | `DEFERRED` | solo se il vector path entra nel Gate |
| 9 | FIX 24 — Current-risk documentation addendum | AUD-P3-001 | P3 | `DEFERRED` | no |
| 10 | FIX 25 — Recovery readability refactor | AUD-P3-002 | P3 | `DEFERRED` | no |
| 11 | FIX 26 — Vector adapter readability refactor | AUD-P3-002 | P3 | `DEFERRED` | no |
| 12 | FIX 27 — Post-remediation closure audit | tutti i finding obbligatori | audit | `PENDING` | sì |

Gli interventi obbligatori prima dell'Activation Gate sono otto: FIX 16–22 e
FIX 27. FIX 23 diventa obbligatorio prima di abilitare un percorso vector; FIX
24–26 possono essere rinviati perché non autorizzano né proteggono un commit.

### 13.2 Mapping finding → intervento

| Finding | Intervento primario | Verifica di chiusura |
|---|---|---|
| AUD-P1-001 | FIX 17 | FIX 20 e FIX 27 |
| AUD-P1-002 | FIX 19 | FIX 20 e FIX 27 |
| AUD-P1-003 | FIX 18 | FIX 20 e FIX 27 |
| AUD-P1-004 | FIX 16 | FIX 20 e FIX 27 |
| AUD-P2-001 | FIX 21 | FIX 27 |
| AUD-P2-002 | FIX 20 | FIX 27 |
| AUD-P2-003 | FIX 22 | FIX 27 prima del dry-run DEV |
| AUD-P2-004 | FIX 23 | audit vector dedicato prima dell'abilitazione vector |
| AUD-P3-001 | FIX 24 | review documentale append-only |
| AUD-P3-002 | FIX 25 e FIX 26 | suite invariata e review meccanica per sottosistema |

### 13.3 Dipendenze

```text
FIX 16 (privacy descriptor)
  -> FIX 17 (state machine multi-cluster)
       -> FIX 18 (failure terminali)
            -> FIX 19 (recovery sotto unico lock)
                 -> FIX 20 (crash/concurrency/privacy regression matrix)
                      -> FIX 21 (status persistente)
                           -> FIX 22 (budget sintetici e telemetry)
                                -> FIX 27 (audit di chiusura)

FIX 23 (vector hydration) è indipendente dalla recovery, ma precede qualsiasi
abilitazione vector. FIX 24 dipende dall'esito finale della remediation. FIX 25
dipende da FIX 19–20; FIX 26 dipende da FIX 23 se quest'ultimo viene eseguito.
```

L'ordine P1 è intenzionale: prima si elimina l'identità in chiaro dal formato
journalizzato, poi si stabilizza la chiave di correlazione per cluster, quindi
si completa il lifecycle degli errori e infine si rende atomica la recovery
rispetto agli altri writer. Invertire l'ordine costringerebbe a ridefinire o
ritestare primitive già usate dagli interventi successivi.

### 13.4 FIX 16 — Journal claim privacy boundary

- **Scope consentito:** sanitizzazione e validazione del descriptor necessario
  alla recovery; nessuna modifica alle transizioni processing o ai dati memoria.
- **File presumibili:** `core/hippocampus/HippocampusJournal.js`,
  `core/hippocampus/HippocampusDaemon.js`,
  `core/hippocampus/RecoveryManager.js`, eventualmente
  `core/hippocampus/SourceClaimTransaction.js` solo per una funzione pura di
  proiezione; test e contratti Hippocampus strettamente correlati.
- **Comportamento richiesto:** `SOURCES_CLAIMED` persiste un descriptor chiuso,
  versionato e sufficiente alla recovery, senza `userId` in chiaro. L'identità
  utente deriva esclusivamente dallo scope già configurato e verificato del
  journal/storage; hash o scope ID non devono diventare un alias reversibile.
- **Invarianti di sicurezza:** niente testo, prompt, output modello, payload
  memoria, token/path lock o identità utente chiara; nessuna riduzione delle
  optimistic precondition del claim; compatibilità esplicita o rifiuto sicuro
  dei record journal V1 già presenti.
- **Test nuovi:** scansione ricorsiva degli eventi e del JSONL; replay del
  descriptor; recovery attribuibile senza `userId`; proprietà sconosciute o
  alias (`user`, `user_id`, nested claim plan) rifiutati.
- **Regression test:** append/replay/fingerprint journal, source claim,
  reconciliation e daemon happy path.
- **Failure injection:** descriptor incompleto, hash scope errato, evento V1
  legacy ambiguo, append failure prima e dopo il claim.
- **Acceptance criteria:** nessuna identità chiara nel file; recovery equivalente
  ancora deterministica; suite FIX 13–15 e completa verde; diff privacy review.
- **Non può essere `COMPLETED` se:** il descriptor perde precondition, il reader
  accetta campi privati, la recovery richiede di reintrodurre `userId` nel JSONL
  o manca una decisione esplicita per journal storici.

### 13.5 FIX 17 — Multi-cluster journal correlation

- **Scope consentito:** ricostruzione journal e correlazione run/cluster/attempt;
  nessuna mutazione storage nuova.
- **File presumibili:** `HippocampusJournal.js`, `RecoveryManager.js`,
  `HippocampusDaemon.js` solo per metadati di correlazione mancanti, test e
  contratti recovery/daemon.
- **Comportamento richiesto:** state machine per
  `(run_id, cluster_id, attempt_id)`; validazione dell'ordine; stato run derivato
  dall'insieme dei cluster; un `COMMIT_SUCCEEDED` non chiude cluster successivi.
- **Invarianti di sicurezza:** eventi ambigui o correlazioni mancanti bloccano;
  nessuna source viene attribuita per somiglianza; `RUN_COMPLETED` è valido solo
  quando ogni cluster selezionato è terminale o esplicitamente deferred.
- **Test nuovi:** due o più cluster con c1 committed e c2 claimed/synthesis
  started/commit started; attempt multipli; eventi interleaved; cluster
  duplicati; ordine invalido; continue-on-failure.
- **Regression test:** run single-cluster, reconciliation post-commit e detection
  delle classi incomplete esistenti.
- **Failure injection:** crash a ogni confine tra cluster, evento terminale perso,
  append fuori ordine e cluster ID/attempt ID discordanti.
- **Acceptance criteria:** la riproduzione AUD-P1-001 individua esattamente c2;
  nessuna falsa completion; piano recovery per-cluster deterministico.
- **Non può essere `COMPLETED` se:** l'aggregazione usa ancora il solo ultimo
  evento del run, un cluster incompleto scompare o i test coprono solo un cluster.

### 13.6 FIX 18 — Terminal failure lifecycle

- **Scope consentito:** emissione e validazione degli eventi terminali dopo
  failure gestite; nessun cambio alla policy provider o al contenuto degli errori.
- **File presumibili:** `HippocampusDaemon.js`, `HippocampusJournal.js`,
  `RecoveryManager.js`, test daemon/recovery e relativi contratti.
- **Comportamento richiesto:** provider/synthesis failure journalizza in ordine
  `SYNTHESIS_FAILED`, esito `SOURCES_FAILED` e `RUN_FAILED`; commit failure usa
  `COMMIT_FAILED`; gli eventi sono idempotenti e correlati al cluster/attempt.
- **Invarianti di sicurezza:** source claimed non restano `synthesizing` dopo una
  failure gestita; un fallimento nel marcare failed è terminale ma non viene
  dichiarato riuscito; errori e journal restano sanitizzati.
- **Test nuovi:** rejection e timeout provider, output invalido, fail-claim
  riuscito/fallito, continue-on-failure true/false, ogni sequenza terminale.
- **Regression test:** happy path, post-commit reconciliation, report/event sink.
- **Failure injection:** append di ciascun evento failure, fallimento storage
  durante `failClaimedSources`, provider cooperativo/non cooperativo.
- **Acceptance criteria:** ogni cluster iniziato raggiunge un terminale coerente
  o uno stato esplicitamente recovery-required; preflight successivo non produce
  `CLAIM_NOT_ATTRIBUTABLE` per una failure gestita.
- **Non può essere `COMPLETED` se:** viene emesso solo `RUN_FAILED`, gli eventi
  precedono falsamente le mutazioni o una source resta sintetizzante senza azione.

### 13.7 FIX 19 — Recovery single-user-lock transaction

- **Scope consentito:** mutua esclusione delle azioni recovery sul dataset dello
  stesso utente e passaggio controllato del lock handle; nessun distributed lock.
- **File presumibili:** `RecoveryManager.js`, `SourceClaimTransaction.js`,
  `JsonMemoryStorage.js` solo se l'API lockHandle esistente non è sufficiente,
  `FileLockManager.js` solo per una incompatibilità dimostrata; test e contratti.
- **Comportamento richiesto:** acquisire un solo user/data lock logico, ricalcolare
  fingerprint e precondition sotto lock, eseguire tutte le mutazioni dataset con
  lo stesso handle, verificare e rilasciare; journalizzare checkpoint idempotenti
  senza inversione user-lock/journal-lock.
- **Invarianti di sicurezza:** nessuna finestra writer tra recheck e ultima azione;
  niente lock annidato dello stesso utente; ordine lock unico documentato; lock
  sempre rilasciato; nessuna promessa di atomicità multi-file.
- **Test nuovi:** writer concorrente bloccato, due recovery concorrenti, piano con
  più azioni, fingerprint cambiato prima/dopo acquire, handle errato, release su
  errore, ordine journal/data lock.
- **Regression test:** claim/fail idempotenti, storage writer concurrency, stale
  lock handling e reconciliation.
- **Failure injection:** race controllata dopo build plan, durante prima/ultima
  azione, journal append failure e release failure; niente sleep fragili.
- **Acceptance criteria:** AUD-P1-002 non è riproducibile; tutte le precondition e
  mutazioni dataset sono nello stesso critical section; test di deadlock verde.
- **Non può essere `COMPLETED` se:** ogni azione riacquisisce il lock, esiste un
  recheck fuori lock, il journal lock è preso prima del data lock o resta una race.

### 13.8 FIX 20 — Recovery composition regression matrix

- **Scope consentito:** test black-box e fixture sintetiche; nessuna correzione
  production nascosta dentro il fix di test.
- **File presumibili:** test recovery/daemon/storage e documentazione della crash
  matrix. Se una riproduzione fallisce, il fix resta bloccato e genera un nuovo
  intervento production separato.
- **Comportamento richiesto:** dimostrare insieme privacy, multi-cluster,
  lifecycle terminale, lock unico, replay e reconciliation storage-first.
- **Invarianti di sicurezza:** solo `os.tmpdir()`, nessuna rete/provider reale,
  nessun dato reale, nessun test che duplichi banalmente la struttura interna.
- **Test nuovi:** tutte le riproduzioni AUD-P1-001…004; crash matrix completa;
  almeno due cluster; recovery e writer concorrenti; repeated recovery.
- **Regression test:** suite FIX 1–19 completa e capability/atomic/lock dedicate.
- **Failure injection:** crash sintetici persistiti, append failure pre/post
  mutazione, provider failure e race deterministiche.
- **Acceptance criteria:** riproduzioni originarie rosse contro la baseline e
  verdi con i fix; nessun falso positivo single-cluster; suite completa verde.
- **Non può essere `COMPLETED` se:** manca una riproduzione P1, si usano sleep
  fragili/dati reali o un test fondamentale verifica soltanto un mock autoreferenziale.

### 13.9 FIX 21 — Persistent recovery status

- **Scope consentito:** osservabilità read-only dello stato journal/recovery dopo
  restart; nessuna recovery automatica.
- **File presumibili:** `HippocampusDaemon.js`, `RecoveryManager.js`, test e
  contratto daemon/recovery.
- **Comportamento richiesto:** API read-only asincrona o cache con stato
  esplicitamente `unknown`; istanza nuova espone incomplete count e
  recovery-required dal persistito senza mutare.
- **Invarianti di sicurezza:** `getStatus` non mente con `false`; nessuna I/O
  mutante; errori journal diventano stato blocked/unknown, non clean.
- **Test nuovi:** restart con run incompleto/completo/corrotto, journal assente,
  inspect failure e scheduler dry-run.
- **Regression test:** API status legacy documentata, no auto-start, preflight.
- **Failure injection:** read/inspect journal fallito o corrotto.
- **Acceptance criteria:** AUD-P2-001 riprodotto e chiuso; stato persistente
  coerente col preflight; compatibilità API esplicitamente documentata.
- **Non può essere `COMPLETED` se:** `incompleteRunCount` resta sempre null senza
  marker unknown o una lettura status effettua recovery/mutazioni.

### 13.10 FIX 22 — Synthetic scale budgets and telemetry

- **Scope consentito:** misurazione e guardrail espliciti della fase plan su dati
  sintetici; nessuna ottimizzazione algoritmica massiva nello stesso intervento.
- **File presumibili:** CandidateSelector/ConsolidationPlan/daemon solo per budget
  e telemetry non sensibile, test performance separati e contratto daemon.
- **Comportamento richiesto:** budget tempo/memoria o cardinalità espliciti e
  configurabili, report dei costi senza contenuti, abort/fail-closed prima di
  pressione non controllata; nessun limite nascosto di cinque.
- **Invarianti di sicurezza:** dry-run soltanto; nessuna source persa o troncata
  silenziosamente; budget non cambia eleggibilità semantica.
- **Test nuovi:** 40.000 record sintetici in temp, superamento budget, telemetry,
  assenza di slice implicito e dataset piccoli invariati.
- **Regression test:** candidate selection, consolidation plan, daemon dry-run.
- **Failure injection:** budget scaduto/memoria stimata ecceduta e report sink
  fallito.
- **Acceptance criteria:** limiti operativi scelti e documentati prima del dry-run
  DEV; benchmark ripetibile non vincolante; nessuna regressione funzionale.
- **Non può essere `COMPLETED` se:** il guardrail tronca, introduce un default
  arbitrario o il dry-run DEV può partire senza budget espliciti.

### 13.11 FIX 23 — Vector hydration and stale-point verification

- **Scope consentito:** adapter di hydration opzionale tra vector search e JSON
  autorevole; nessuna integrazione automatica nel RecallRouter.
- **File presumibili:** nuovi moduli/test vector e contratto vector; runtime,
  daemon e storage esistenti restano invariati salvo autorizzazione successiva.
- **Comportamento richiesto:** risolvere point ID nel JSON, verificare entity ID,
  content hash e kind, scartare stale/mancanti, restituire viste minimali.
- **Invarianti di sicurezza:** JSON autorevole; niente testo nel payload vector;
  failure provider non modifica JSON; vector path disabilitabile.
- **Test/failure injection:** point stale, missing, cross-user, hash mismatch,
  duplicate, provider timeout e JSON lookup failure; regressione FIX 15.
- **Acceptance criteria:** nessun risultato vector raggiunge un retriever senza
  hydration verificata.
- **Non può essere `COMPLETED` se:** il payload vector è trattato come memoria o
  il provider diventa autorevole. È rinviabile finché il vector path è spento.

### 13.12 FIX 24–26 — Interventi rinviabili

- **FIX 24:** aggiungere, senza riscrivere la sezione storica 11, un prospetto
  corrente resolved/mitigated/open dopo l'audit di chiusura. Test: link e stati
  coerenti. Non completare se altera storia o dichiara risolti finding aperti.
- **FIX 25:** refactor esclusivamente meccanico di RecoveryManager e relativi test,
  dopo FIX 19–20. Failure injection e suite devono restare semanticamente
  identici; non completare con diff comportamentale o coverage ridotta.
- **FIX 26:** refactor esclusivamente meccanico del vector adapter e test, dopo
  FIX 23 se eseguito. Non completare se cambia provider contract, payload, score,
  timeout o principio non autorevole.

La separazione FIX 25/FIX 26 evita un refactor trasversale difficile da
riesaminare o annullare.

### 13.13 FIX 27 — Post-remediation closure audit

Audit indipendente, read-only e non correttivo dopo l'ultimo fix obbligatorio.
Deve includere:

1. suite completa e `node --check` dei moduli coinvolti;
2. riproduzioni originarie AUD-P1-001…004 e AUD-P2-001/002/003;
3. baseline/finale di size, mtime e SHA-256 dei dati reali;
4. zero P0 e zero P1 aperti o regressi;
5. scansione strutturale e su file della privacy journal;
6. due recovery e writer concorrenti sotto unico lock logico;
7. run multi-cluster con crash a ogni phase boundary;
8. lifecycle terminale dopo provider, synthesis, claim, commit e append failure;
9. repeated recovery senza revision/eventi/super-memory duplicati;
10. verifica che commit reale e Activation Gate restino disabilitati.

Il verdetto deve essere `READY_FOR_ACTIVATION_GATE`, `READY_WITH_BLOCKERS` o
`NOT_READY`. FIX 27 non può essere `COMPLETED` se la suite non è verde, i dati
cambiano, una riproduzione originaria fallisce, resta un P0/P1, privacy o lock
non sono dimostrati, oppure il dry-run non ha guardrail operativi espliciti.

### 13.14 Criteri per iniziare l'Activation Gate

L'Activation Gate può essere proposto, non avviato automaticamente, soltanto se:

- FIX 16–22 e FIX 27 sono `COMPLETED` con evidenza riproducibile;
- il closure audit dichiara zero P0/P1 e dati reali invariati;
- il worktree FIX 1–22 è protetto da un checkpoint Git controllato separato;
- journal/lock directory, permessi, spazio, backup e recovery runbook sono scelti;
- provider embedding e Qwen/Ollama hanno endpoint e versioni espliciti;
- processing legacy/eleggibilità e maturity approval sono decisioni esplicite;
- synthesis limits e `maxClustersPerRun` sono configurati;
- smoke test RecallRouter, dry-run DEV, review umana, staging e canary restano fasi
  distinte con autorizzazioni separate;
- FIX 23 è completato oppure il vector path è dichiarato disabilitato.

Il prossimo intervento consigliato è **FIX 16 — Journal claim privacy boundary**.
È indicato come `PENDING`: non è iniziato e non è autorizzata alcuna modifica di
codice da questa pianificazione.

### 2026-07-13 — Pianificazione remediation post-audit

È stata completata esclusivamente la fase di triage read-only dei 10 finding del
post-implementation audit (0 P0, 4 P1, 4 P2, 2 P3). È definita la queue FIX
16–27, con otto interventi obbligatori prima dell'Activation Gate: FIX 16–22 e
FIX 27. Nessun finding è marcato risolto, nessun fix è stato iniziato e
`HIPPOCAMPUS ACTIVATION GATE` resta non iniziato. Il prossimo intervento
proposto, soggetto a nuova autorizzazione, è FIX 16.

### 2026-07-13 — FIX 16 Journal claim privacy boundary

**Stato:** `COMPLETED`

Il finding `AUD-P1-004` è risolto per i nuovi eventi: `SOURCES_CLAIMED`
journalizza un descriptor V1 chiuso privo di `userId`, mentre RecoveryManager
reintroduce lo scope soltanto in memoria e rivalida il claim operativo. La
validazione privacy attraversa ricorsivamente l'intero evento, normalizza casing
e separatori delle chiavi, rifiuta valori contenenti l'identità configurata e
gestisce cicli senza includere dati privati negli errori.

I journal V1 storici restano leggibili senza migrazione automatica. `inspect()`
segnala soltanto presenza e conteggio degli eventi legacy privacy, senza
riportarne il valore. Recovery plan e report usano il medesimo descriptor sicuro.

Verifica FIX 16:

- 6/6 test privacy dedicati superati;
- 43/43 test combinati privacy, journal, recovery e daemon superati;
- 291/291 test della suite completa FIX 1–16 superati;
- `node --check`, scansione JSONL grezza/ricorsiva e diff check superati;
- file dati reali invariati per SHA-256, dimensione e mtime.

**ADR post-audit:** il claim operativo resta scoped con `userId` soltanto in
memoria; il journal persiste una proiezione versionata senza identità utente e la
recovery la reidrata esclusivamente dallo scope locale già configurato.

Il prossimo intervento è **FIX 17 — Multi-cluster journal correlation**,
`PENDING` e non iniziato. `HIPPOCAMPUS ACTIVATION GATE` resta non iniziato.

### 2026-07-13 — FIX 17 Correlazione journal multi-cluster

**Stato:** `COMPLETED`

Il finding `AUD-P1-001` è risolto. La ricostruzione non aggrega più lo stato dal
solo insieme dei tipi evento del run: crea una state machine separata per ogni
`runId + clusterId`, con correlation key SHA-256 domain-separated, e verifica
claim ID, attempt ID, source set, cluster record ID e transaction ID.

`COMMIT_SUCCEEDED` rende terminale soltanto il cluster correlato. Lo stato run
espone cluster terminali, incompleti e bloccati e accetta una chiusura soltanto
in presenza di un terminale run-level esplicito coerente con tutti i cluster
osservati. Il numero atteso non viene inventato. Eventi interleaved mantengono
sequence globale e subsequence per cluster; correlazioni condivise, ordine
contraddittorio o terminali prematuri sono bloccati fail-closed.

Recovery costruisce azioni per il solo cluster incompleto. Un cluster già
committato non viene riscritto; la chiusura recovery del run è un checkpoint
separato e idempotente. Journal V1 restano leggibili, mentre sequenze legacy non
correlabili sono segnalate e bloccate senza migrazione automatica. Le garanzie
privacy di FIX 16 restano attive.

Verifica FIX 17:

- 9/9 test multi-cluster dedicati superati;
- 52/52 test combinati FIX 17, privacy, journal, recovery e daemon superati;
- 300/300 test della suite completa FIX 1–17 superati;
- coperti A committed/B claimed, ordine inverso, interleaving, 12 cluster,
  replay, repeated recovery, correlazioni contraddittorie e legacy ambiguo;
- scansione privacy JSONL/ricorsiva, `node --check` e diff check dedicato superati;
- file dati reali invariati per SHA-256, dimensione e mtime.

**ADR post-audit:** il journal mantiene sequence globale ma deriva lifecycle
indipendenti per cluster; nessun terminale cluster implica un terminale run, e
la chiusura run richiede un evento esplicito validato contro tutti i cluster
osservati.

Il prossimo intervento è **FIX 18 — Terminal failure lifecycle**, `PENDING` e
non iniziato. `HIPPOCAMPUS ACTIVATION GATE` resta non iniziato.

### 2026-07-13 — FIX 18 Lifecycle terminale delle failure

**Stato:** `COMPLETED`

Il finding `AUD-P1-003` è risolto. Dopo un claim, una failure ordinaria di
synthesis journalizza `SYNTHESIS_FAILED`, porta in modo persistente e verificato
tutte le source da synthesizing a failed e solo allora journalizza
`SOURCES_FAILED`. Timeout, eccezione provider, risposta non-ok, JSON invalido e
schema/provenance invalida seguono lo stesso lifecycle sanitizzato.

`SOURCES_FAILED` è il terminale del singolo cluster fallito;
`SYNTHESIS_FAILED` e `COMMIT_FAILED` sono eventi causali non terminali. Un
`RUN_FAILED` run-level viene emesso soltanto dopo che ogni cluster osservato è
terminale e coerente, preservando la correlazione multi-cluster del FIX 17 sia
con stop-on-failure sia con continue-on-failure.

La perdita dell'append prima della transizione non crea un falso terminale. La
perdita dell'ACK dopo source già failed verificate restituisce
`NEEDS_RECONCILIATION`; recovery riconosce lo stato storage-first e completa il
journal senza una seconda transizione, un secondo incremento revision o una
seconda super-memory. Stati non dimostrabili restano incompleti/bloccati.

Verifica FIX 18:

- 11/11 test lifecycle failure dedicati superati;
- 63/63 test combinati FIX 18, FIX 17, privacy, journal, recovery e daemon
  superati;
- 311/311 test della suite completa FIX 1–18 superati, senza fail o skip;
- failure injection su append pre/post mutazione, write source, provider e
  content-hash mismatch superate;
- scansione privacy JSONL/report, `node --check` e diff check dedicato superati;
- file dati reali invariati per SHA-256, dimensione e mtime.

**ADR post-audit:** una failure cluster diventa terminale soltanto con
`SOURCES_FAILED` dopo verifica dello storage; un terminale run è separato e
validato contro tutti i cluster osservati. La perdita di un ACK non viene
mascherata né compensata invertendo lo stato dati, ma richiede riconciliazione
storage-first idempotente.

Il prossimo intervento è **FIX 19 — Recovery single-user-lock transaction**,
`PENDING` e non iniziato. `HIPPOCAMPUS ACTIVATION GATE` resta non iniziato.

### 2026-07-13 — FIX 19 Recovery sotto un unico lock logico utente

**Stato:** `COMPLETED`

Il finding `AUD-P1-002` è risolto. `executeRecovery()` acquisisce una sola volta
il medesimo lock logico per utente usato da tutti i writer JsonMemoryStorage,
rilegge sotto lock journal, memoria e cluster, rivalida fingerprint e piano,
esegue ogni mutazione con lo stesso handle e verifica lo stato finale prima
della release. Handle di altro utente, manager o owner sono rifiutati.

Un cambiamento avvenuto mentre la recovery attende il lock produce
`STALE_RECOVERY_PLAN` prima di qualsiasi mutazione. Writer memory/link/cluster e
recovery concorrenti dello stesso utente sono serializzati; utenti differenti
restano indipendenti. Nessun provider o attesa esterna entra nella critical
section.

Gli ACK journal vengono costruiti e appesi soltanto dopo la release del user
lock, evitando lock annidati e inversioni. Una failure ACK dopo mutazioni valide
restituisce `NEEDS_RECONCILIATION`; il retry storage-first non incrementa di
nuovo revision e non crea super-memory. Una failure dati interrompe le azioni
successive e, per le mutazioni memory V1, ripristina e verifica lo snapshot sotto
lo stesso handle; rollback o release non verificabili producono stato
`UNKNOWN/BLOCKED` esplicito.

Verifica FIX 19:

- 13/13 test single-user-lock dedicati superati;
- 129/129 test combinati FIX 16–19, daemon, journal, recovery, storage, lock e
  transaction superati;
- 324/324 test della suite completa FIX 1–19 superati, senza fail o skip;
- failure injection dopo acquire/recheck/prima e dopo mutazione, verifica finale,
  release e append ACK superate;
- scansione privacy JSONL/ricorsiva, `node --check` e diff check dedicato
  superati;
- file dati reali invariati per SHA-256, dimensione e mtime.

**ADR post-audit:** la recovery mutante è una critical section unica sul lock
utente dalla rilettura delle precondition alla verifica finale; gli ACK journal
sono checkpoint successivi e idempotenti, mai eseguiti mentre il data lock è
detenuto.

Il prossimo intervento è **FIX 20 — Recovery composition regression matrix**,
`PENDING` e non iniziato. `HIPPOCAMPUS ACTIVATION GATE` resta non iniziato.

### 2026-07-13 — FIX 20 Recovery composition regression matrix

**Stato:** `COMPLETED`

Il finding `AUD-P2-002` è risolto con una matrice end-to-end di 45 righe
obbligatorie (`A01`–`G45`). Un registry eseguibile fallisce in presenza di ID
mancanti, duplicati o sconosciuti. Gli scenari compongono le implementazioni
reali di storage, lock, journal, recovery, daemon, source claim, transaction,
processing, cluster persistence e synthesis; soltanto provider, clock e failure
injection sono sintetici.

La matrice dimostra happy path singolo/multi-cluster e 12 cluster senza limite
implicito di cinque; failure provider e lifecycle terminale; crash, restart e
riconciliazione storage-first; correlazione interleaved; writer concorrenti e
unico user lock; privacy ricorsiva/JSONL; rollback, ACK loss e replay senza
doppie revisioni o super-memory. Raw, timestamp storici e campi sconosciuti
restano preservati. Tutte le scritture avvengono sotto `os.tmpdir()`.

Verifica FIX 20:

- 45/45 righe registrate, 18/18 test TAP della matrice superati;
- 147/147 test mirati FIX 16–20, storage, lock, transaction, journal, recovery e
  daemon superati;
- 342/342 test della suite completa FIX 1–20 superati, senza fail o skip;
- scansione privacy ricorsiva e JSONL grezza superata;
- `node --check` e diff check dedicato superati;
- file dati reali invariati per SHA-256, dimensione e mtime.

Non è emerso alcun difetto riproducibile nel codice di produzione e il FIX 20
non lo ha modificato. La matrice completa è documentata in
`docs/contracts/HIPPOCAMPUS_RECOVERY_TEST_MATRIX_V1.md`.

**ADR post-audit:** le garanzie recovery non sono considerate dimostrate da
primitive isolate: privacy, correlazione, lifecycle, storage-first, lock e
idempotenza devono restare verdi nella stessa matrice compositiva con registry
obbligatorio degli scenari.

Il prossimo intervento è **FIX 21 — Persistent recovery status**, `PENDING` e
non iniziato. `HIPPOCAMPUS ACTIVATION GATE` resta non iniziato.

### 2026-07-13 — FIX 21 Status recovery persistente dopo restart

**Stato:** `COMPLETED`

Il finding `AUD-P2-001` è risolto. `getStatus()` non deriva più recovery dal
solo ultimo report RAM e non dichiara `false` prima di una verifica: una nuova
istanza espone `statusHydrated: false`, `recoveryState: unknown` e
`recoveryRequired: null`. Il costruttore resta privo di I/O.

La nuova API esplicita read-only `refreshStatus()` idrata una cache RAM
sanitizzata da journal, `RecoveryManager.inspect()`, snapshot storage e recovery
plan dry-run. Gli stati stabili sono `unknown`, `ready`, `recovery_required`,
`needs_reconciliation`, `blocked` e `corrupt`; contatori, tail, stale lock,
validità journal, privacy legacy e inspection time sono esposti senza ID o
payload privati. Nessun file status parallelo è stato introdotto.

Ogni commit forza una nuova ispezione e accetta soltanto `ready`; una cache
precedente non può autorizzarlo. Dry-run aggiorna lo status senza mutazioni.
Source failed o commit validi senza ACK restano `needs_reconciliation` dopo
restart; dopo recovery, soltanto un nuovo refresh persistente porta a ready.
Refresh concorrenti sono ordinati da una generation locale: un risultato lento
più vecchio non sovrascrive quello più recente. `getStatus()` restituisce copie
profondamente congelate.

Verifica FIX 21:

- 17/17 test status persistente dedicati superati;
- 164/164 test mirati FIX 16–21, matrice FIX 20, daemon, journal, recovery,
  storage, lock e transaction superati;
- 359/359 test della suite completa FIX 1–21 superati, senza fail o skip;
- coperti restart incompleto e multi-cluster, ACK source/commit mancanti,
  recovery completata, journal ambiguo/corrotto, tail, stale lock, preflight
  stale-cache, dry-run, race refresh e privacy;
- `node --check`, scansione privacy e diff check dedicato superati;
- 11 file dati reali invariati per SHA-256, dimensione e mtime.

**ADR post-audit:** lo status recovery del daemon è una proiezione read-only e
non autorevole; nasce unknown, diventa ready soltanto dopo ispezione persistente
e viene sempre rivalidato prima di un commit. La cache usa generation locale ma
non sostituisce journal o JSON.

Il prossimo intervento è **FIX 22 — Synthetic scale budgets and telemetry**,
`PENDING` e non iniziato. `HIPPOCAMPUS ACTIVATION GATE` resta non iniziato.

### 2026-07-13 — FIX 22 Budget e telemetria sintetici di scala

**Stato:** `COMPLETED`

Il finding `AUD-P2-003` è risolto. Candidate selection usa una proiezione
validata minimale condivisa col normalizzatore: non materializza
`sourceSnapshot`, meta, entities o content object e conserva il testo soltanto
fino al calcolo SHA-256 UTF-8 esatto. La costruzione scalabile riusa selection e
array già frozen, evitando copie e validazioni interne ridondanti.

Le nuove API `selectConsolidationCandidatesScalable()` e
`buildConsolidationPlanScalable()` elaborano batch configurabili con deduplica
globale. `batchSize` è solo un controllo operativo e resta distinto da
`maxCandidates`: 40.000 input producono 40.000 decisioni. API legacy e scalabile
condividono la semantica e producono lo stesso `planId` per ordine, contenitore e
batch size differenti. Il daemon usa il nuovo percorso esclusivamente nel
dry-run e non aggiunge provider o write.

Il budget V1 pubblico è batch 500, massimo 9.500 ms e massimo 128 MiB RSS
incrementale. La telemetria frozen registra solo contatori, tempo, RSS, budget e
versione algoritmo; non contiene ID, testi, hash, user ID o path e non partecipa
al `planId`. Un abort tra batch rifiuta senza restituire un piano parziale.

Benchmark sintetico riproducibile, Node v18.19.1 Linux x64, 40.000 record e tre
run:

- baseline locale pre-modifica: mediana 12.227 ms; primo incremento RSS 167 MiB
  (baseline audit: circa 9.500 ms/+252 MiB);
- percorso FIX 22: mediana 2.888 ms, RSS mediana 24,7 MiB, massimo incremento
  osservato 93,3 MiB;
- 40.000/40.000 decisioni, stesso planId nei tre run, budget superato.

Verifica FIX 22:

- 30/30 test candidate/plan legacy e scalabili superati, incluso dataset da
  40.000 record, cross-batch dedup, abort e daemon dry-run;
- runner di scala a tre run superato entro entrambi i budget;
- 55/55 test mirati matrice FIX 20, daemon, journal e recovery superati;
- 369/369 test della suite completa FIX 1–22 superati, senza fail o skip;
- `node --check`, privacy della telemetria e diff check dedicato superati;
- 11 file dati reali invariati per SHA-256, dimensione e mtime.

Il contratto e il runner sono documentati in
`docs/contracts/HIPPOCAMPUS_SCALE_BUDGET_V1.md`.

**ADR post-audit:** il batching della candidate selection è operativo e non
semantico; la deduplica resta globale e la telemetria non autorevole non entra
mai nell'identità deterministica del consolidation plan.

Il prossimo intervento obbligatorio è **FIX 27 — Post-remediation closure
audit**, `PENDING` e non iniziato. FIX 23 resta rinviato finché il vector path è
spento. `HIPPOCAMPUS ACTIVATION GATE` resta non iniziato.

### 2026-07-13 — FIX 27 Audit indipendente di chiusura remediation

**Stato:** `COMPLETED`

L'audit non correttivo è registrato in
`docs/HIPPOCAMPUS_REMEDIATION_CLOSURE_AUDIT.md`. La verifica indipendente ha
riprodotto i finding obbligatori, ispezionato codice e test, eseguito le suite
dedicate FIX 16–22, la matrice A01–G45, la regressione completa e il benchmark
sintetico da 40.000 record. Le transizioni operative del fix sono state
`running` durante l'ispezione, `verified` dopo suite/benchmark e `completed`
soltanto dopo il confronto finale dei dati.

**Verdetto:** `READY_FOR_ACTIVATION_GATE`.

- P0 aperti: 0;
- P1 aperti: 0;
- P2 aperti: 1, `AUD-P2-004`, isolato e condizionale al vector path;
- P3 aperti: 2, documentazione/manutenibilità rinviabili;
- `AUD-P1-001`, `AUD-P1-002`, `AUD-P1-003`, `AUD-P1-004`, `AUD-P2-001`,
  `AUD-P2-002` e `AUD-P2-003` risultano risolti;
- suite FIX 16–22: 84/84; matrice FIX 20: 18/18; suite completa: 369/369;
- benchmark Node v18.19.1 Linux x64, 40.000 record, batch 500 e tre run:
  mediana 2.800 ms, massimo RSS incrementale 96.964.608 byte, budget V1
  superato con esito positivo;
- 11 file dati reali invariati per SHA-256, dimensione e mtime;
- nessun codice, test, contratto o dato è stato corretto durante l'audit.

FIX 23 resta condizionale: prima di qualunque abilitazione vector serviranno
hydration e verifica stale-point contro il JSON autorevole. Con vector path
esplicitamente disabilitato non blocca l'Activation Gate. L'Activation Gate può
essere pianificato, ma non è stato iniziato né eseguito da FIX 27.

### 2026-07-13 — ACTIVATION GATE DEV / AG-1 Provider & Environment Preflight

**Stato:** `AG1_BLOCKED_MISSING_ADAPTER`

L'Activation Gate DEV è iniziato esclusivamente nella fase AG-1 read-only. Il
preflight è documentato in `docs/HIPPOCAMPUS_ACTIVATION_GATE_DEV.md`.

Node v18.19.1 e Ollama 0.20.5 sono disponibili; il servizio locale era già in
ascolto su loopback e `ollama list` ha rilevato `qwen3.5:4b`, `gemma4:e2b` e
`gemma4:e4b`. Nessun modello è stato invocato, caricato o scaricato. I modelli
elencati dichiarano capability completion ma non embedding.

AG-1 ha confermato che nel repository non esistono adapter concreti compatibili
con il provider embedding di ClusterEngineAdapter o con il provider chiuso di
SynthesisEngine. Il transport streaming della chat e i prototipi non sono
riutilizzabili: possiedono forma, fallback e confini runtime incompatibili.
Prima di AG-2 servono quindi due adapter minimali, un modello embedding locale
esplicitamente approvato e un runner sintetico isolato sotto `/tmp`.

Il vector path resta esplicitamente disabilitato e fuori scope. Server, chat,
provider, daemon e dati reali non sono stati avviati o modificati; non è stato
eseguito alcun commit Ippocampo o Git. Gli 11 file dati inventariati risultano
invariati per SHA-256, dimensione e mtime.

La fase prevista successiva è **AG-2 Synthetic live-provider smoke test**, ma
non è iniziata perché AG-1 è bloccato sul cablaggio provider. Non è stato creato
alcun FIX 28.

### 2026-07-14 — ACTIVATION GATE DEV / Qwen Synthesis Provider

**Stato:** `QWEN_SYNTHESIS_LIVE_SMOKE_PASSED`

Senza creare un nuovo FIX numerato è stato aggiunto il provider concreto
`core/providers/ollama/OllamaSynthesisProvider.js`, compatibile con la forma
chiusa del SynthesisEngine. Usa l'endpoint `/api/chat`, modello esplicito
`qwen3.5:27b`, output non-streaming JSON, `think:false`, keep-alive e timeout
espliciti. URL con credenziali, redirect, response non JSON/oversize/parziale e
modello dichiarato differente falliscono chiusi. Nessun fallback può essere
configurato o invocato.

Il trasporto streaming della chat è stato soltanto ispezionato. Primary,
fallback Ollama, fallback OpenAI, payload, parsing e semantica della chat non
sono stati modificati. Hippocampus non importa l'entry point chat e non eredita
il fallback `gemma4:e2b` del portatile.

I 18 test dedicati con server HTTP loopback temporanei sono tutti superati.
Coprono payload, response, provenance modello/versione, timeout/abort/rete,
status retryable e non-retryable, JSON/schema, limiti, redirect, privacy,
integrazione SynthesisEngine e costruzione SuperMemoryRecord sotto
`os.tmpdir()`. I raw sintetici restano byte-invariati e un server fallback
sentinella riceve zero chiamate.

La live smoke reale è stata eseguita una sola volta tramite
`scripts/qwen-synthesis-live-smoke.js`, dopo che il preflight remoto ha
qualificato endpoint e tag esatto `qwen3.5:27b`. L'endpoint resta sanitizzato in
questo log. Il provider reale ha ricevuto dal modello dichiarato
`qwen3.5:27b` JSON strutturato valido; SynthesisEngine ha completato la sintesi
e una SuperMemoryRecord temporanea valida è stata costruita esclusivamente
sotto `os.tmpdir()`, poi eliminata. Durata osservata: 11,835 secondi. Nessun
fallback e nessun commit sono stati invocati; repository e dati reali sono
rimasti invariati durante la smoke. La regressione repository eseguita dopo la
smoke è passata con 388/388 test, zero fail, skip o cancellazioni; i check
sintattici di script, provider ed engine sono passati.

BGE-M3, embedding, clustering globale, i 40.000 ricordi, daemon automatico,
scheduler e Activation Gate complessivo restano non collegati e non completati.
Il confronto finale conferma **11/11 file dati reali invariati** per SHA-256,
size e mtime. La regressione completa post-smoke è 388/388 e la suite provider dedicata è
18/18; syntax e whitespace/diff check dei file nuovi sono superati. Non è stato
eseguito alcun commit Git.

### 2026-07-14 — ACTIVATION GATE DEV / BGE-M3 Embedding Provider

**Stato:** `BGE_M3_PROVIDER_READY_LIVE_SMOKE_DEFERRED_MISSING_ENV`

È stato aggiunto un provider embedding batch dedicato e non integrato nel
daemon o nel ClusterEngine. La configurazione richiede endpoint e API key
espliciti; modello `BAAI/bge-m3`, revisione, dimensione 1024 e
`normalized:true` sono vincoli chiusi. Non esistono endpoint fallback né retry
automatici. Timeout, rete e status temporanei sono classificati retryable;
autenticazione, provenance e contratto invalidi falliscono come non-retryable.

Il provider calcola il contentHash SHA-256 sul testo UTF-8, valida cardinalità,
ID, hash, dimensione, valori finiti e norma con tolleranza assoluta `1e-3`, e
riordina il risultato secondo la richiesta. Body limit, content type, redirect
e JSON sono verificati prima del contratto. Errori e output diagnostici non
contengono API key, testi o embedding.

Lo schema OpenAPI pubblico è stato ispezionato senza credenziali e il provider
è stato allineato al contratto reale `items` / `items[].embedding`. Il preflight
pubblico `/health` ha confermato modello, revisione, dimensione, modello caricato
e CUDA. La live smoke sintetica separata non è stata eseguita perché le
variabili ambiente esplicite non erano presenti nella shell; non è stato quindi
effettuato alcun POST embedding e non sono disponibili valori di similarità.

Verifica:

- 18/18 test provider con server HTTP loopback superati;
- 406/406 test della suite repository serializzata superati, senza fail o skip;
- check sintattici di provider, test e live-smoke superati;
- nessun wiring verso daemon o ClusterEngine;
- nessun fallback, daemon, commit o accesso ai dati reali;
- nessun IP, segreto, testo personale o embedding registrato.

### 2026-07-14 — FIX EC-1 — Hippocampus embedding cache identity and payload

**Stato:** `VERIFIED` — `EC1_PASSED`

È stato implementato esclusivamente il record puro e deterministico della
futura cache embedding Ippocampo. La collection approvata è dichiarata come
`memoria_orbitale_hippocampus_embedding_cache_v1`, senza provisioning o accesso
a Qdrant. Memoria Orbitale resta autorevole e il vector path storico non è
stato importato, modificato o abilitato.

`EmbeddingCacheRecord` chiude schema, modello `BAAI/bge-m3`, revisione
`5617a9f61b028005a4858fdac845db406aefb181`, dimensione 1024,
`normalized:true` e tolleranza norma `1e-3`. L'identità usa componenti UTF-8
length-prefixed, userId hashato, SHA-256 logico completo e UUID deterministico
version 5 derivato dai primi 128 bit. Il payload conserva il full hash come
collision guard e non contiene userId chiaro, testo, timestamp o metadata
operativi.

Il vettore viene validato prima e dopo `Math.fround()`. Il fingerprint è SHA-256
dei 4096 byte IEEE-754 float32 little-endian, coerente con la rappresentazione
prevista per Qdrant, senza normalizzazione o correzione silenziosa.

Artifact:

- `core/hippocampus/embedding-cache/EmbeddingCacheRecord.js`;
- `docs/contracts/HIPPOCAMPUS_EMBEDDING_CACHE_V1.md`;
- `test/hippocampus/embedding-cache-record.test.js`.

Verifica:

- `node --check` sui due file JavaScript nuovi superato;
- test EC-1 isolati: 16/16 superati;
- suite repository serializzata, eseguita una sola volta: 421/421 superati,
  zero fail, skip o cancellazioni;
- diff/whitespace check superato;
- nessuna rete, chiamata BGE-M3/Qdrant, configurazione, daemon, provisioning,
  commit o accesso ai dati reali.

EC-1 è `VERIFIED`; non viene marcato automaticamente `COMPLETED`. Provider,
collection lifecycle, cache lookup/upsert, batching e wiring restano FIX futuri
separati.

### 2026-07-14 — FIX EC-2 — Qdrant embedding cache provider isolato

**Stato:** `VERIFIED` — `EC2_PASSED`

È stato aggiunto esclusivamente il transport infrastrutturale
`QdrantEmbeddingCacheProvider`, configurato per costruzione esplicita con
endpoint, API key opzionale, timeout, limite risposta e provider ID. Il modulo
non legge ambiente o configurazioni globali, non importa EC-1, storage, daemon
o vector path storico e non decide collection, dimensione, distanza, point ID,
payload applicativo, hit/miss o stale.

L'API pubblica V1 espone soltanto `health`, `getCollectionInfo`,
`createCollection`, `createPayloadIndex`, `retrievePoints`, `upsertPoints`,
`searchPoints` e `scrollPayload`. Non esistono delete, clear, recreate, migrate,
fallback o retry automatici. `searchPoints` usa esplicitamente il mapping REST
Qdrant `/collections/{collection}/points/search`; l'upsert usa `wait=true`.

Endpoint e collection sono validati prima del trasporto, i path sono costruiti
internamente e URL-encoded, redirect vietati, header `api-key` emesso soltanto
quando configurato e tutte le request richiedono un `AbortSignal`. Timeout e
abort chiamante sono distinti; listener e timer vengono rimossi. Content-Type,
Content-Length, limite streaming, UTF-8, JSON ed envelope Qdrant sono verificati
senza esporre response raw, endpoint, credenziali, vector o payload negli
errori. Solo il 404 Qdrant riconoscibile come collection assente viene
normalizzato in `{ exists:false }`.

La tassonomia classifica timeout, rete/reset, 408/429/502/503/504 come
retryable; configurazione/request invalide, 400/401/403/404 ordinari, redirect,
body/content-type/JSON/envelope e risultati malformati come non-retryable.
Questa classificazione non esegue retry.

Artifact:

- `core/providers/vector/QdrantEmbeddingCacheProvider.js`;
- `test/providers/qdrant-embedding-cache-provider.test.js`.

Verifica:

- `node --check` sui due file nuovi superato;
- test EC-2 isolati con soli server HTTP loopback simulati: 19/19 superati;
- suite repository serializzata, eseguita una sola volta: 440/440 superati,
  zero fail, skip o cancellazioni;
- diff/whitespace check superato;
- nessuna chiamata Qdrant reale o BGE-M3, collection, provisioning,
  configurazione, daemon, commit, cancellazione o accesso ai dati reali.

EC-2 è `VERIFIED`; non viene marcato automaticamente `COMPLETED`. Collection
lifecycle e provisioning restano separati e non sono autorizzati da questo fix.

### 2026-07-14 — FIX EC-3 — Hippocampus embedding cache collection lifecycle

**Stato:** `VERIFIED` — `EC3_PASSED`

È stato aggiunto esclusivamente il lifecycle della collection dedicata
`memoria_orbitale_hippocampus_embedding_cache_v1`. L'adapter importa da EC-1
schema V1, nome collection e dimensione 1024, usa distanza `Cosine` e riceve
esplicitamente il provider EC-2 senza leggere ambiente o configurazioni
globali. L'unica operazione pubblica di lifecycle è `ensureCollection`.

Il comportamento predefinito è inspect-only: una collection assente o indici
mancanti producono un risultato non-ready senza scritture. Dimensione,
distanza, vector configuration, payload schema, tipo indice o response shape
non verificabili falliscono chiusi con `COLLECTION_INCOMPATIBLE`. Named vector,
multi-vector e configurazioni ambigue non sono accettate.

La creazione richiede contemporaneamente `allowCreate:true` e il token esatto
`CREATE_HIPPOCAMPUS_EMBEDDING_CACHE_V1`. Gli otto indici obbligatori vengono
creati soltanto se mancanti, sequenzialmente e in ordine lessicografico:
keyword per `content_hash`, `embedding_model`, `embedding_revision`,
`logical_key_hash`, `memory_id`, `user_id_hash`; bool per `normalized` e integer
per `schema_version`. `vector_fingerprint` non viene indicizzato. Dopo ogni
creazione collection e al termine del provisioning il contratto viene
riletto; `ready:true` è restituito soltanto dopo verifica completa.

Un conflitto 409 di creazione collection o indice ammette esclusivamente una
re-ispezione puntuale e verificata, senza retry generico. Una collection creata
da un altro processo non produce `created:true`. Non sono esposte operazioni di
delete, recreate, migrate, rename o cleanup e non viene collegato il vector path
storico.

Artifact:

- `core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter.js`;
- `test/hippocampus/embedding-cache-collection-lifecycle.test.js`.

Verifica:

- `node --check` sui due file JavaScript nuovi superato;
- test EC-3 isolati con provider esclusivamente in-memory: 22/22 superati;
- suite repository serializzata, eseguita una sola volta: 462/462 superati,
  zero fail, skip o cancellazioni;
- nessuna rete reale, chiamata Qdrant/BGE-M3, collection, provisioning reale,
  configurazione, storage, daemon, commit, cancellazione o accesso ai dati
  reali.

EC-3 è `VERIFIED`; non viene marcato automaticamente `COMPLETED`. Lookup,
hit/miss, stale, upsert e search restano FIX futuri separati.

### 2026-07-14 — FIX EC-4 — Exact cache lookup e single-point upsert

**Stato:** `VERIFIED` — `EC4_PASSED`

L'adapter espone `getValidEmbedding` e `upsertEmbedding` con request chiuse e
`AbortSignal` obbligatorio. Identità, point ID, vettore float32, payload e
fingerprint sono costruiti o validati esclusivamente tramite EC-1, con modello
e revisione vincolati. Prima di ogni retrieve e upsert viene eseguito
`ensureCollection({ allowCreate:false, signal })`; una collection non ready
produce `COLLECTION_NOT_READY` e nessuna write.

Il lookup usa `retrievePoints` per il solo point ID, con payload e vettore. Zero
point è l'unico caso `POINT_NOT_FOUND`; point inattesi o duplicati, response
ambigue, payload alterati, conflitti del full logical hash, vettori invalidi e
fingerprint discordanti falliscono chiusi. Un hit viene restituito soltanto
dopo verifica completa e contiene il solo embedding float32 canonico, senza
payload raw.

L'upsert valida tutto prima del provider. Un hit con lo stesso fingerprint è
un replay idempotente e non scrive; un point preesistente incompatibile non
viene sovrascritto. Un miss produce un solo point, richiede acknowledgement
verificabile e viene sempre riletto e verificato prima di dichiarare
`created:true`. Una rilettura mancante, differente o invalida produce
`UPSERT_VERIFICATION_FAILED`; non esistono retry automatici, delete o rollback
distruttivi.

Upsert Qdrant non offre un CAS completo: richieste concorrenti sullo stesso
point e fingerprint convergono semanticamente sul medesimo record, mentre una
race incompatibile rilevata dalla verifica finale fallisce chiusa. Non viene
promessa atomicità globale e nessun lock Qdrant è interpretato come lock della
memoria.

Artifact:

- `core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter.js`;
- `test/hippocampus/embedding-cache-exact-operations.test.js`.

Verifica:

- `node --check` su adapter e test EC-4 superato;
- test EC-4 isolati con provider esclusivamente in-memory: 19/19 superati;
- suite repository serializzata, eseguita una sola volta: 481/481 superati;
- nessuna rete reale, chiamata Qdrant/BGE-M3, collection, provisioning reale,
  configurazione globale, storage, daemon, commit, cancellazione o accesso ai
  dati reali.

EC-4 è `VERIFIED`; non viene marcato automaticamente `COMPLETED`. Batch,
neighbor search, stale scan, wiring e daemon restano fuori scope.

### 2026-07-15 — FIX EC-5 — BGE-M3 embedding cache coordinator bounded-memory

**Stato:** `VERIFIED` — `EC5_PASSED`

È stato aggiunto `BgeM3EmbeddingCacheCoordinator`, costruito esplicitamente con
cache adapter EC-4, provider BGE-M3, batch size e provenance fissata. Request e
item sono chiusi, l'`AbortSignal` è obbligatorio, la lista contiene da 1 a 4096
item e `embeddingBatchSize` è un intero tra 1 e 128. Prima di qualsiasi
dipendenza vengono verificati l'intero input, SHA-256 UTF-8 del testo, identità
EC-1, point ID e assenza di duplicati logici.

Il lavoro viene ordinato per point ID. I lookup cache sono exact e sequenziali:
gli hit non raggiungono BGE, mentre soltanto i miss entrano nei batch. Il
coordinator chiama il contratto chiuso `embedBatch({items:[{id,text}],signal})`;
il provider BGE-M3 calcola e invia internamente il `contentHash`. Il coordinator
rivalida completezza, ID, hash e vettori 1024D normalizzati tramite EC-1 prima
di delegare ogni upsert all'adapter, che mantiene acknowledgement e verifica
post-write EC-4.

I batch BGE sono strettamente sequenziali e limitati a
`embeddingBatchSize`. Non viene usato `Promise.all`; completato un upsert, i
riferimenti interni a user ID, testo e vettore vengono eliminati prima di
avanzare. Il massimo teorico mantenuto dal coordinator per un batch è
`embeddingBatchSize × 1024` valori vettoriali; nessun embedding entra
nell'output. Con 257 miss e batch 64 le chiamate osservate sono
`64/64/64/64/1`.

L'output è ordinato per point ID e contiene soltanto conteggi e identità leggere
con memory ID, content hash, point ID, modello, revisione e stato
`hit|created|replayed`. Batch size e ordine di input non cambiano il risultato
semantico. Errori cache/BGE retryable sono preservati e sanitizzati senza retry,
fallback o modello alternativo.

Un fallimento intermedio non dichiara rollback globale: i batch precedenti già
verificati possono restare in cache. Un rerun li osserva come hit o replay e
materializza soltanto i miss residui. Non sono state aggiunte operazioni batch
cache, delete, rollback distruttivo o promesse transazionali globali;
l'adapter EC-3/EC-4 è rimasto invariato.

Artifact:

- `core/hippocampus/embedding-cache/BgeM3EmbeddingCacheCoordinator.js`;
- `test/hippocampus/bge-m3-embedding-cache-coordinator.test.js`.

Verifica:

- `node --check` su coordinator e test EC-5 superato;
- test EC-5 isolati con dipendenze esclusivamente in-memory: 18/18 superati;
- regressione EC-3/EC-4: 41/41 superati;
- suite repository serializzata, eseguita una sola volta: 500/500 superati,
  zero fail, skip o cancellazioni;
- nessuna rete reale, chiamata Qdrant/BGE-M3, collection, provisioning,
  clustering, sintesi Qwen, storage, daemon, commit o accesso ai dati reali.

EC-5 è `VERIFIED`; non viene marcato automaticamente `COMPLETED`. Wiring,
neighbor search, stale scan, clustering, synthesis e daemon restano fuori
scope.

### 2026-07-15 — FIX EC-6 — Neighbor search isolata e cross-batch

**Stato:** `VERIFIED` — `EC6_PASSED`

È stato aggiunto `CurrentEmbeddingIdentityIndex`, indice puro e user-scoped
costruito dallo stato corrente autorevole. Lo stato pubblico osservabile è
soltanto una mappa immutabile da memory ID a content hash, point ID, modello e
revisione; owner e record restano in `WeakMap` privati. Input e item sono
chiusi, le identità vengono costruite tramite EC-1 e memory ID o logical
identity duplicate sono rifiutate. L'istanza espone soltanto `size`, `has` e
`getExpected`, senza mutatori.

L'adapter espone `searchNeighbors` senza alterare il contratto enumerabile
EC-3/EC-4. La query deve appartenere allo stesso utente dell'indice e coincidere
con l'identità corrente. Il query vector viene risolto esclusivamente tramite
`getValidEmbedding`; un miss produce `POINT_NOT_FOUND` e non attiva BGE o
fallback. Il lifecycle EC-3 viene quindi verificato dal lookup exact prima
della ricerca.

Ogni richiesta Qdrant impone simultaneamente schema V1, user hash, modello
`BAAI/bge-m3`, revisione fissata e `normalized:true`. Payload e vettori vengono
richiesti per un insieme bounded e validati completamente: point ID, memory ID,
content hash, provenance, user hash, logical full hash, fingerprint, dimensione
1024, norma e finitezza. I vettori sono scartati dopo la verifica e non entrano
nell'output.

Self-hit, point non presenti nell'indice e identità storiche coerenti vengono
scartati e contati. Un conflitto che usa il point ID o logical hash della stessa
identità corrente, un payload/fingerprint/vettore invalido, uno score non finito
o un duplicato falliscono chiusi. I risultati validi sono ordinati per score
decrescente, memory ID e point ID.

`limit` è obbligatorio, senza default e senza valore implicito cinque; il
massimo documentato è 1000. L'overfetch è esplicitamente 4× e limita ogni
risposta provider a 4000 point. `truncated:true` segnala saturazione del limite
provider, qualunque stale scartato o più validi del limite richiesto. Anche con
`truncated:false`, una top-k neighbor search non dimostra esaustività e non
equivale al complete-link V1.

Il test cross-batch materializza separatamente identità sintetiche del batch 1
e del batch 50, costruisce un indice globale e trova da una query del primo un
vicino affine del secondo. Il numero di batch non entra in point ID, payload,
filtri o ordinamento. La ricerca resta read-only, senza retry, delete, rollback
o modifiche Qdrant.

Artifact:

- `core/hippocampus/embedding-cache/CurrentEmbeddingIdentityIndex.js`;
- `core/hippocampus/embedding-cache/HippocampusEmbeddingCacheAdapter.js`;
- `test/hippocampus/embedding-cache-neighbor-search.test.js`.

Verifica:

- `node --check` su indice, adapter e test EC-6 superato;
- test EC-6 isolati con provider esclusivamente in-memory: 22/22 superati;
- regressione EC-3/EC-4/EC-5: 59/59 superati;
- suite repository serializzata, eseguita una sola volta: 522/522 superati,
  zero fail, skip o cancellazioni;
- nessuna rete reale, chiamata Qdrant/BGE-M3, collection, provisioning,
  clustering, sintesi, storage, daemon, commit, delete o accesso ai dati reali.

EC-6 è `VERIFIED`; non viene marcato automaticamente `COMPLETED`. Complete-link,
clustering, synthesis, daemon e wiring restano fuori scope.

### 2026-07-15 — FIX EC-7 — Provisioning e smoke sintetica cache Qdrant reale

**Stato:** `VERIFIED` — `EC7_PASSED`

Sono stati aggiunti due script operativi isolati per la collection dedicata
`memoria_orbitale_hippocampus_embedding_cache_v1`. Il provisioning è
inspect-only per default e autorizza la creazione soltanto con la combinazione
esatta `--allow-create --confirm CREATE_HIPPOCAMPUS_EMBEDDING_CACHE_V1`.
Qualunque conferma assente, errata o argomento non riconosciuto produce zero
write e il verdetto `DEFERRED_CREATE_NOT_AUTHORIZED`.

Ogni create di collection o indice è delegata esclusivamente a
`ensureCollection()` EC-3. Lo script controlla health Qdrant, fotografa i nomi
delle collection prima e dopo, limita tutte le write alla collection dedicata
e rivalida nome, dimensione 1024, distanza `Cosine`, gli otto payload index e
l'assenza dell'indice `vector_fingerprint`. Non espone delete, recreate,
migrate, cleanup, rollback distruttivo, fallback o retry automatico.

La smoke richiede configurazione esplicita, health Qdrant, health BGE-M3 con
modello, revisione, dimensione, model loaded e CUDA verificati, collection già
ready in inspect-only e snapshot dei nomi collection. Con Qdrant privo di API
key rifiuta endpoint pubblici e accetta soltanto endpoint privati, LAN,
Tailscale o loopback riconoscibili; il report usa esclusivamente
`qdrantAuth:"absent-private-network"`. L'introduzione di autenticazione Qdrant
resta un hardening futuro esplicito e non è stata applicata in EC-7.

I sei testi e lo user ID sono esclusivamente sintetici e stabili. EC-5 li ha
materializzati con batch size 2; la coppia semanticamente affine è collocata e
verificata in batch differenti dopo l'ordinamento deterministico per point ID.
La seconda materializzazione identica richiede tutti hit, zero nuove chiamate
BGE e zero nuove write. L'indice EC-6 globale trova il vicino cross-batch e la
smoke confronta lo score affine con uno estraneo. Retrieve e scroll restano
bounded ai sei point sintetici e con filtro su user hash, schema e provenance.
Ogni payload viene validato con shape EC-1 esatta e senza testo, user ID chiaro,
timestamp o metadata narrativi. Non viene eseguito cleanup: i point restano
isolati sotto il solo hash dell'utente sintetico e non sono selezionabili dai
filtri user-scoped di utenti reali.

Artifact e diff del fix:

- aggiunto `scripts/provision-hippocampus-embedding-cache.js`;
- aggiunto `scripts/hippocampus-embedding-cache-synthetic-smoke.js`;
- aggiunto `test/hippocampus/embedding-cache-provisioning-scripts.test.js`;
- append-only di questa sezione; nessun altro modulo è stato modificato dal
  fix EC-7.

Verifica automatica riproducibile:

- `node --check` sui due script e sul test EC-7 superato;
- test EC-7 con provider simulati: 14/14 superati;
- regressioni isolate EC-1…EC-6: 116/116 superate;
- suite repository serializzata, eseguita una sola volta: 536/536 superati,
  zero fail, skip o cancellazioni;
- diff/whitespace check superato.

Provisioning e smoke reali, eseguiti soltanto dopo i test verdi:

- provisioning reale eseguito una volta con conferma esplicita: collection
  creata e verificata, 1024/`Cosine`, otto indici pronti, una create collection
  e otto create index, nessuna delete;
- Qdrant auth: `absent-private-network`, senza endpoint nel report;
- BGE-M3: `BAAI/bge-m3`, revisione
  `5617a9f61b028005a4858fdac845db406aefb181`, dimensione 1024 e CUDA verificati;
- smoke reale eseguita una volta: 6 point sintetici, batch size 2, prima
  materializzazione 0 hit/6 created/0 replay in 3 batch;
- seconda materializzazione: 6 hit, 0 created, 0 replay, zero nuove chiamate
  BGE e zero nuove write;
- vicino affine cross-batch trovato; similarità affine `0.8051778`, estranea
  `0.5768155`;
- payload contains text: `false`; collection preesistenti modificate: `false`;
- delete/cleanup, daemon, Qwen e commit: nessuno; dati reali modificati: no.

EC-7 è `VERIFIED`; non viene marcato automaticamente `COMPLETED`. I sei point
sintetici restano intenzionalmente nella cache. Nessun daemon, clustering
finale, sintesi Qwen, commit o accesso ai dati reali è stato eseguito.

### 2026-07-15 — FIX EC-8 — Audit indipendente cache embedding Ippocampo

**Stato:** `VERIFIED` —
`EMBEDDING_CACHE_READY_FOR_BOUNDED_CLUSTERING_DESIGN`

È stato completato un audit indipendente e principalmente read-only dei
contratti EC-1…EC-7. Non è stato modificato codice di produzione o test e non
sono stati eseguiti create, upsert, delete, provisioning, cleanup, BGE reale,
Qwen, daemon, clustering, lettura di ricordi reali o commit.

Le regressioni isolate EC-1…EC-7, serializzate senza rilanciare l'intera suite
repository, hanno superato 130/130 test. La revisione statica ha confermato
identity e payload EC-1 deterministici e privati, transport EC-2 bounded e
senza retry/delete/fallback, lifecycle EC-3 inspect-only, operazioni exact EC-4
fail-closed, coordinator EC-5 limitato a 4096 item e batch massimo 128, e
neighbor search EC-6 protetta dal `CurrentEmbeddingIdentityIndex`, user/model/
revision scoped e senza limite implicito cinque.

L'ispezione reale EC-8 ha usato un wrapper che blocca localmente tutti i metodi
di write prima del trasporto. Health, lifecycle inspect-only, scroll, retrieve
e search hanno confermato collection esatta 1024/`Cosine`, otto indici, sei
point totali tutti corrispondenti alle identità sintetiche EC-7, payload EC-1
esatti senza testo/user ID chiaro/timestamp/metadata narrativi e neighbor
affine cross-batch sopra quello estraneo. L'elenco collection è rimasto
invariato, con zero write tentate e zero chiamate BGE.

`AUD-P2-004` risulta contenuto e non è un P2 attivo della cache: il vecchio
`VectorIndexAdapter` non è importato, il vector path storico resta confinato e
disabilitato, la cache non è collegata a RecallRouter e Qdrant non è
autorevole. La ricerca richiede identità correnti; point stale vengono scartati
e l'output non può costituire o scrivere una memoria.

Il benchmark esclusivamente sintetico/in-memory con provider fake ha
materializzato 4096 identità in 32 batch, con `embeddingBatchSize=128` e massimo
batch osservato 128. RSS: 48.67 MiB baseline, 56.73 MiB dopo input, 77.66 MiB
massimo (+28.99 MiB), 77.53 MiB dopo GC. L'output non contiene testo, user ID o
vettori; il fake non conserva embedding e il coordinator rilascia i riferimenti
sequenzialmente. Il RSS trattenuto dall'allocator non è stato interpretato da
solo come heap vivo.

Finding: P0=0, P1=0, P2 attivi=0, P3=4. Restano rinviati autenticazione Qdrant
(oggi `absent-private-network` e accesso limitato a rete privata/Tailscale),
semantica top-k non equivalente a complete-link, futura policy stale/capacity
senza delete implicite e benchmark RAM operativo con budget espliciti. Questi
rischi non bloccano il solo design bounded, ma impediscono di interpretare il
verdetto come autorizzazione a wiring runtime, dati reali o clustering finale.

Artifact:

- `docs/HIPPOCAMPUS_EMBEDDING_CACHE_EC8_AUDIT.md`;
- append-only di questa sezione in `docs/MEMORIA_ORBITALE_EVOLUTION.md`.

EC-8 è `VERIFIED` e non viene marcato automaticamente `COMPLETED`.

### 2026-07-15 — FIX BC-1 — Contratto bounded clustering planner

**Stato:** `VERIFIED` — `BC1_PASSED`

È stato introdotto un contratto puro, vectorless e versionato per il futuro
planner bounded, senza collegarlo al runtime. `algorithmVersion` è congelato a
`hippocampus-bounded-complete-link-v1`; la policy conserva esattamente la
semantica `complete-link-greedy-v1`: identità canoniche, seed deterministico,
ammissione inclusiva soltanto con similarità `>= 0.70` verso ogni membro,
`minClusterSize=3`, nessuna riassegnazione e nessun limite implicito di cinque.
Ogni modifica semantica futura richiederà una nuova policy/versione.

Il contratto valida e congela uno snapshot globale di identità correnti con
fingerprint SHA-256 deterministico, provenance di modello/revisione e copertura
disgiunta ed esaustiva. Soltanto discovery
`COMPLETE_ABOVE_THRESHOLD` può produrre cluster finali. La barriera globale,
le componenti incomplete e ogni superamento di budget falliscono chiusi tramite
reason code enumerati; `PARTIAL_DEFERRED` permette di finalizzare soltanto
componenti certificate, rinviando integralmente le altre. Metriche operative,
campi temporali, testi, vettori, centroidi e payload provider non partecipano al
`clusterId`.

Sono previsti campi temporali separati per sorgenti con cronologia valida e
sorgenti irrisolte. BC-1 non sceglie il timestamp autorevole e non implementa
synthesis; in particolare, “attualmente” non è inferito dal timestamp più
recente. Il piano persistibile non contiene testo, vettori, centroidi, payload
Qdrant, user ID chiaro, endpoint o segreti ed è profondamente immutabile.

Artifact del fix:

- `core/clustering/HippocampusBoundedClusteringPlan.js`;
- `docs/contracts/HIPPOCAMPUS_BOUNDED_CLUSTERING_PLAN_V1.md`;
- `test/clustering/hippocampus-bounded-clustering-plan.test.js`;
- append-only di questa sezione.

Verifica riproducibile:

- `node --check` sui nuovi file JavaScript superato;
- test BC-1 isolati: 20/20 superati;
- regressioni isolate EC-1…EC-8 disponibili: 130/130 superate;
- suite repository serializzata, eseguita una sola volta: 556/556 superati,
  zero fail, skip o cancellazioni;
- controllo statico privacy, shape chiusa, determinismo e import vietati
  superato.

Non sono stati eseguiti rete, Qdrant, BGE-M3, Qwen, daemon, provisioning,
smoke, accesso o modifica di dati reali, storage memoria, wiring runtime o
commit. BC-1 è `VERIFIED` e non viene marcato automaticamente `COMPLETED`.

### 2026-07-15 — FIX BC-2 — Candidate graph bounded e deterministico

**Stato:** `VERIFIED` — `BC2_PASSED`

È stato aggiunto un builder puro del solo grafo candidato, senza refinement,
cluster finali o SuperMemory. Il componente importa dal contratto BC-1
`algorithmVersion`, policy, status, reason code e discovery completeness; non
duplica né modifica la semantica `complete-link-greedy-v1` congelata.

Le identità dello snapshot globale immutabile vengono validate nuovamente e
interrogate sequenzialmente in ordine canonico tramite provider read-only
iniettato. Ogni hit viene verificato contro lo snapshot corrente: self-hit,
point estranei, stale, provenance incompatibile e score sotto `0.70` sono
scartati e contati. Gli edge validi usano confronto inclusivo, coppia di
pointId canonicalizzata, deduplica indipendente dalla direzione e massimo score
valido osservato. La scelta del massimo privilegia il recall; BC-4 dovrà
ricalcolare la similarità reale, quindi nessun edge BC-2 certifica un cluster.

Union-find conserva soltanto pointId e radici canoniche. Componenti, member,
edge e metriche hanno ordine deterministico; batch EC-5, ordine di input,
direzione e ordine delle risposte provider non entrano negli identificatori o
nella membership. Una catena A–B–C resta soltanto componente candidata e
`finalizationAuthorized` è sempre `false`.

I budget `maxNeighborQueries`, `maxCandidateEdges` e `timeoutMs` sono chiusi,
positivi e obbligatori; anche `AbortSignal` è obbligatorio. Il builder non usa
`Promise.all`, retry o fallback. Query budget, edge budget e timeout producono
risultati deferred espliciti con reason code BC-1. Gli stati discovery complete,
truncated, uncertified e failed vengono trasportati e aggregati senza promozione
silenziosa; una truncation locale non può risultare complete.

Artifact del fix:

- `core/clustering/HippocampusCandidateGraphBuilder.js`;
- `docs/contracts/HIPPOCAMPUS_CANDIDATE_GRAPH_V1.md`;
- `test/clustering/hippocampus-candidate-graph-builder.test.js`;
- append-only di questa sezione.

Verifica riproducibile:

- `node --check` sui nuovi file JavaScript superato;
- test BC-2 isolati: 22/22 superati;
- regressione BC-1: 20/20 superata;
- regressioni isolate EC-1…EC-8 disponibili: 148/148 superate;
- suite repository serializzata, eseguita una sola volta: 578/578 superati,
  zero fail, skip o cancellazioni;
- controlli whitespace, privacy, shape chiusa e import runtime vietati
  superati.

L'output è profondamente immutabile e non contiene testi, vettori, centroidi,
payload Qdrant, userId chiaro, endpoint, segreti o batch. Non sono stati
eseguiti rete, Qdrant, BGE-M3, Qwen, daemon, provisioning, smoke, accesso o
modifica di dati reali, storage memoria, clustering finale, wiring runtime o
commit. BC-2 è `VERIFIED` e non viene marcato automaticamente `COMPLETED`.

### 2026-07-15 — FIX BC-3 — Discovery completeness e component closure

**Stato:** `VERIFIED` — `BC3_PASSED`

È stato introdotto il contratto puro
`hippocampus-threshold-discovery-certificate-v1`, con mode chiusa
`EXACT_ABOVE_THRESHOLD_ENUMERATION_V1`. Il certificato lega fingerprint dello
snapshot BC-1, query point corrente, policy `0.70`, modello/revisione,
universo eleggibile, conteggio dei vicini osservati, exhaustion, truncation e
continuation. Shape, contatori e provenance sono validati fail-closed.

Un normale risultato top-k resta `INCOMPLETE_UNCERTIFIED`: `truncated:false`,
un result count sotto il limit, continuation assente o una semplice
dichiarazione provider `COMPLETE_ABOVE_THRESHOLD` non costituiscono prova. Solo
un certificato esplicito valido può produrre completezza effettiva. BC-3 non
genera certificati e non dimostra internamente l'enumerazione: tale
responsabilità resta al provider che dichiara la mode esatta; nessun provider
reale è stato implementato.

Il candidate graph BC-2 conserva edge, union-find, ordine e metriche, ma espone
ora summary ordinati per query con stato ricevuto, stato verificato, reason code
e solo fingerprint del certificato valido. Il certificato raw non viene
restituito. Un edge, anche sopra soglia, non autorizza da solo la closure.

Una componente è `AUTHORIZED_FOR_REFINEMENT` soltanto se ogni membro possiede
un certificato valido per lo stesso snapshot e policy. Un solo membro absent,
invalid, truncated, uncertified, failed, stale o non interrogato rinvia
l'intera componente con `DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY`; non vengono
estratti sottoinsiemi. L'autorizzazione vale esclusivamente per il futuro BC-4:
una catena A–B–C certificata resta componente candidata, non cluster finale.

Componenti disgiunte sono valutate separatamente: una componente certificata e
una deferred producono `PARTIAL_DEFERRED`. Query budget e timeout possono
preservare una componente disgiunta già chiusa; l'edge budget forza invece
tutte le componenti deferred perché la membership del grafo è troncata. Nessun
budget, timeout o abort inventa completezza; non esistono retry o fallback.

Artifact del fix:

- `core/clustering/HippocampusDiscoveryCompleteness.js`;
- integrazione minima in `core/clustering/HippocampusCandidateGraphBuilder.js`;
- `test/clustering/hippocampus-discovery-completeness.test.js`;
- adeguamento dell'allowlist import nel test BC-2;
- `docs/contracts/HIPPOCAMPUS_DISCOVERY_COMPLETENESS_V1.md`;
- aggiornamento puntuale del confine nel contratto BC-2;
- append-only di questa sezione.

Verifica riproducibile:

- `node --check` sui file JavaScript BC-3 coinvolti superato;
- test BC-3 isolati: 23/23 superati;
- regressioni BC-1 e BC-2: 42/42 superate;
- regressioni isolate EC-1…EC-8 disponibili: 148/148 superate;
- suite repository serializzata, eseguita una sola volta: 601/601 superati,
  zero fail, skip o cancellazioni;
- controlli privacy, whitespace, shape chiusa e import runtime vietati
  superati.

Output e certificazione sono immutabili e non contengono testi, vettori,
centroidi, payload Qdrant, userId, endpoint, segreti o batch. Non sono stati
eseguiti rete, Qdrant, BGE-M3, Qwen, storage, daemon, provisioning, smoke,
accesso o modifica di dati reali, clustering finale, SuperMemory, wiring o
commit. BC-3 è `VERIFIED` e non viene marcato automaticamente `COMPLETED`.

### 2026-07-15 — FIX BC-4 — Bounded complete-link refinement

**Stato:** `VERIFIED` — `BC4_PASSED`

È stato aggiunto il refiner puro delle sole componenti BC-3
`AUTHORIZED_FOR_REFINEMENT`. La semantica `complete-link-greedy-v1` resta
quella congelata da BC-1: ordine canonico condiviso, seed primo non assegnato,
candidato ammesso soltanto con cosine `>= 0.70` verso ogni membro, short-circuit
al primo confronto sotto soglia, nessuna riassegnazione, minimo 3 e nessun
limite implicito di cinque. Il chain test A-B-C impedisce correttamente il
cluster di tre quando A-C è sotto soglia.

Resolver embedding, clock e RSS reader sono iniettati. Point ID, memory ID,
content hash, modello, revisione, cache schema, fingerprint snapshot,
dimensione 1024, valori finiti e normalizzazione vengono rivalidati
fail-closed. Retrieve e componenti sono sequenziali; una sola `Map` conserva al
massimo `memberCount` vettori e viene svuotata con riferimento azzerato prima
della componente successiva. Componenti uncertified e dense non vengono mai
lette.

Ogni cosine reale è contata. Pairwise, timeout e RSS scartano tutto lo staging
della componente e producono deferred integrale; abort e mismatch non
restituiscono piani parziali. Gruppi oversized non vengono troncati. I cluster
validi sono verificati ricalcolando tutte le coppie senza matrice O(m²), e
`minimumPairSimilarity` conserva il minimo reale verificato sopra soglia.

L'output è composto tramite BC-1, profondamente immutabile, vectorless e a
coverage completa/disgiunta. La sola modifica necessaria al contratto BC-1
espone comparator e validator già esistenti e consente a
`maximumComponentSize` di descrivere la componente BC-3 sorgente anche quando
essa produce più gruppi disgiunti; policy, shape e identificatori restano
invariati. Il tempo rimane `NOT_EVALUATED` nella rappresentazione prevista per
BC-5.

Artifact del fix:

- `core/clustering/HippocampusBoundedCompleteLinkRefiner.js`;
- `test/clustering/hippocampus-bounded-complete-link-refiner.test.js`;
- `docs/contracts/HIPPOCAMPUS_BOUNDED_COMPLETE_LINK_REFINEMENT_V1.md`;
- `docs/HIPPOCAMPUS_BOUNDED_CLUSTERING_BC4.md`;
- aggiornamento minimo BC-1 e del relativo contratto;
- log e diff manifest in `automation/logs`;
- append-only di questa sezione.

Verifica riproducibile:

- `node --check` sui file JavaScript BC-4 e BC-1 modificato superato;
- test BC-4 isolati: 22/22 superati;
- regressioni BC-1/BC-2/BC-3: 65/65 superate;
- regressioni isolate EC-1…EC-8 disponibili: 148/148 superate;
- suite repository serializzata, eseguita una sola volta: 623/623 superati,
  zero fail, skip o cancellazioni;
- privacy, whitespace, shape e import check superati.

Non sono stati eseguiti rete reale, Qdrant, BGE-M3, Qwen, storage, daemon,
provisioning, smoke, dati reali, synthesis, SuperMemory, wiring o commit. La
coda legacy non contiene BC-4, quindi non è stata inventata alcuna transizione
e il fix non è marcato automaticamente `COMPLETED`.

### 2026-07-15 — FIX BC-5 — Tempo, provenance e contratto temporale vectorless

**Stato:** `VERIFIED` — `BC5_PASSED`

L'ispezione read-only di storage, normalizer, candidate selection,
consolidation plan, contratti e sole fixture sintetiche conferma che il runtime
flat usa `timestamp` numerico epoch millisecondi come momento di registrazione
e `lastAccess` come metrica operativa. Il nested teorico usa ISO string in
`meta.timestamp`, `orbital.birth` e `orbital.last_access`; una variante legacy
usa timestamp numerico in stringa. Nessun `eventTime` strutturato è stato
osservato.

BC-5 rende quindi autorevole come `recordedAt` soltanto il `timestamp`
safe-integer del source contract esattamente flat, preservando zero e valori
storici negativi. Stringhe non vengono parsate; nested/hybrid/unknown restano
undated senza precedenze inventate. `lastAccess` viene ignorato e non partecipa
a output, ordine o identità. `eventTime` resta UNKNOWN salvo evidenza
strutturata esplicita e non deriva mai da recordedAt o testo.

Il nuovo descrittore temporale si lega allo snapshot BC-1 e a un cluster
verificato del piano BC-4. Content hash stale, source duplicate, mancanti o
estranee falliscono chiusi. Source cronologiche e undated coprono la membership
in modo completo e disgiunto; start/end derivano soltanto dai recordedAt validi
e la qualità distingue COMPLETE, PARTIAL_MISSING, PARTIAL_INVALID e UNKNOWN.
Membership e cluster ID restano invariati.

Il request builder synthesis è puro, vectorless e request-only. Espone due
sezioni, cronologia di registrazione e source undated, impone futura rilettura
autorevole con match memory ID/content hash e dichiara che recency non implica
stato attuale. `currentStateSupported` resta false senza evidenza esplicita;
cambiamenti, contraddizioni e supersessioni devono essere preservati.
`SynthesisContract` V1 non è stato modificato e nessun provider è stato
invocato.

Artifact del fix:

- `core/clustering/HippocampusTemporalProvenance.js`;
- `core/synthesis/HippocampusTemporalSynthesisRequest.js`;
- `test/clustering/hippocampus-temporal-provenance.test.js`;
- `docs/contracts/HIPPOCAMPUS_TEMPORAL_PROVENANCE_V1.md`;
- `docs/HIPPOCAMPUS_BOUNDED_CLUSTERING_BC5.md`;
- log e diff manifest in `automation/logs`;
- append-only di questa sezione.

Verifica riproducibile:

- `node --check` sui moduli e test BC-5 superato;
- test BC-5 isolati: 19/19 superati;
- regressioni BC-1…BC-4: 87/87 superate;
- regressioni isolate EC-1…EC-8 disponibili: 148/148 superate;
- suite repository serializzata, eseguita una sola volta: 642/642 superati,
  zero fail, skip o cancellazioni;
- privacy, whitespace, shape e import check superati.

Non sono stati letti o modificati dati reali e non sono stati eseguiti rete,
Qdrant, BGE-M3, Qwen, storage reale, daemon, provisioning, smoke, SuperMemory,
wiring o commit. La queue legacy non contiene BC-5; nessuna transizione è stata
inventata e il fix non è marcato automaticamente `COMPLETED`.

### 2026-07-15 — FIX BC-6 — Synthetic bounded clustering benchmark

**Stato:** `FAILED` — `BC6_BLOCKED`

BC-6 è stato arrestato alla precondizione bounded, senza modificare BC-1→BC-5
e senza introdurre harness o algoritmi alternativi. L'ispezione mostra che
ogni query del candidate graph BC-2 invoca la valutazione certificato BC-3, che
a sua volta rivalida l'intero snapshot BC-1. La validazione ricrea, clona,
ordina e rifingerpronta tutte le identità. Il costo globale viene quindi
ripetuto N volte e non soddisfa il requisito candidate graph O(Nk).

Un probe esclusivamente sintetico con k=0, zero hit, zero edge e zero vettori ha
misurato 965,70 ms a 100 identità, 4.113,92 ms a 250 e 10.057,65 ms a 500. Una
prima sequenza fino a 1.000 non aveva completato dopo oltre 60 secondi ed è
stata interrotta per evitare carico inutile. Il livello 10.000/40.000 non è
stato tentato perché il blocker era già dimostrato.

Il benchmark completo richiesto, equivalenza V1, determinismo, RSS, dense e
incomplete deferred non possono essere dichiarati tramite bypass o pipeline
parziale. In accordo con le istruzioni BC-6, la correzione del percorso di
validazione richiede autorizzazione e fix separato; non è stata applicata qui.

Artifact:

- `docs/HIPPOCAMPUS_BOUNDED_CLUSTERING_BC6.md`;
- log e diff manifest in `automation/logs`;
- append-only di questa sezione.

Non sono state eseguite regressioni o suite completa dopo il blocker e il
benchmark pesante non è stato avviato. Non sono stati usati rete, Qdrant,
BGE-M3, Qwen, storage, daemon, dati reali, provisioning, SuperMemory, wiring o
commit.

### 2026-07-15 — FIX BC-6 — Authorized blocker resolution and resumed benchmark

**Stato:** `VERIFIED` — `BC6_PASSED`

Il blocker precedente è stato corretto nello scope autorizzato. BC-3 prepara
ora lo snapshot BC-1 una sola volta per build BC-2: validazione, ordinamento,
fingerprint e Map private avvengono prima di ogni provider call. Le N query
eseguono lookup O(1) e controlli scalari; nessuna cache globale viene usata.
Contatori dedicati provano una sola preparazione/validazione/ordinamento/hash e
N lookup certificato, con isolamento fra build successive.

Il benchmark sintetico ripreso ha completato 100/1k/10k/40k in un'unica
invocazione. Il livello 40k ha impiegato 47.747,54 ms, con RSS delta
180.752.384 byte e massimo tre vettori simultanei. La componente certificata
da 39.984 membri è stata rinviata integralmente prima del retrieve; le
componenti piccole certificate sono state completate. La reference V1 a 100,
la catena non-clique e i digest diretto/inverso 100/1k sono risultati corretti.

Artifact: prepared context BC-3 e uso one-time BC-2, relativi test, harness
`scripts/hippocampus-bounded-clustering-benchmark.js`, test ridotti, report e
log BC-6. Nessuna semantica BC-1→BC-5, integrazione runtime o provider reale è
stata modificata. Non sono stati usati rete, dati reali, storage, daemon,
provisioning, SuperMemory, wiring o commit.

Verifica finale: test correttivi BC-2/BC-3 50/50, harness BC-6 4/4,
regressioni BC-1→BC-5 111/111, regressioni EC-1→EC-8 148/148 e unica suite
repository serializzata 650/650. Privacy, whitespace nello scope, shape e
import check sono passati.

### 2026-07-16 — Prerequisito BC-8 — Qdrant exact threshold discovery

**Stato:** `VERIFIED` — `EXACT_DISCOVERY_READY_FOR_BC8`

È stato aggiunto un provider Qdrant read-only isolato che implementa la shape
`discoverNeighbors` BC-2 e può emettere il certificato BC-3
`EXACT_ABOVE_THRESHOLD_ENUMERATION_V1`. Usa una singola Query API per point ID,
con `params.exact:true`, threshold 0.70, filtro obbligatorio su schema, user
hash, modello, revisione e normalized, esclusione self e
`limit=maxHitsPerQuery+1`. Non esiste paginazione, retry o fallback.

Il transport Qdrant esistente espone il nuovo metodo read-only `queryPoints`
senza modificare `searchPoints` o `searchNeighbors`. Timeout e response-byte
budget sono legati al provider dedicato; `maxHitsPerQuery` è obbligatorio e
limitato a 4096. Cap+1 produce `INCOMPLETE_TRUNCATED` senza certificato.
Risposta approssimata, malformed, oversized, timeout, abort o mismatch produce
`FAILED` sanitizzato.

Ogni hit viene verificato contro `CurrentEmbeddingIdentityIndex`: point ID,
memory ID, content hash, logical/user hash, modello, revisione, schema,
normalizzazione, threshold e payload EC-1. Soltanto dopo tutte le verifiche
viene emesso il certificato legato a snapshot, query, policy e contatori.
Output ed errori non contengono testo, vettori, endpoint, API key, user ID o
payload raw. Qdrant resta non autorevole.

Artifact: provider, estensione Query API del transport, contratto, test,
script smoke, report e log/diff BC-8. Nessun wiring runtime, daemon, storage,
RecallRouter, synthesis, SuperMemory o commit è stato aggiunto.

Verifiche: provider e smoke isolati 18/18, path Qdrant/EC focalizzati 55/55,
regressioni BC-1→BC-6 115/115, regressioni EC-1→EC-8 148/148 e unica suite
repository serializzata 669/669, tutte verdi. Syntax, privacy, whitespace,
shape e import check sono passati.

La smoke Qdrant reale read-only ha verificato i soli sei point sintetici EC-7:
una exact query, cap 5/limit 6, threshold 0.70, un hit sopra soglia,
certificato BC-3 valido e zero write. Nessuna collection, dato reale, daemon,
Qwen, SuperMemory o commit è stato modificato.

### 2026-07-16 — BC-8 finale — Synthetic end-to-end wiring

**Stato:** `FAILED` — `HIPPOCAMPUS_BC8_BLOCKED`

È stato aggiunto un adapter di composizione bounded completamente iniettato e
un entry point daemon esplicito, disabilitato senza injection. Il percorso
storico `runOnce` e `ClusterEngineAdapter` restano invariati. La pipeline fake
end-to-end copre snapshot, cache/barriera BGE-M3, exact discovery, candidate
graph, certificati, complete-link refinement, temporal provenance, rilettura
hash, Qwen fake, SuperMemory temporanea e zero commit.

I test BC-8 sono 7/7, le regressioni BC-1→BC-6 115/115, le regressioni
EC/Qdrant 166/166 e la suite completa serializzata 676/676, tutte verdi.

La smoke reale ha creato soltanto tre point minimi sintetici nella collection
cache dedicata. Dopo una correzione locale fail-closed del ricalcolo coseno,
la verifica ha ottenuto 3 cache hit, 3 certificati exact e una sola chiamata
Qwen. Qwen non ha completato entro 120 secondi; nessun retry/fallback è stato
eseguito, il cluster è stato deferred, la SuperMemory temporanea non è stata
dichiarata valida e i commit sono rimasti zero.

Artifact: adapter, test E2E fake, smoke live sanitizzata, report BC-8 finale e
log/diff manifest. Il runtime reale resta disabilitato. Per chiudere BC-8 serve
una nuova smoke Qwen sintetica esplicitamente autorizzata che completi entro il
budget e validi la SuperMemory in RAM.

### 2026-07-16 — HACT-1 — Hippocampus backend activation gate

**Stato:** `VERIFIED` — `ACTIVATION_SWITCH_READY_DEFAULT_OFF`

È stato aggiunto un gate backend puro con modalità chiuse `OFF`, `SHADOW` e
`LIVE`. Ogni nuova istanza senza configurazione torna OFF; non esiste stato
globale, fallback, auto-promozione o avvio implicito di cicli.

SHADOW autorizza soltanto una futura composizione read/analysis e mantiene
sempre `commitAuthorized=false`, anche se riceve una capability commit valida.
LIVE richiede insieme token `ENABLE_HIPPOCAMPUS_LIVE_V1`, capability commit
esplicita e attestazione canonica delle capability storage `memory.readAll`,
`memory.writeAll`, `commit.atomic`, `lock.acquire` e `lock.release`. Il gate
non invoca commit e non collega ancora il wiring operativo.

Il contratto preflight separato rappresenta readiness Qdrant, cache, BGE-M3,
Ollama, Qwen, storage e commit senza chiamate reali. La presenza del modello in
`/api/tags` non certifica Qwen: sono richieste mini-inference completata, JSON
valido e done reason stop.

Stato registrato:

- `SYNTHETIC_END_TO_END_VERIFIED`;
- `REAL_RUNTIME_DISABLED`;
- `DEFAULT_ACTIVATION_MODE_OFF`.

Verifiche: test HACT-1 19/19, regressioni BC/BC-8/daemon/storage 161/161,
regressioni EC/Qdrant 166/166 e unica suite completa serializzata 695/695,
tutte verdi. Syntax, privacy, whitespace e import check sono passati.

Non sono stati usati rete, dati reali, storage reale, daemon, scheduler,
Qdrant, BGE-M3, Qwen, processing state o commit. Frontend, API HTTP, runtime e
provider restano invariati.

### 2026-07-16 — HACT-2 — Hippocampus backend control plane API

**Stato:** `BLOCKED` — `HIPPOCAMPUS_CONTROL_PLANE_BLOCKED_HTTP_MOUNT`

È stato aggiunto un controller applicativo volatile con modalità HACT-1
`OFF | SHADOW | LIVE`, stato iniziale `OFF / IDLE`, snapshot gate immutabile
per run, preflight iniettato, singola esecuzione concorrente e stop cooperativo
con `AbortSignal`. Modalità e run non si avviano reciprocamente; cambi modalità
durante `PREFLIGHT`, `RUNNING` o `STOPPING` sono rifiutati. Il risultato
pubblico conserva soltanto reason code e contatori sanitizzati.

È stato aggiunto anche un dispatcher HTTP framework-neutral per status, mode,
run e stop, con autorizzazione server-side iniettata, JSON chiuso, limite
100 KiB, content type e metodi verificati. Capability commit e storage non
sono accettate via HTTP e non vengono passate al runner.

Stato registrato:

- `ACTIVATION_GATE_READY`;
- `CONTROL_PLANE_READY`;
- `DEFAULT_MODE_OFF`;
- `REAL_RUNNER_NOT_WIRED`;
- `REAL_RUNTIME_DISABLED`.

Il dispatcher non è stato montato. L'unico entrypoint HTTP rinvenuto,
`apps/orbitale-cockpilot/server.ts`, appartiene all'app frontend, si auto-avvia
e non espone autenticazione o user context riutilizzabili. Modificarlo avrebbe
violato il divieto HACT-2 di intervenire sul frontend e avrebbe esposto un
control plane senza confine autorizzativo verificato. Non è stato creato un
server parallelo.

Le verifiche HACT-2 usano esclusivamente gate, preflight, runner,
autorizzazione e clock fake. Rete, provider, dati reali, storage,
processing state, commit, cleanup e delete restano a zero. Il runtime reale e
il runner reale restano disabilitati.

Verifiche: syntax check PASS, HACT-2 16/16, regressione HACT-1 19/19,
regressioni BC/BC-8/daemon 176/176, regressioni EC/Qdrant 162/162 e unica
suite completa serializzata 711/711. Fail, cancelled, skipped e todo sono zero;
privacy, whitespace e import check sono passati.

### 2026-07-16 — HACT-2B — Hippocampus control plane HTTP mount

**Stato:** `BLOCKED` —
`BLOCKED_BACKEND_AUTHORIZATION_BOUNDARY_REQUIRED`

Il preflight ha ispezionato i backend e i launcher Keblo disponibili senza
modificare runtime. Il launcher corrente di Keblo Memoria Orbitale avvia
sincronizzazione e frontend Vite, non un backend autenticato. Il server cockpit
presente nella stessa copia non è avviato dal launcher e non possiede sessione
o autorizzazione.

Keblo Final dichiara sessioni Express, ma accetta un'identità client senza
verifica credenziali, usa configurazione di firma di sviluppo incorporata e
non ha le dipendenze runtime installate. Keblo Chatbot espone nel server
corrente un login/JWT di sviluppo e presenta una separazione incoerente fra
porte di login e chat. Un middleware storico JWT più sessione database esiste,
ma non è montato dall'entrypoint corrente e non può essere promosso
silenziosamente a confine operativo.

Non è stato quindi individuato un unico backend Keblo operativo con identità,
sessione e autorizzazione server-side verificabili per API sensibili.

È stato inoltre verificato che Memoria_Orbitale_Autonomo non espone ancora
HACT-2 tramite package, export o workspace stabile. Import relativi fra
repository o path assoluti macchina sarebbero fragili e non sono stati creati.

Stato registrato:

- `ACTIVATION_GATE_READY`;
- `CONTROL_PLANE_READY`;
- `HTTP_MOUNT_BLOCKED_BACKEND_AUTHORIZATION_BOUNDARY_REQUIRED`;
- `DEFAULT_MODE_OFF`;
- `REAL_RUNNER_NOT_WIRED`;
- `REAL_RUNTIME_DISABLED`.

Nessun endpoint è stato montato, nessun server parallelo è stato creato e
frontend, CORS, environment, scheduler, daemon, provider, storage e dati sono
rimasti invariati. Runner, capability commit e capability storage non sono
stati iniettati.

Verifiche: syntax HACT-1/HACT-2 PASS, regressioni HACT-1/HACT-2 35/35, syntax
dei backend candidati PASS. Nessuna suite completa è stata rilanciata perché
non è stato modificato codice runtime. Rete, dati reali, provider, storage,
processing state e commit sono rimasti a zero.

### 2026-07-16 — HACT-3 — Standalone Hippocampus shadow CLI

**Stato:** `VERIFIED` — `HIPPOCAMPUS_STANDALONE_SHADOW_CLI_READY`

È stato aggiunto un composition root Ippocampo core, completamente iniettato e
privo di environment, filesystem, rete, provider e storage globali. L'export
pubblico è chiuso a `createHippocampusRuntime`,
`createHippocampusActivationController` e `ACTIVATION_MODES`.

La nuova CLI manuale parte OFF a ogni processo e supporta status, preflight
SHADOW e un singolo run SHADOW con user ID e limite candidati espliciti. LIVE
viene respinto sempre con `LIVE_RUNTIME_NOT_AUTHORIZED`. Non esistono
scheduler, auto-start, prompt interattivi, retry o fallback.

Il preflight futuro verifica configurazione, storage leggibile, Qdrant,
collection cache, provenienza BGE-M3 e mini-inference Qwen JSON con done reason
stop. Il runner SHADOW usa CandidateSelector/ConsolidationPlan e il bounded
pipeline BC-8. La memoria autorevole resta read-only; l'unica write possibile
è la cache embedding nella collection dedicata ed è distinta nel report.

SIGINT e SIGTERM propagano AbortSignal, richiedono stop una sola volta e
attendono l'uscita cooperativa. stdout contiene un solo JSON sanitizzato.

Stato registrato:

- `ACTIVATION_GATE_READY`;
- `CONTROL_PLANE_READY`;
- `HTTP_MOUNT_DEFERRED_TO_KEBLO_SERVER`;
- `STANDALONE_CLI_READY`;
- `DEFAULT_MODE_OFF`;
- `LIVE_RUNTIME_DISABLED`;
- `REAL_SHADOW_RUN_NOT_EXECUTED`.

Nessuna preflight reale e nessun ciclo SHADOW sui ricordi reali sono stati
eseguiti. Frontend, backend Keblo, HTTP, daemon, scheduler, provider, storage,
processing state, commit transaction, RecallRouter, vector path e `.env` sono
rimasti invariati.

Verifiche: Node v18.19.1, syntax PASS, HACT-3 19/19, regressioni HACT-1/2
35/35, regressioni BC/BC-8/daemon 176/176, regressioni
EC/Qdrant/BGE/Qwen 180/180 e unica suite completa serializzata 730/730.
Fail, cancelled, skipped e todo sono zero. Privacy, whitespace, export e
import-boundary check sono passati.

### 2026-07-17 — HACT-3B — Real composition and diagnostic preflight

**Stato:** `VERIFIED` — `HIPPOCAMPUS_REAL_SHADOW_PREFLIGHT_BLOCKED_CONFIGURATION`

L'ispezione ha corretto la descrizione HACT-3: il CLI iniettava già il
preflight reale e il runner SHADOW reale era già componibile; il ramo di
configurazione incompleta produceva però immediatamente un report HACT-1
tutto-false e il composition root ne perdeva la causa.

HACT-3B aggiunge diagnostica sanitizzata per configurazione, storage, Qdrant,
collection cache, BGE-M3 e mini-inference Qwen. La mini-inference riusa
`OllamaSynthesisProvider`; il preflight non enumera ricordi, non genera
embedding, non crea SuperMemory e non espone capability commit.

Stato registrato:

- `HACT3_CLI_CONTRACT_VERIFIED`;
- `HACT3_REAL_COMPOSITION_PREVIOUSLY_NOT_WIRED=false`;
- `HACT3_REAL_COMPOSITION_FIXED`;
- `REAL_SHADOW_RUN_NOT_EXECUTED`;
- `LIVE_RUNTIME_DISABLED`.

L'unica preflight reale autorizzata è terminata localmente con
`CONFIGURATION_INCOMPLETE`, exit code 3 e durata 11 ms. Ha inoltre rivelato un
controllo troppo stretto sul prototipo speciale di `process.env`, corretto e
verificato senza ripetere la preflight. Restano mancanti soltanto
`HIPPOCAMPUS_MEMORY_DATA_DIR`, `HIPPOCAMPUS_QWEN_TIMEOUT_MS`, `PRIMARY_MODEL` e
`PRIMARY_OLLAMA_URL`. Rete, letture ricordi, write cache/autorevoli e commit
sono rimasti a zero; `.env` non è stata modificata.

Verifiche: HACT-3B post-fix 12/12, regressioni mirate 367/367, smoke sintetica
BC-8 invariata e suite completa serializzata eseguita una volta 741/741.
Syntax, import, privacy e whitespace PASS. Nessun commit Git.

### 2026-07-17 — HACT-3C — Qdrant health preflight compatibility

**Stato:** `VERIFIED` — `QDRANT_HEALTH_PREFLIGHT_FIXED`

La causa è stata riprodotta isolatamente tramite `provider.health`: dopo avere
ricevuto esattamente i 20 byte dichiarati da `Content-Length`, il transport
attendeva ancora la chiusura dello stream fino al timeout. Il Content-Type non
era la causa, perché `text/plain` era già ammesso esclusivamente dal ramo
health.

La patch minima usa il Content-Length validato come framing terminale soltanto
per health, mantenendo lettura bounded fino a EOF quando la lunghezza non è
dichiarata. Redirect, timeout, AbortSignal, sanitizzazione, zero retry e zero
fallback restano invariati. Le altre API continuano a richiedere Content-Type
JSON, JSON valido ed envelope Qdrant valido.

Verifiche: riproduzione post-fix PASS, syntax PASS, provider/EC-2 21/21 e
HACT-3B 12/12. La singola `provider.health` reale è passata in 417 ms. La
singola preflight CLI reale ha superato configurazione, storage, Qdrant e
collection cache, poi si è fermata con `BGE_M3_PROVENANCE_MISMATCH`, exit code
3 e durata 472 ms; Qwen è rimasto `NOT_RUN`.

Letture ricordi, write autorevoli/cache e commit sono rimasti a zero. Nessuna
SHADOW run, modifica `.env`, storage, daemon, clustering, frontend/backend,
processing state, provider BGE/Qwen o commit Git. Il verdetto finale
`HIPPOCAMPUS_REAL_SHADOW_PREFLIGHT_READY` non viene emesso.

### 2026-07-17 — HACT-3D — BGE-M3 preflight provenance mapping

**Stato:** `VERIFIED` — `BGE_M3_PREFLIGHT_PROVENANCE_FIXED` —
`HIPPOCAMPUS_REAL_SHADOW_PREFLIGHT_READY`

La response health reale approvata è stata riprodotta isolatamente. Il
confronto che causava `BGE_M3_PROVENANCE_MISMATCH` era
`body.normalized === true`: il campo non appartiene al contratto health e il
valore letto era quindi `undefined`. Inoltre la preflight non controllava
ancora `status` e `device`.

La patch minima sostituisce quel confronto con il mapping esatto del contratto
health: `status:healthy`, modello e revisione fissati, `model_loaded:true`,
`device:cuda` e dimensione 1024. La configurazione del provider resta fissata
a `normalized:true`; provider e cache continuano a rifiutare provenance non
normalizzata e vettori con norma fuori dalla tolleranza esistente. Il servizio
BGE-M3 e il formato delle sue response non sono stati modificati.

Verifiche: riproduzione pre-fix PASS, syntax PASS, test preflight 15/15 e
regressioni combinate BGE/provider/cache, HACT-3B e HACT-3C 110/110. Sono
coperti health reale senza `normalized`, mismatch o assenza di ogni campo
obbligatorio, `normalized:false` nell'envelope embedding e norma vettoriale.

L'unica health BGE-M3 reale effettivamente inviata è passata con HTTP 200 e ha
confermato l'assenza di `normalized`. L'unica preflight CLI reale è passata con
`PREFLIGHT_READY` in 25444 ms: tutti i check, inclusa la mini-inference Qwen,
sono PASS. Letture ricordi, write autorevoli, write cache e commit sono rimasti
a zero. Nessuna SHADOW run, modifica `.env`, Qdrant, storage, clustering,
daemon, frontend/backend, processing state, servizio BGE o commit Git.

### 2026-07-17 — HACT-4 — Legacy flat memory SHADOW projection

**Stato:** `VERIFIED` — `LEGACY_FLAT_SHADOW_PROJECTION_READY` —
`HIPPOCAMPUS_REAL_SHADOW_RUN_PASSED`

La diagnosi read-only ha confermato 40.774 record object-keyed, con chiave
uguale a `id`, identità univoche, testo legacy non vuoto e processing state
assente per tutti. Il primo ciclo aveva rinviato 20/20 record come
`LEGACY_UNCLASSIFIED`; lo stato canonico eleggibile è `raw`.

È stata aggiunta la projection pura
`hippocampus-legacy-flat-shadow-projection-v1`, usata soltanto dal runner
standalone SHADOW. Conserva l'identità autorevole, calcola SHA-256 sul testo
UTF-8 esatto, attribuisce lo stato tecnico soltanto in RAM con provenance non
persistita, seleziona deterministicamente entro il limite e rifiuta identità o
strutture incompatibili. CandidateSelector e record sorgente non sono stati
modificati. Il risultato zero è ora `SHADOW_NO_ELIGIBLE_CANDIDATES` con sole
cause aggregate.

Verifiche: test HACT-4/runtime 29/29; regressioni HACT-1→3D,
CandidateSelector, BC/BC-8, EC, provider e synthesis 423/423. La projection
reale ha prodotto 40.774 eleggibili e 20 candidati planner, esclusioni tutte a
zero e memoria autorevole invariata.

L'unico ciclo reale autorizzato ha superato preflight e SHADOW con 20
candidati, 1 lettura autorevole, 0 write autorevoli, 0 cache hit, 20 cache
created, 20 certificati esatti, 0 cluster, 0 SuperMemory simulate e 0 commit.
La sola cache embedding dedicata è stata modificata. Nessuna seconda run,
processing-state write, cleanup/delete, modifica `.env`, LIVE o commit Git.

### 2026-07-17 — HACT-5 — Shadow rerun idempotency and failure observability

**Stato:** `VERIFIED` — `HIPPOCAMPUS_SHADOW_RERUN_IDEMPOTENT`

La diagnosi deterministica read-only ha ricostruito gli stessi 20 candidati e
ha validato 20/20 point: identità, content hash, modello, revisione, payload,
fingerprint e vettore risultano coerenti. Anche exact discovery ha prodotto
20/20 certificati completi. Non sono stati eseguiti cleanup, delete, reset,
recreate o overwrite.

Il difetto riproducibile era nel percorso di failure: il controller eliminava
l'errore del runner e la composition sostituiva ogni contatore con zero. Il
motivo tecnico originario della run storica non è ricostruibile dopo quella
normalizzazione e non è stato attribuito senza evidenza. La patch conserva
soltanto reason code, fase e contatori allowlisted già verificati; errori raw,
stack e dati sensibili non raggiungono il report.

Verifiche: test mirati HACT-5 e runtime PASS; suite completa serializzata
762/762 PASS, con zero fail, cancelled, skipped e todo. Il solo rerun reale
autorizzato ha prodotto 20 candidati, 20 cache hit, 0 cache created, 20
certificati exact, 0 cluster, 1 lettura autorevole, 0 write autorevoli, 0 write
processing-state, 0 commit e cache invariata. Il file autorevole è rimasto
byte-identico.

Ippocampo non è ancora collegato a `chat_orbitale_ollama`; la CLI è uno
strumento operativo manuale. Daemon e commit LIVE restano fix futuri separati.
Nessun commit Git.

### 2026-07-18 — HACT-6 — Real SHADOW audit and production gap analysis

**Stato:** `VERIFIED` —
`REAL_SHADOW_VERIFIED_READY_FOR_COMMIT_BRIDGE_DESIGN`

L'audit read-only ha ricostruito deterministicamente la run con limite 100:
40.774 source e 40.774 eleggibili, 100 descriptor dopo il limite projection,
99 candidate planner e un'unica esclusione `DUPLICATE_CONTENT`. Non esiste
seed/query sottratto, off-by-one, perdita silenziosa o errore di conteggio.
`maxCandidates` è un massimo applicato prima e dopo le validazioni, non una
cardinalità target.

I 99 candidati hanno attraversato materialization e identity index completi
(20 hit + 79 create), 99 certificati exact e coverage clustering totale con
zero deferred. Il risultato aggregato dimostra 5 cluster riusciti, 5 chiamate
Qwen riuscite e 5 SuperMemory validate soltanto in RAM. Membership, size,
minimum similarity, temporal provenance e fingerprint per singolo cluster non
sono conservati: `EVIDENCE_NOT_PERSISTED`.

Il runtime SHADOW usa storage autorevole read-only, non possiede commit
capability, non persiste processing state o SuperMemory e non raggiunge daemon
o recall. La chat usa già `RecallRouter` sul proprio storage, ma non importa né
avvia bounded runtime, daemon o commit bridge e non può vedere le SuperMemory
temporanee.

I gap bloccanti per LIVE sono circoscritti: il bounded runtime scarta gli
artifact necessari alla transaction e la projection legacy `raw` in RAM non
soddisfa la precondizione persistente del source claim. Il solo piano successivo
è HACT-7 commit bridge, HACT-8 daemon/chat integration e HACT-9 controlled LIVE
pilot. Audit completo in
`docs/HIPPOCAMPUS_REAL_SHADOW_HACT6_AUDIT.md`. Nessun codice, dato, runtime,
provider o commit Git è stato modificato/eseguito.

### 2026-07-18 — HACT-7 — Bounded SuperMemory commit bridge

**Stato:** `VERIFIED` —
`HIPPOCAMPUS_BOUNDED_COMMIT_BRIDGE_READY_NO_REAL_COMMIT`.

È stato aggiunto un bridge applicativo isolato con `prepare` read-only e
`commit` doppiamente gated. Il prepared conserva artifact bounded, temporal e
synthesis validati, una SuperMemory V1, transition processing canoniche,
snapshot attesi e identità HACT-7 vectorless. Timestamp variabili, ordine
asincrono, batch, endpoint, vettori, centroidi e metriche operative non entrano
nella nuova idempotency key.

Il bridge riusa `SuperMemoryRecord`, `ConsolidationTransaction`, processing
state e coordinator journal/recovery esistenti attraverso adapter iniettati.
Prima e dopo una capability commit rilegge lo storage autorevole e fallisce
chiuso su source stale, scope, processing, replay o conflitto. Receipt e log
sono chiusi e sanitizzati.

HACT-7 è verificato soltanto con fake/in-memory. Non modifica JSON o processing
state reali e non collega daemon, chat, `RecallRouter` o CLI LIVE. La projection
legacy SHADOW resta non autorevole. Test isolati 11/11, regressioni focalizzate
371/371 e suite completa serializzata 773/773 PASS, con zero fail, cancelled,
skipped o todo.

### 2026-07-18 — HACT-8 — Background daemon and chat integration

**Stato:** `VERIFIED` —
`HIPPOCAMPUS_DAEMON_CHAT_INTEGRATION_READY_DEFAULT_OFF`.

È stato aggiunto `scripts/hippocampus-daemon.js`, composition root di processo
separato che riusa il bounded runtime SHADOW standalone. Il default OFF non
costruisce supervisor/runtime, non inizializza provider e non legge storage.
SHADOW richiede conferma, user scope, max candidates e run-once o intervallo
espliciti; LIVE viene rifiutato prima della composition.

Il supervisore usa timer one-shot dopo la conclusione del ciclo, guard
anti-overlap, AbortSignal già esposto dal runtime e stop cooperativo SIGINT/
SIGTERM. Failure e metriche sono sanitizzate; write autorevoli, processing
write, HACT-7 commit e retry/fallback nascosti restano a zero.

La chat non è stata modificata: usa già `JsonMemoryStorage`,
`LegacyRecallAdapter` e `RecallRouter`. Con lo stesso data directory una futura
SuperMemory HACT-7 persistita è leggibile nel tier core; raw e SuperMemory
restano distinte. Chat startup e recall non dipendono dal processo daemon.
Test isolati 10/10, regressioni focalizzate 114/114 e suite completa
serializzata 783/783 PASS, con zero fail, cancelled, skipped o todo.
## HACT-9 — Controlled LIVE pilot (2026-07-18)

Introdotto il gate one-shot LIVE con token/user/limite commit chiusi, capability
server-side, backup verificato e recovery/rollback fake-tested. Test HACT-9 9/9,
regressioni 437/437 e suite completa 792/792 PASS. L'unica preflight reale è
terminata `CONFIGURATION_INCOMPLETE` prima di rete, storage e commit: zero
cluster, zero SuperMemory, zero write e `realDataModified:false`.

Verdetto: `HIPPOCAMPUS_CONTROLLED_LIVE_PILOT_BLOCKED`.

### 2026-07-18 — HACT-9 continuation — authoritative legacy processing boundary

**Stato:** `VERIFIED`, pilot reale bloccato da `CONNECTION_RESET` prima del
primo artifact finalizzabile.

Il composition root HACT-9 ora riusa la pipeline bounded esistente e consegna
soltanto il primo artifact validato tramite capability interna legata a user e
run. Un adapter versionato e limitato al dataset legacy flat `francesco`
interpreta la sola assenza completa di processing come `raw`, costruisce in RAM
le transition canoniche di claim e lascia HACT-7 invariato e fail-closed.
Soltanto il commit atomico dell'unico cluster può persistere processing terminale,
provenance e una SuperMemory; record estranei e campi legacy sono verificati
immutati. SHADOW, daemon e chat restano invariati.

Regressioni focalizzate 686/686 e suite completa unica 800/800 PASS. Preflight,
assenza concorrenza e backup esterno hanno superato il gate. La singola LIVE si
è arrestata con `CONNECTION_RESET`: zero cluster, commit e write autorevoli.
Il dataset è byte-identico al backup (40.774 record, zero SuperMemory/processing),
journal assente e lock rilasciato. Nessun retry o fallback.
