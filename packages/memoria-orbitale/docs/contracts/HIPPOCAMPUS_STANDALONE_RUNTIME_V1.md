# HIPPOCAMPUS_STANDALONE_RUNTIME_V1

## Scopo

HACT-3 definisce un composition root riutilizzabile e una CLI manuale per
Ippocampo. Non introduce HTTP, scheduler o commit autorevole.

Stato architetturale:

- `ACTIVATION_GATE_READY`;
- `CONTROL_PLANE_READY`;
- `HTTP_MOUNT_DEFERRED_TO_KEBLO_SERVER`;
- `DEFAULT_MODE_OFF`;
- `LIVE_RUNTIME_DISABLED`;
- `REAL_SHADOW_RUN_NOT_EXECUTED`.

## Export pubblico

L'entrypoint stabile è:

```js
require("./core/hippocampus")
```

Esporta esattamente:

```js
{
  createHippocampusRuntime,
  createHippocampusActivationController,
  ACTIVATION_MODES
}
```

Non esporta provider configurati, storage globale, daemon, segreti o internals
del clustering.

## Composition root

```js
createHippocampusRuntime({
  configuration: {
    mode,
    operation,
    confirmation,
    userId,
    maxCandidates
  },
  evaluatePreflight,
  runShadow,
  now,
  createAbortController
})
```

Il modulo core non legge `process.env`, non usa filesystem o rete e non importa
provider o storage. Le dipendenze sono iniettate. Una nuova istanza OFF non
esegue preflight e non compone provider.

Le operazioni interne ammesse sono `STATUS`, `PREFLIGHT_ONLY` e `RUN_ONCE`.
SHADOW richiede sempre la conferma esatta:

```text
RUN_HIPPOCAMPUS_SHADOW_V1
```

LIVE viene respinto prima della composizione con
`LIVE_RUNTIME_NOT_AUTHORIZED`.

## CLI

### Stato

```bash
node scripts/hippocampus-run.js --status
```

Anche l'esecuzione senza argomenti equivale a status. Ogni processo parte OFF.

### Preflight SHADOW

```bash
node scripts/hippocampus-run.js \
  --mode SHADOW \
  --preflight-only \
  --confirm RUN_HIPPOCAMPUS_SHADOW_V1
```

Il preflight non legge file di ricordi e non materializza embedding.

### Singolo ciclo SHADOW

```bash
node scripts/hippocampus-run.js \
  --mode SHADOW \
  --run-once \
  --confirm RUN_HIPPOCAMPUS_SHADOW_V1 \
  --user-id <utente> \
  --max-candidates <limite>
```

`max-candidates` è obbligatorio, positivo e limitato a 1000. Non esiste un
default implicito su tutti i ricordi. HACT-3 implementa il percorso ma non ha
eseguito il comando sui dati reali.

## Configurazione esterna

Soltanto lo script CLI legge l'environment. Non usa `node --env-file`.

Per preflight e run futuri sono richiesti:

- `HIPPOCAMPUS_MEMORY_DATA_DIR`: directory autorevole assoluta;
- `HIPPOCAMPUS_QDRANT_URL`;
- `HIPPOCAMPUS_QDRANT_API_KEY`, salvo endpoint privato verificato;
- `HIPPOCAMPUS_EMBEDDING_URL`, con path `/api/v1/embed`;
- `HIPPOCAMPUS_EMBEDDING_API_KEY`;
- `PRIMARY_OLLAMA_URL`, con path `/api/chat`.

`HIPPOCAMPUS_QWEN_TIMEOUT_MS` è opzionale, bounded a 300000 ms e vale 120000 ms
se omesso. Il valore effettivo viene comunque passato esplicitamente ai probe
e al provider.

Non sono stati creati o modificati file `.env`.

## Storage autorevole

Il progetto usa `JsonMemoryStorage` e il layout JSON in
`orbitale_chat_data`. Il suo costruttore crea directory e lock; per preservare
la natura read-only della CLI SHADOW, l'adapter esterno HACT-3 legge lo stesso
layout senza istanziare lo storage scrivibile.

L'adapter:

- accetta solo user ID compatibili con un nome file chiuso;
- restituisce al massimo il limite esplicito;
- ordina deterministicamente per ID;
- rilegge soltanto gli ID del cluster prima della synthesis;
- non espone metodi save, delete, lock o commit.

## Addendum HACT-3B

HACT-3B rende `PRIMARY_MODEL` e `HIPPOCAMPUS_QWEN_TIMEOUT_MS` configurazioni
esterne obbligatorie per il percorso reale. Il default storico del timeout non
viene più usato dal CLI standalone: una chiave assente produce
`CONFIGURATION_INCOMPLETE`. Modello, revisione e dimensione BGE e il nome della
collection restano invece vincolati ai contract provider/EC già autorevoli,
senza nuovi nomi environment.

Il report `--preflight-only` espone `reasonCode`, check separati, nomi delle
sole chiavi mancanti e contatori read/write/commit. Non espone valori di
configurazione o dati runtime. Questa correzione non autorizza LIVE o una run
SHADOW sui ricordi.

## Preflight

Il preflight verifica sequenzialmente e senza retry:

1. configurazione completa;
2. directory storage leggibile;
3. Qdrant raggiungibile;
4. collection
   `memoria_orbitale_hippocampus_embedding_cache_v1` compatibile;
5. BGE-M3 con modello, revisione, dimensione 1024 e normalized esatti;
6. Ollama raggiungibile;
7. modello `qwen3.5:27b` elencato;
8. mini-inference JSON completata con `done_reason: stop`;
9. capability commit assente.

La sola risposta di `/api/tags` non produce readiness Qwen.

## Runner SHADOW

Il runner usa:

- CandidateSelector e ConsolidationPlan correnti;
- coordinator BGE-M3/cache;
- exact threshold discovery Qdrant;
- candidate graph e bounded complete-link refinement;
- temporal provenance;
- Qwen synthesis;
- SuperMemory validata esclusivamente in RAM.

La memoria autorevole è letta soltanto. Processing state, cluster e
SuperMemory non vengono salvati. Non viene iniettata alcuna capability commit.

L'unica write ammessa è `upsertPoints` verso:

```text
memoria_orbitale_hippocampus_embedding_cache_v1
```

Create collection, create index, delete e upsert verso altre collection sono
bloccati. Il report distingue `embeddingCacheModified` da
`realDataModified:false`.

## Interruzione

SIGINT e SIGTERM richiedono stop una sola volta. Il controller propaga
`AbortSignal` e attende l'uscita cooperativa del runner prima di dichiarare
`SHADOW_ABORTED`. I listener vengono rimossi prima dell'uscita.

## Output

stdout contiene un solo documento JSON. stderr è riservato a diagnostica
sanitizzata opzionale.

L'output contiene soltanto stato, modalità, risultato preflight, contatori,
confini di scrittura e durata. Non contiene user ID, testi, hash, memory ID,
point ID, vettori, payload, output Qwen, endpoint, hostname, API key, path,
stack o errori raw.

## Exit code

| Codice | Significato |
| --- | --- |
| 0 | successo/status |
| 2 | argomenti o configurazione CLI invalidi |
| 3 | preflight fallito |
| 4 | run fallita |
| 5 | run interrotta |
| 6 | LIVE non autorizzato |

## Non-obiettivi

HACT-3 non monta API HTTP, non modifica frontend/backend Keblo, non avvia
scheduler, non cambia provider, storage, processing state, commit transaction,
RecallRouter, vector path, collection contract o `.env`.
