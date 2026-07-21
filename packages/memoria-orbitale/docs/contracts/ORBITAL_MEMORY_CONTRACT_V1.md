# ORBITAL_MEMORY_CONTRACT_V1

## Scopo e fonti

Questo documento congela il contratto dati osservato nella versione DEV locale al momento del FIX 1. Descrive il codice e la persistenza esistenti; non introduce una migrazione, un normalizzatore o nuovi comportamenti runtime.

Fonti principali:

- `chat_orbitale_ollama.js`, entry point della chat;
- `core/Keblomemory.js`, creatore e consumatore del contratto flat;
- `core/JsonMemoryStorage.js`, storage JSON operativo;
- `core/MemoryNode.js` e moduli che leggono `memory.orbital`, contratto nested teorico/legacy;
- soli nomi di campo, valori enumerati e forma esterna dei file DEV. Nessun contenuto privato e stato copiato nelle fixture.

## Forma reale dello storage

`JsonMemoryStorage` salva un file JSON per utente e tipo:

```text
<dataDir>/<userId>_memories.json
<dataDir>/<userId>_links.json
```

Il valore persistito e un **object map** indicizzato per `id`:

```json
{
  "mem_example": { "id": "mem_example" }
}
```

`loadMemories()` esegue `Object.values(memories)` e restituisce quindi un **array di plain object**. Non reidrata istanze `MemoryNode`: metodi come `toJSON()`, `isCold()` e `updateAccess()` non sono disponibili sugli elementi caricati.

Lo storage operativo non e JSONL. Il JSONL presente nel progetto riguarda il log append-only degli eventi Echo, non le memorie o i link.

## 1. Contratto flat operativo

`KebloMemory.remember()` crea il seguente shape. I campi indicati come obbligatori sono prodotti per ogni nuova memoria tramite quel percorso; memorie importate o legacy possono ometterli.

| Campo | Tipo corrente | Presenza nel creatore | Default/comportamento corrente |
|---|---|---:|---|
| `id` | string | obbligatorio | generato come `mem_<uuid>` |
| `type` | string | obbligatorio | `episodic`; sono previsti anche `structural`, `semantic`, `working`, ma nei dati importati esistono altri valori |
| `content` | object o variante legacy string | obbligatorio | una stringa passata a `remember()` diventa `{ "text": string }`; un oggetto viene conservato come ricevuto |
| `activation` | number | obbligatorio | calcolato da tipo e importance |
| `orbitalState` | number | obbligatorio | inizialmente uguale ad activation |
| `orbitalLevel` | `short` \| `medium` \| `long` | obbligatorio | derivato da orbitalState |
| `memoryDepth` | string | obbligatorio nel creatore | override valido o valore derivato da importance |
| `dualState` | object | obbligatorio | contiene `cognitive`, `affective`, `lastUpdate` |
| `decay_rate` | number | obbligatorio | dipende da type |
| `tags` | array di string | obbligatorio | `[]` |
| `timestamp` | number | obbligatorio | epoch millisecondi da `Date.now()` |
| `lastAccess` | number | obbligatorio | epoch millisecondi da `Date.now()` |
| `accessCount` | number | obbligatorio alla creazione | `0` |
| `meta` | object | obbligatorio | include `user_id`, `importance`, `emotionalValence`, `version` |
| `cold` | boolean | opzionale | aggiunto dalla compressione legacy |

### Forma di `content`

La forma operativa preferita e:

```json
{ "text": "Testo sintetico" }
```

Sono tuttavia lette varianti legacy:

- `content` oggetto con `text` e campi aggiuntivi come `role`, `entities` o `context_tags`;
- testo top-level in `memory.text`, usato come fallback da chat e moduli temporali;
- `content` stringa in dati legacy. Questo shape non e prodotto da `remember()`, ma deve essere conservato da una futura normalizzazione non mutante.

## 2. Contratto nested teorico/legacy

`MemoryNode` definisce un modello distinto:

```json
{
  "id": "mem_nested",
  "type": "observation",
  "content": {
    "text": "Testo sintetico",
    "entities": [],
    "context_tags": []
  },
  "orbital": {
    "level": "medium",
    "activation_score": 0.3,
    "decay_rate": 0.05,
    "last_access": "2020-01-01T00:00:00.000Z",
    "access_count": 0,
    "birth": "2020-01-01T00:00:00.000Z"
  },
  "cluster": {
    "id": null,
    "density": 0,
    "centroid_ref": null
  },
  "embedding_ref": null,
  "links_summary": {
    "incoming_count": 0,
    "outgoing_count": 0,
    "total_weight": 0
  },
  "meta": {
    "user_id": "synthetic_user",
    "session_id": "synthetic_session",
    "timestamp": "2020-01-01T00:00:00.000Z",
    "version": 1
  }
}
```

Questo shape e consumato da `OrbitalDinamics`, `ClusterEngine`, `EnergyStabilizer`, `GravitationalField` e `MemoryTypes`, ma non e quello creato dal runtime chat corrente.

## 3. Campi condivisi e incompatibilita

| Concetto | Flat operativo | Nested teorico/legacy | Compatibilita attuale |
|---|---|---|---|
| ID | `id` | `id` | condiviso |
| Tipo | `type` | `type` | nome condiviso, vocabolario non chiuso |
| Testo | `content.text`, fallback `text` | `content.text` | parziale |
| Attivazione | `activation` | `orbital.activation_score` | incompatibile senza vista esplicita |
| Stato orbitale smussato | `orbitalState` | non definito nel modello | solo flat |
| Livello orbitale | `orbitalLevel` | `orbital.level` | stesso concetto, path diverso |
| Ultimo accesso | `lastAccess` number | `orbital.last_access` ISO string | path e formato diversi |
| Conteggio accessi | `accessCount` | `orbital.access_count` | path diverso |
| Creazione | `timestamp` number | `meta.timestamp` ISO string e `orbital.birth` | posizione e formato diversi |
| Embedding | non prodotto | `embedding_ref` | solo nested |
| Cluster | non prodotto | `cluster` | solo nested |
| Sommario link | non prodotto | `links_summary` | solo nested |
| Profondita | `memoryDepth` | non definita | solo flat |

I path alternativi non sono alias automatici. Il presente contratto non autorizza a copiarli, sincronizzarli o scegliere implicitamente quale prevale.

## 4. Assi semantici separati

### `orbitalLevel`

Valori correnti: `short`, `medium`, `long`.

Descrive la dinamica orbitale derivata da activation/orbitalState. Non descrive la posizione fisica nello storage. Nel contratto nested lo stesso asse e rappresentato da `orbital.level`.

### `memoryDepth`

Valori osservati nei file DEV: `temporary`, `normal`, `deep`, `historical`.

Il runtime corrente puo inoltre generare o accettare `core`. La funzione corrente accetta come override `temporary`, `normal`, `deep`, `core`; `historical` e una variante persistita/importata, non un override riconosciuto dalla funzione.

Questi valori restano legacy. In particolare `core` e `deep` non devono essere reinterpretati automaticamente come tier di storage.

### `storageTier` — futuro

Vocabolario proposto dal percorso pre-Ippocampo: `core`, `warm`, `deep`.

Il campo non e creato ne persistito automaticamente dal runtime corrente. Le fixture possono rappresentarlo soltanto in un esempio marcato `contractStatus: future`.

### `memoryKind` — futuro

Vocabolario futuro: `raw`, `episodic`, `semantic`, `structural`, `super_memory`.

Non sostituisce automaticamente il campo operativo `type` e non e attualmente prodotto dal runtime.

### `processingState` — futuro

Vocabolario futuro: `raw`, `candidate`, `synthesizing`, `consolidated`, `failed`.

Non e presente nella state machine corrente e non deve essere inferito da `cold`, `memoryDepth`, `type` o `orbitalLevel`.

## 5. Campi temporali osservati

| Campo | Shape | Formato/unita |
|---|---|---|
| `timestamp` | flat | number, epoch millisecondi |
| `lastAccess` | flat | number, epoch millisecondi |
| `dualState.lastUpdate` | flat | number, epoch millisecondi |
| `meta.imported_at` | import legacy | stringa ISO 8601 |
| `orbital.last_access` | nested | stringa ISO 8601 |
| `orbital.birth` | nested | stringa ISO 8601 |
| `meta.timestamp` | nested | stringa ISO 8601 nel costruttore corrente |

Alcuni lettori (`TimeAwareness`) accettano number, stringhe numeriche e stringhe parseabili come date. Questa tolleranza di lettura non rende i formati equivalenti e non autorizza conversioni durante il caricamento.

## 6. Nullable, opzionali e default

- Nel flat operativo `id`, `type`, `content`, activation/orbita, `memoryDepth`, `tags`, campi temporali e `meta` sono prodotti dal creatore, ma non sono garantiti per import legacy.
- Nel nested `embedding_ref`, `cluster.id` e `cluster.centroid_ref` sono nullable.
- `content.text` puo essere vuoto o assente nelle varianti legacy.
- Campi futuri devono essere assenti, non aggiunti con default impliciti, finche non viene approvata la relativa migrazione/state machine.
- Campi sconosciuti sono validi ai fini di round-trip e devono essere preservati.

## 7. Rischio dei default con `||`

Il codice corrente usa spesso `value || default`. Questo tratta come assenti valori validi falsy:

- `activation_score: 0` diventa `0.3` in `MemoryNode`;
- `decay_rate: 0` diventa `0.05`;
- valori numerici `0` in cluster e link possono ricevere altri default;
- `memory.lastAccess || memory.timestamp` ignora un `lastAccess` esplicito pari a `0`;
- `memory.accessCount || 0` conserva casualmente zero, ma non distingue assente da zero.

Un futuro normalizzatore dovra usare controlli di presenza o `??`, senza modificare questo comportamento nel FIX 1.

## 8. Regole di compatibilita congelate

1. Nessuna migrazione implicita al caricamento.
2. Una futura normalizzazione deve produrre una vista nuova e non mutare l'oggetto sorgente.
3. `orbitalLevel`, `memoryDepth` e `storageTier` sono assi distinti.
4. I timestamp storici devono essere conservati nel valore e formato originali.
5. I campi sconosciuti devono sopravvivere a lettura, vista e round-trip.
6. Le memorie raw devono restare recuperabili; consolidamento o tiering non autorizzano cancellazione.
7. L'assenza dei campi futuri non deve essere interpretata come uno specifico stato futuro.
8. Il contratto flat resta il contratto operativo finche una migrazione esplicita non viene autorizzata.
9. Il contratto nested resta una variante distinta; non e automaticamente canonico.

## 9. Decisioni rinviate

- forma definitiva di una vista canonica flat/nested;
- precedenza quando entrambi i path di activation/orbita sono presenti;
- mapping, se necessario, tra `type` e futuro `memoryKind`;
- significato applicativo definitivo di `memoryDepth`, incluso `historical`;
- collocazione e forma persistita di `processingState`;
- schema della provenance delle future super-memory;
- strategia di versionamento e migrazione;
- reidratazione opzionale in istanze di classe;
- contratto cluster, embedding e vector index;
- regole core/warm/deep del futuro RecallRouter.

Queste decisioni richiedono fix separati e non sono deducibili con certezza dal runtime corrente.
