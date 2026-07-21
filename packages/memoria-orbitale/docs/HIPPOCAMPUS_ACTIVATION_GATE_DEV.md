# HIPPOCAMPUS_ACTIVATION_GATE_DEV

## 1. Stato AG-1

**Fase:** `AG-1 Preflight`

**Data:** 2026-07-13

**Decisione:** `AG1_BLOCKED_MISSING_ADAPTER`

Il runtime locale è sufficiente per preparare un smoke test: Node e Ollama sono
presenti, Ollama risponde localmente e `/tmp` dispone di spazio e permessi. Il
cablaggio Ippocampo non è però eseguibile con provider reali perché nel
repository non esistono adapter concreti compatibili con i contratti embedding
e synthesis. Inoltre nessuno dei modelli Ollama installati dichiara capability
embedding.

AG-2 non deve iniziare finché non sono disponibili entrambi gli adapter, un
modello embedding locale esplicitamente approvato e un runner sintetico che
fallisca se `vectorEnabled !== false` o se una directory esce da `/tmp`.

Questa decisione non riapre una fix queue: le sole fasi restano AG-1, AG-2,
AG-3 e AG-4.

## 2. Inventario dei componenti richiesti

| Componente | Interfaccia richiesta | Implementazione concreta | Configurazione/timeout | Dati ricevuti | Failure |
|---|---|---|---|---|---|
| Embedding provider | `{schemaVersion:1, providerId, model, version, getEmbedding({memoryId, embeddingRef})}` | **Assente**. `ClusterEngineAdapter` definisce solo il consumer | modello/versione/base URL espliciti; timeout proposto 30.000 ms nell'adapter | dal core soltanto memory ID e reference opaca; l'eventuale testo sintetico va risolto localmente dall'adapter | il candidato diventa `EMBEDDING_PROVIDER_FAILED`; nessun fallback |
| Synthesis provider | forma chiusa `{schemaVersion:1, providerId, model, version, generate}` | **Assente**. Il trasporto in `chat_orbitale_ollama.js` non è compatibile | modello/versione/base URL; engine timeout 120.000 ms | messages system/user e descriptor source `{id,text,timestamp,type,content_hash}` | timeout/non-ok/schema invalidi falliscono chiusi e sanitizzati |
| Clock | funzione che restituisce epoch millisecondi safe integer | `Date.now` nel daemon; clock iniettabile | nessuna rete; per il runner è preferibile un wrapper monotono di `Date.now` | nessun dato memoria | valore invalido → `INVALID_CLOCK` |
| Storage | capability memory/cluster/atomic/lock e API `JsonMemoryStorage` | `core/JsonMemoryStorage.js` | `dataDir` esplicita sotto `/tmp`; lock dataset in `data/.locks` | JSON sintetico AG-2 | atomic commit/lock fail closed |
| Journal | `append`, `inspect`, `findIncompleteRuns`, `getRunState` | `core/hippocampus/HippocampusJournal.js` | directory esplicita; lock in `journal/.journal-locks` | soli eventi tecnici sanitizzati | corruzione/tail/identity privata bloccano |
| Lock manager | `acquire/release/withLock/inspect/recoverStale` | `core/locking/FileLockManager.js` | default acquire 10.000 ms, retry 25 ms | chiavi hashate e metadata operativi | timeout o ownership mismatch bloccano |
| Recovery manager | inspect/build/execute recovery | `core/hippocampus/RecoveryManager.js` | storage, journal, user DEV, clock; grace default 300.000 ms | fingerprint e ID tecnici | nessuna recovery automatica |
| Maturity approval | `evaluate(clusterCandidate,{approvedClusterIds})` | `core/hippocampus/MaturityGate.js` | default `requireExplicitApproval:true` | cluster candidate strutturale; nessun testo | cluster non approvato deferred |
| Event sink | callback async opzionale | nessun sink runtime necessario; in AG-2 callback locale in-memory | soltanto contatori/reason code | eventi sanitizzati | failure registrata, non altera il run |
| Vector adapter | fuori dal daemon e non cablato | presente soltanto come modulo isolato | `vectorEnabled:false`; non istanziare | nessuno | qualunque tentativo di abilitarlo deve interrompere il runner |

### 2.1 Nota sui metadata embedding

`ClusterEngineAdapter` valida il minimo `schemaVersion + getEmbedding`, ma
`HippocampusDaemon` richiede anche `providerId`, `model` e `version` per creare
il ClusterRecord. L'adapter AG deve quindi fornire tutti e cinque i campi anche
se il contratto minimo dell'adapter cluster ne usa direttamente soltanto due.

### 2.2 Confine privacy provider

Il synthesis provider riceve deliberatamente il testo delle sole source del
cluster, come documentato dal contratto. L'embedding adapter non deve ricevere
la memoria completa dal core: per AG-2 può risolvere `embeddingRef` contro una
map in-memory esclusivamente sintetica e inviare al modello locale solo la
stringa associata. Nessun user ID, meta, tag, prompt journal o path deve entrare
nelle richieste provider.

## 3. Disponibilità dell'ambiente locale

Controlli effettuati senza generate/chat/embed, download o gestione servizi:

| Controllo | Risultato |
|---|---|
| Node | `v18.19.1`, Linux x64 |
| comando Ollama | `/usr/local/bin/ollama` |
| versione Ollama | `0.20.5` |
| processo | `ollama serve` già attivo; non avviato dall'AG |
| listener | `127.0.0.1:11434`, solo loopback |
| `OLLAMA_HOST` | non impostata |
| spazio `/tmp` | circa 85,4 GiB disponibili al preflight |
| permessi probe | directory `0700`, leggibili/scrivibili; cleanup riuscito |

Modelli elencati localmente:

| Modello | ID locale | Capability dichiarate | Ruolo AG |
|---|---|---|---|
| `qwen3.5:4b` | `2a654d98e6fb` | completion, vision, tools, thinking | candidato synthesis |
| `gemma4:e2b` | `7fbdbf8f5e45` | completion, vision, audio, tools, thinking | non selezionato |
| `gemma4:e4b` | `c6eb396dbd59` | completion, vision, audio, tools, thinking | non selezionato |

Nessun modello elencato dichiara capability embedding. Nessun modello è stato
caricato o interrogato e nessun download è stato eseguito.

Il progetto chat configura storicamente un endpoint primario non-loopback e un
fallback localhost. AG-2 deve ignorare entrambi i fallback della chat e usare
esclusivamente `http://127.0.0.1:11434`, senza fallback e senza importare o
avviare `chat_orbitale_ollama.js`.

### 3.1 Nota di igiene della scansione

Una ricerca statica iniziale troppo ampia ha attraversato anche
`apps/orbitale-cockpilot/src/initialData.ts`, asset esportato che contiene
testo storico. I match non sono stati usati nell'analisi e le scansioni
successive hanno escluso esplicitamente `apps/` e tutte le directory dati. Il
file non è stato modificato. Questa deviazione viene registrata per
trasparenza; AG-2 dovrà usare una allowlist di soli moduli/configurazioni.

## 4. Adapter esistenti e mancanti

### 4.1 Trasporti esistenti non riutilizzabili

`chat_orbitale_ollama.js` contiene una chiamata streaming Ollama, ma:

- dipende da configurazione globale e possiede fallback implicito;
- stampa output e metadata a console;
- restituisce una stringa, non `{ok,status,text}`;
- non espone il provider object chiuso richiesto dal SynthesisEngine;
- non implementa embedding;
- importarlo avvia il percorso chat e accede alla directory server.

I prototipi `hyppocampus.js` e `hyppocampo_Jace.js` hanno endpoint hardcoded e
non sono provider accettabili. I servizi embedding citati dai moduli legacy sono
dipendenze astratte, non implementazioni concrete.

### 4.2 Adapter embedding minimo da preparare prima di AG-2

Factory proposta, non implementata in AG-1:

```js
createOllamaEmbeddingProvider({
  baseUrl,
  model,
  modelId,
  timeoutMs,
  resolveInput
})
```

Output pubblico:

```js
{
  schemaVersion: 1,
  providerId: "ollama-local-embedding",
  model,
  version: "ollama-http-embedding-v1+<model-id>",
  getEmbedding: async ({ memoryId, embeddingRef }) => number[]
}
```

Requisiti minimi:

- base URL loopback con protocollo HTTP e porta esplicita;
- `resolveInput` obbligatorio, locale e scoped alla map sintetica AG-2;
- POST non-streaming all'API embedding Ollama usando built-in `fetch`;
- timeout proprio con `AbortController`, perché ClusterEngineAdapter non passa
  un signal;
- response plain, dimensione stabile, array non vuoto di number finiti e norma
  non zero;
- nessun testo/vector/raw response negli errori;
- nessun fallback, cache globale, rete esterna o persistenza;
- model tag e model ID verificati prima dello smoke tramite `ollama list`.

### 4.3 Adapter synthesis minimo da preparare prima di AG-2

Factory proposta, non implementata in AG-1:

```js
createOllamaSynthesisProvider({ baseUrl, model, modelId })
```

La factory deve restituire **esattamente**:

```js
{
  schemaVersion: 1,
  providerId: "ollama-local-synthesis",
  model,
  version: "ollama-http-chat-v1+<model-id>",
  generate: async ({ requestId, messages, signal, responseFormat, maxOutputChars }) =>
    ({ ok, status, text })
}
```

Requisiti minimi:

- endpoint loopback esplicito, POST chat non-streaming;
- inoltro del signal del SynthesisEngine;
- formato JSON richiesto esplicitamente e `think:false`;
- nessun prompt logging, fallback o repair JSON;
- lettura limitata della response e rifiuto prima di accumulare oltre
  `maxOutputChars`;
- non-ok restituito come envelope sanitizzato, senza body provider;
- soltanto `message.content` diventa `text`;
- nessun campo aggiuntivo nel provider object, perché il contratto è chiuso.

## 5. Configurazione proposta senza segreti

Configurazione iniziale AG-2:

```text
AG_DEV_USER=ag2_synthetic_user
AG2_ROOT=/tmp/memoria-orbitale-ag2.<mktemp-random>
AG_DATA_DIR=$AG2_ROOT/data
AG_JOURNAL_DIR=$AG2_ROOT/journal
AG_DATA_LOCK_DIR=$AG_DATA_DIR/.locks
AG_JOURNAL_LOCK_DIR=$AG_JOURNAL_DIR/.journal-locks
AG_OLLAMA_BASE_URL=http://127.0.0.1:11434
AG_EMBEDDING_MODEL=UNSET_BLOCKER
AG_EMBEDDING_MODEL_ID=UNSET_BLOCKER
AG_SYNTHESIS_MODEL=qwen3.5:4b
AG_SYNTHESIS_MODEL_ID=2a654d98e6fb
AG_EMBEDDING_TIMEOUT_MS=30000
AG_SYNTHESIS_TIMEOUT_MS=120000
AG_BATCH_SIZE=500
AG_MAX_CANDIDATES=null
AG_SIMILARITY_THRESHOLD=0.70
AG_MIN_CLUSTER_SIZE=3
AG_MAX_CLUSTER_SIZE=null
AG_MAX_CLUSTERS_PER_RUN=1
AG_APPROVED_CLUSTER_IDS=<empty until cluster dry-run and human approval>
AG_COMMIT_ENABLED=false
AG_VECTOR_ENABLED=false
AG_ALLOW_LEGACY_UNCLASSIFIED=false
```

`AG_VECTOR_ENABLED` è una guardia del futuro runner, non un'opzione da passare
al daemon (che rifiuta proprietà sconosciute). Il modello embedding e il suo ID
restano volutamente unset: inventarli renderebbe il preflight falso.

## 6. Directory isolate AG-2

AG-2 deve creare un'unica root casuale sotto `/tmp` con mode `0700`:

```text
/tmp/memoria-orbitale-ag2.XXXXXX/
  data/                    # solo JsonMemoryStorage sintetico
    .locks/                # creato dal lock manager storage
  journal/                 # solo journal utente sintetico
    .journal-locks/        # lock separato del journal
  reports/                 # report sanitizzati AG-2
```

Il runner deve rifiutare path risolti fuori dalla root e deve verificare che
nessuna directory coincida con `orbitale_chat_data`, `keblo_data`, backup o
directory server. Il probe AG-1 ha verificato creazione, mode 0700, write e
cleanup in `/tmp`; la directory probe è stata rimossa.

## 7. Comandi esatti previsti

I seguenti comandi sono il piano operativo successivo e **non sono stati
eseguiti**. I path adapter/runner sono nomi proposti: finché i file non esistono
il primo blocco deve fallire, coerentemente con la decisione AG-1.

```bash
set -euo pipefail
command -v ollama
ollama list
test -f core/providers/OllamaEmbeddingProvider.js
test -f core/providers/OllamaSynthesisProvider.js
test -f scripts/hippocampus-ag2-smoke.js

export AG_DEV_USER=ag2_synthetic_user
export AG2_ROOT="$(mktemp -d -p /tmp memoria-orbitale-ag2.XXXXXX)"
chmod 700 "$AG2_ROOT"
export AG_DATA_DIR="$AG2_ROOT/data"
export AG_JOURNAL_DIR="$AG2_ROOT/journal"
export AG_OLLAMA_BASE_URL=http://127.0.0.1:11434
export AG_EMBEDDING_MODEL='<approved-local-embedding-model>'
export AG_EMBEDDING_MODEL_ID='<verified-local-model-id>'
export AG_SYNTHESIS_MODEL=qwen3.5:4b
export AG_SYNTHESIS_MODEL_ID=2a654d98e6fb
export AG_EMBEDDING_TIMEOUT_MS=30000
export AG_SYNTHESIS_TIMEOUT_MS=120000
export AG_BATCH_SIZE=500
export AG_SIMILARITY_THRESHOLD=0.70
export AG_MIN_CLUSTER_SIZE=3
export AG_MAX_CLUSTERS_PER_RUN=1
export AG_COMMIT_ENABLED=false
export AG_VECTOR_ENABLED=false

node scripts/hippocampus-ag2-smoke.js --stage preflight
node scripts/hippocampus-ag2-smoke.js --stage plan
node scripts/hippocampus-ag2-smoke.js --stage cluster \
  --write-approved-cluster-id "$AG2_ROOT/reports/approved-cluster-id.txt"

# Solo dopo review umana dell'ID e del report cluster:
export AG_APPROVED_CLUSTER_IDS="$(cat "$AG2_ROOT/reports/approved-cluster-id.txt")"
node scripts/hippocampus-ag2-smoke.js --stage synthesis
node scripts/hippocampus-ag2-smoke.js --stage verify-read-only
```

Nessun comando AG-2 deve importare la chat, avviare Ollama, scaricare modelli o
accettare endpoint non-loopback. Non è previsto alcun token commit in AG-2.

## 8. Scenario e criteri PASS/FAIL AG-2

### 8.1 Dataset sintetico

Il runner deve creare almeno tre memorie V1 esplicite `raw/warm`, con:

- ID tecnici non personali;
- testi sintetici non identici ma chiaramente correlati;
- timestamp espliciti;
- processing raw revision 0;
- `embedding_ref` opachi risolti soltanto da una map in-memory;
- campi sentinella per dimostrare assenza di mutazioni.

Il cluster dry-run deve produrre almeno un cluster di tre membri. Il suo ID deve
essere revisionato e copiato esplicitamente in `approvedClusterIds`; nessuna
auto-approval è ammessa.

### 8.2 PASS

AG-2 passa soltanto se:

1. preflight conferma endpoint loopback, modelli/ID esatti e vector false;
2. status iniziale è unknown e `refreshStatus()` diventa ready su journal
   valido vuoto;
3. plan e cluster dry-run non scrivono processing/cluster/journal;
4. il provider embedding restituisce dimensione coerente per tutte le source;
5. il cluster approvato supera il MaturityGate;
6. synthesis usa il provider locale reale e produce JSON/provenance validi;
7. `writesAttempted === 0`, nessuna super-memory è persistita e tutte le raw
   restano byte-semantically invariate;
8. journal resta valido e senza eventi commit, recovery resta ready;
9. un controllo RecallRouter read-only sui dati sintetici non applica
   reinforcement né accede a deep implicitamente;
10. report/errori/log non contengono prompt, raw output o sentinelle private;
11. nessun file viene creato fuori da `AG2_ROOT`.

La persistenza di super-memory, la prova di raw preservation dopo commit e gli
eventi commit appartengono ad **AG-4 Canary commit**, non ad AG-2. AG-2 verifica
deliberatamente che nessuna super-memory esista dopo il live-provider dry-run.

### 8.3 FAIL

Fallimento immediato in presenza di:

- adapter/modello assente o model ID cambiato;
- endpoint non loopback, fallback o rete esterna;
- embedding invalido/dimensione incoerente;
- nessun cluster maturo esplicitamente approvabile;
- timeout/non-ok/output non JSON/provenance invalida;
- status diverso da ready dopo refresh;
- qualunque write processing/cluster/journal inattesa;
- `commitEnabled` o `vectorEnabled` diversi da false;
- dato personale o path reale nel dataset/report;
- lock residuo, tail journal o file fuori root.

## 9. Rollback e cleanup

AG-2 è read-only rispetto alla pipeline Ippocampo e usa soltanto dati
sintetici. Il rollback è quindi cleanup dell'intera root temporanea:

```bash
test -n "${AG2_ROOT:-}"
case "$AG2_ROOT" in /tmp/memoria-orbitale-ag2.*) ;; *) exit 90 ;; esac
find "$AG2_ROOT" -type f -maxdepth 4 -print
rm -rf -- "$AG2_ROOT"
test ! -e "$AG2_ROOT"
```

Prima del remove il runner deve verificare journal/lock e produrre soltanto un
riepilogo sanitizzato. Non deve fermare Ollama, cancellare modelli o toccare
directory del repository.

## 10. Protezioni verificate e rischi

Protezioni confermate dal codice:

- nessun auto-start all'import/costruttore;
- `runOnce()` usa dry-run/plan per default;
- commit richiede `commitEnabled:true`, mode/phase commit e token esatto;
- commit richiede journal, RecoveryManager e preflight persistente ready;
- status iniziale unknown e refresh esplicito;
- scheduler accetta soltanto dry-run;
- approval cluster esplicita per default;
- vector adapter non è importato dal daemon/runtime;
- JsonMemoryStorage riceve una directory esplicita nel Gate.

Rischi/blocchi correnti:

1. adapter embedding concreto assente;
2. adapter synthesis concreto assente;
3. modello embedding locale assente;
4. `qwen3.5:4b` è soltanto installato: qualità JSON/provenance e compatibilità
   live non sono ancora provate;
5. il transport chat esistente non è riusabile e contiene configurazione
   non-loopback/fallback;
6. i testi vengono inviati al provider synthesis locale: questo confine deve
   restare limitato al dataset sintetico in AG-2;
7. un'allowlist di file è obbligatoria nelle scansioni successive per evitare
   asset esportati o dati server;
8. il worktree resta non protetto da commit/checkpoint Git.

## 11. Decisione e fase successiva

**Decisione AG-1:** `AG1_BLOCKED_MISSING_ADAPTER`.

L'ambiente Ollama locale non è il blocker primario. Per sbloccare AG-2 servono:

1. adapter embedding minimale conforme e testato senza dati reali;
2. adapter synthesis minimale conforme e testato;
3. modello embedding locale scelto, installato mediante autorizzazione separata
   e identificato con tag + model ID;
4. runner AG-2 fail-closed con root `/tmp`, commit false e vector false.

La fase successiva prevista è **AG-2 Synthetic live-provider smoke test**, ma
non è iniziata. AG-3, AG-4, pipeline `remember()`, legacy, server, scheduler,
Qdrant/vector hydration e merge production restano fuori scope.

## 12. Prosecuzione Gate — Qwen Synthesis Provider

**Data:** 2026-07-14

**Verdetto:** `QWEN_PROVIDER_READY_LIVE_SMOKE_DEFERRED`

Questa prosecuzione non crea un nuovo FIX numerato e non completa AG-2 o
l'Activation Gate complessivo. Chiude soltanto il blocker del trasporto
synthesis: embedding BGE-M3, clustering globale, vector path, scheduler e
pipeline sui dati reali restano non collegati.

### 12.1 Chiamata chat esistente ricostruita

La chat configura:

```text
PRIMARY_OLLAMA_URL = process.env.PRIMARY_OLLAMA_URL || http://100.127.150.67:11434/api/chat
PRIMARY_MODEL = process.env.PRIMARY_MODEL || qwen3.5:27b
FALLBACK_OLLAMA_URL = process.env.FALLBACK_OLLAMA_URL || http://localhost:11434/api/chat
FALLBACK_MODEL = process.env.FALLBACK_MODEL || gemma4:e2b
OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 120000)
```

`callOllamaStreamingOnce(url, model, payload)` esegue POST sull'endpoint
Ollama `/api/chat`, imposta `Content-Type: application/json`, usa un signal di
timeout da `AbortSignal.timeout()` o `AbortController`, e serializza il payload
chat esteso con `model` e `think:false`. Il chiamante passa `messages`,
`stream:true`, `think:false` e le options `temperature:0.7`, `top_p:0.9`,
`top_k:10`, `num_ctx:16384`.

La risposta chat è NDJSON streaming: il reader accumula byte, separa per newline,
esegue `JSON.parse` su ogni chunk, concatena `message.content` e richiede
`done:true`; uno stream terminato prima del done fallisce. HTTP non-2xx legge il
body integrale e lo inserisce nel messaggio di errore. `callOllamaStreaming()`
prova il primary e, su qualunque errore, stampa la failure e invoca
automaticamente URL/modello fallback. Inoltre la chat può provare OpenAI prima
di Ollama quando `OPENAI_ENABLED=1` e la chiave è presente.

Questo wrapper non può essere usato da Hippocampus: possiede fallback automatico,
stato/configurazione globali, output console, parsing streaming e forma di ritorno
stringa; non verifica content-type, limite byte, modello dichiarato o redirect e
non restituisce l'envelope V1 `{ok,status,text}`. Importare l'entry point
inizializzerebbe memoria, readline e `main()`. La semantica della chat e il suo
fallback sono rimasti integralmente invariati.

### 12.2 Provider dedicato

È stato aggiunto `core/providers/ollama/OllamaSynthesisProvider.js`. La factory
accetta soltanto la configurazione chiusa `{baseUrl, model, timeoutMs,
maxResponseBytes, keepAlive, fetchImpl}`; `baseUrl` è obbligatorio e deve essere
un URL HTTP(S) senza credenziali, query o fragment, con path esatto `/api/chat`.
I default Activation Gate sono modello `process.env.PRIMARY_MODEL ||
"qwen3.5:27b"`, timeout 120.000 ms, limite response 1 MiB e keep-alive `5m`.

L'oggetto restituito contiene esattamente i cinque campi richiesti dal
SynthesisEngine. I metadata sono:

```text
providerId = ollama-qwen-synthesis
model = qwen3.5:27b
version = ollama-http-chat-v1+qwen3.5:27b
```

La request inoltra esclusivamente i `messages` prodotti dal SynthesisEngine e
imposta modello esplicito, `stream:false`, `format:"json"`, `think:false` e
`keep_alive` esplicito. Non aggiunge prompt, history, memoria chat, dati esterni,
web o repair JSON. Un campo configurazione fallback è rifiutato.

Il trasporto usa `AbortController`, combina timeout proprio e signal esterno,
non segue redirect, valida status, content-type JSON, content-length/body entro
limite, JSON HTTP, envelope Ollama completo con `done:true`, contenuto finale e
modello risposta identico. Un modello differente è una failure di provenance.
Raw envelope, thinking, prompt, source e messaggi provider non entrano nel
risultato o negli errori. 429, 502, 503, 504, connection refused/reset, timeout
e indisponibilità rete sono classificati retryable; gli errori restano
sanitizzati. Il SynthesisEngine conserva parsing/schema/provenance rigorosi e il
daemon conserva la propria transizione failure retryable: nessuna validazione è
stata indebolita.

### 12.3 Test sintetici loopback

`test/providers/ollama-synthesis-provider.test.js` usa soltanto server HTTP
temporanei su `127.0.0.1` e dati sintetici. Risultato: **18/18 test superati**.
Sono stati verificati payload e modello, `stream:false`, assenza fallback,
risposta valida, mismatch modello, timeout, abort, connection failure, HTTP
retryable/non-retryable, JSON HTTP invalido, schema synthesis invalido, body
troppo grande, redirect senza follow, assenza di thinking/raw, errori senza
sentinelle, compatibilità SynthesisEngine, metadata modello/versione,
SuperMemoryRecord sotto `os.tmpdir()`, raw sintetici byte-invariati e zero hit
su un server fallback sentinella. La chat non è stata importata o modificata.

### 12.4 Live smoke Qwen 27B

Il runner riproducibile `scripts/qwen-synthesis-live-smoke.js` usa il medesimo
default primary della chat senza importarne l'entry point, controlla `/api/tags`
con timeout e accetta soltanto il tag esatto `qwen3.5:27b`. Solo dopo tale
preflight può eseguire una singola sintesi su tre ricordi totalmente sintetici,
costruire una SuperMemoryRecord sotto `os.tmpdir()` e verificare i raw. Il
default elimina la directory; `--preserve-temp` è l'unica opzione che la
conserva. L'output è ristretto ai campi sanitizzati richiesti.

Esito del 2026-07-14:

```text
status = DEFERRED_QWEN_UNAVAILABLE
model = qwen3.5:27b
requestId = null
sourceCount = 0
confidence = null
schemaValidation = NOT_RUN
superMemoryId = null
temporaryDirectory = NOT_CREATED
```

Il preflight non ha qualificato contemporaneamente server e tag esatto;
pertanto non è stata effettuata alcuna inferenza, non è stato usato il fallback,
non è stata creata una super-memory temporanea e non è avvenuto alcun commit.
Questo defer non autorizza modifiche permissive al provider.

### 12.5 Stato residuo

Il provider Qwen synthesis è pronto e verificato sinteticamente. La live smoke
reale resta rinviata. BGE-M3/embedding, cluster reali o globali, 40.000 ricordi,
daemon automatico, scheduler, canary commit e Activation Gate complessivo
restano esplicitamente non completati.

### 12.6 Integrità dati e verifica finale

Prima e dopo implementazione/test sono stati confrontati SHA-256, size e mtime
degli 11 file dati già censiti. Esito: **11/11 invariati** su tutti e tre gli
attributi. Nessun test o runner ha puntato alle directory reali. La suite
dedicata finale è 18/18; la regressione repository è 387/387 senza failure,
skip o cancellazioni. Syntax check e diff/whitespace check dei file nuovi sono
superati. Non è stato eseguito alcun commit Git.
