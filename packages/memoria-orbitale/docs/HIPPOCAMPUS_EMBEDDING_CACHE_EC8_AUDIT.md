# HIPPOCAMPUS EMBEDDING CACHE — EC-8 AUDIT INDIPENDENTE

**Data:** 2026-07-15

**Stato:** `VERIFIED`

**Verdetto:** `EMBEDDING_CACHE_READY_FOR_BOUNDED_CLUSTERING_DESIGN`

## 1. Scope e metodo

L'audit ha riesaminato in modo indipendente i contratti EC-1…EC-7 tramite
lettura del codice, regressioni isolate, controlli statici mirati, ispezione
read-only della collection Qdrant reale e benchmark esclusivamente sintetico
con provider in-memory. Non è stata rilanciata la suite repository completa,
già certificata da EC-7 a 536/536.

Durante EC-8 non sono stati modificati file di produzione, test,
configurazioni, collection, indici o point. Non sono stati eseguiti create,
upsert, delete, cleanup, retry automatici, BGE reale, Qwen, daemon, clustering,
lettura di ricordi reali o commit.

La severità usata è:

- P0: perdita/corruzione o violazione critica immediata;
- P1: rischio alto che impedisce l'uso previsto;
- P2: difetto funzionale o architetturale che blocca il prossimo design;
- P3: hardening, limite noto o verifica futura non bloccante.

## 2. Sintesi finding

| Severità | Aperti | Esito |
| --- | ---: | --- |
| P0 | 0 | nessuna corruzione, write o esposizione critica osservata |
| P1 | 0 | nessun rischio alto attivo nel perimetro cache isolata |
| P2 | 0 | `AUD-P2-004` contenuto dal disaccoppiamento e dalle barriere EC-6 |
| P3 | 4 | hardening e limiti espliciti rinviati, non bloccanti per il solo design bounded |

Il verdetto autorizza esclusivamente il design del clustering bounded. Non
autorizza wiring runtime, RecallRouter, daemon, complete-link, dati reali o
promozione di Qdrant a fonte autorevole.

## 3. EC-1 — identity e payload

**Esito: PASS.**

- Collection, modello, revisione, dimensione e normalizzazione sono costanti
  chiuse in `EmbeddingCacheRecord.js:5-11`.
- L'identità usa componenti UTF-8 length-prefixed e SHA-256 deterministico;
  user ID, memory ID, content hash, modello e revisione partecipano
  all'identità (`EmbeddingCacheRecord.js:59-112`).
- Input e payload accettano chiavi esatte; modello, revisione e hash sono
  vincolati e conflitti di identità falliscono chiusi
  (`EmbeddingCacheRecord.js:76-97`, `181-205`).
- Il vettore viene validato prima e dopo `Math.fround()`; il fingerprint è
  SHA-256 dei byte float32 little-endian
  (`EmbeddingCacheRecord.js:124-164`).
- Il payload contiene soltanto nove campi tecnici; user ID è hashato e non
  esistono testo, timestamp o metadata narrativi
  (`EmbeddingCacheRecord.js:166-178`).

Le regressioni verificano determinismo, separazione delle identità, UUID,
canonicalizzazione float32, fingerprint e privacy.

## 4. EC-2 — transport Qdrant

**Esito: PASS.**

- Timeout interno e abort del chiamante sono distinti; timer e listener sono
  rimossi (`QdrantEmbeddingCacheProvider.js:256-291`, `336-340`).
- Content length e stream sono entrambi limitati; UTF-8, content type, JSON ed
  envelope restano fail-closed per ogni endpoint JSON
  (`QdrantEmbeddingCacheProvider.js:139-180`, `315-330`).
- Il body vuoto HTTP 200 è accettato soltanto da `/healthz`; gli altri endpoint
  continuano a richiedere JSON Qdrant valido
  (`QdrantEmbeddingCacheProvider.js:304-313`).
- Errori di rete, timeout, abort, status retryable/non-retryable, redirect e
  response malformate hanno codici sanitizzati. La classificazione conserva
  `retryable` ma non esegue retry.
- L'API pubblica chiusa contiene health, lifecycle, retrieve, upsert, search e
  scroll. Non espone delete, recreate, migrate, clear, fallback o cleanup
  (`QdrantEmbeddingCacheProvider.js:347-489`).

## 5. EC-3 — lifecycle

**Esito: PASS.**

- `ensureCollection()` è inspect-only salvo `allowCreate:true` più token esatto
  `CREATE_HIPPOCAMPUS_EMBEDDING_CACHE_V1`.
- Il contratto accetta esclusivamente vector size 1024 e distanza `Cosine`.
- Gli otto indici richiesti sono: keyword per `content_hash`,
  `embedding_model`, `embedding_revision`, `logical_key_hash`, `memory_id` e
  `user_id_hash`; bool per `normalized`; integer per `schema_version`.
- `vector_fingerprint` deve rimanere non indicizzato.
- Gli indici mancanti sono creati sequenzialmente e la collection viene
  riletta dopo provisioning; non esistono recreate, delete o migrate.
- Il provider viene rifiutato se espone metodi distruttivi
  (`HippocampusEmbeddingCacheAdapter.js:25-48`, `103-116`).

## 6. EC-4 — operazioni exact

**Esito: PASS.**

- Ogni lookup e upsert richiede prima una collection ready in inspect-only.
- Zero point è l'unico miss; point duplicati, inattesi, payload alterati,
  fingerprint errati e collision guard falliscono chiusi.
- Un embedding già identico produce replay senza upsert; un embedding diverso
  sulla stessa identità è un conflitto e non viene sovrascritto.
- Un miss esegue un singolo upsert e richiede acknowledgement più rilettura e
  verifica post-write prima di restituire `created:true`.
- Errori retryable sono preservati senza retry e senza rollback distruttivo.

## 7. EC-5 — coordinator bounded-memory

**Esito: PASS.**

- Il massimo è 4096 item e `embeddingBatchSize` è limitato a 128
  (`BgeM3EmbeddingCacheCoordinator.js:20-24`, `98-124`).
- Lookup, batch BGE e upsert sono sequenziali; non esistono `Promise.all`,
  `Promise.allSettled` o fan-out async globale.
- I miss vengono consumati con `splice(0, embeddingBatchSize)`; response,
  vettori, user ID e testo vengono rilasciati progressivamente
  (`BgeM3EmbeddingCacheCoordinator.js:278-307`).
- L'output è una lista chiusa di identità leggere e conteggi, senza testo,
  user ID o vettori (`BgeM3EmbeddingCacheCoordinator.js:229-237`, `310-319`).
- Fallimento parziale e rerun restano idempotenti: point già verificati
  diventano hit o replay, senza rollback o retry globale.

## 8. EC-6 — neighbor search

**Esito: PASS.**

- `CurrentEmbeddingIdentityIndex` conserva in `WeakMap` privati owner hash e
  identità correnti, espone soltanto lookup immutabili e rifiuta duplicati
  (`CurrentEmbeddingIdentityIndex.js:12-15`, `55-109`).
- La query deve appartenere allo stesso user/index e coincidere con l'identità
  corrente (`HippocampusEmbeddingCacheAdapter.js:499-543`).
- Ogni query Qdrant filtra schema, user hash, modello, revisione e normalized
  (`HippocampusEmbeddingCacheAdapter.js:212-221`).
- Self-hit, point assenti dall'indice e identità stale sono scartati; conflitti
  che impersonano l'identità corrente falliscono chiusi.
- `limit` è obbligatorio, accetta valori oltre cinque fino a 1000 e usa
  overfetch 4× bounded. Non esiste un default implicito cinque
  (`HippocampusEmbeddingCacheAdapter.js:71-73`, `499-558`).
- Il test cross-batch globale resta verde. La top-k search non è esaustiva e
  non viene dichiarata equivalente al complete-link.

## 9. EC-7 — evidenza reale read-only

**Esito: PASS.**

L'ispezione EC-8 ha caricato esclusivamente le quattro variabili ambiente
ammesse e ha avvolto i tre metodi di write del provider con guardie che
falliscono prima del trasporto. Sono stati invocati soltanto health,
`getCollectionInfo`, list, scroll, retrieve e search.

Risultati sanitizzati:

- collection esatta pronta, dimensione 1024, distanza `Cosine`;
- otto payload index corretti e `vector_fingerprint` non indicizzato;
- scroll dell'intera collection con limite 7: esattamente 6 point e nessuna
  pagina successiva;
- tutti i 6 point ID coincidono con le sei identità sintetiche stabili EC-7;
- retrieve bounded 6/6 con payload e vettore: shape EC-1 e fingerprint validi;
- nessun payload contiene testo, user ID chiaro, timestamp o metadata
  narrativi;
- neighbor search read-only: vicino affine cross-batch presente e score affine
  superiore allo score estraneo;
- nomi collection uguali prima/dopo; zero write tentate e zero chiamate BGE;
- Qdrant auth riportata soltanto come `absent-private-network`.

L'audit non ha letto file di memoria o ricordi reali. La collection contiene
soltanto i sei point sintetici attesi.

## 10. AUD-P2-004 e vector path storico

**Esito: CONTAINED — nessun P2 attivo nella cache.**

La scansione degli import non trova `VectorIndexAdapter` o `VectorIndexRecord`
in `core/hippocampus/embedding-cache`, provider EC-2, script EC-7 o runtime.
Fuori da test e documentazione, il vecchio adapter resta confinato a
`core/vector`. `RecallRouter`, `OrbitaleBridge` e `Keblomemory` non importano né
costruiscono la cache embedding.

Qdrant non è autorevole perché:

- la cache non importa storage e non espone operazioni di memoria;
- neighbor search richiede un `CurrentEmbeddingIdentityIndex` costruito dallo
  stato corrente autorevole;
- point non presenti nell'indice o con content hash/modello/revisione stale
  vengono scartati;
- l'output neighbor contiene soltanto `memoryId`, `pointId` e score, non una
  memoria e non payload Qdrant;
- non esiste wiring verso RecallRouter, daemon o commit.

Un point stale non può quindi diventare memoria nel sistema attuale. Il finding
storico `AUD-P2-004` resta un vincolo per qualunque futuro wiring del vecchio
vector path: hydration contro la memoria autorevole e content-hash check non
potranno essere omessi.

## 11. Benchmark RAM sintetico/in-memory

**Esito: PASS per il design bounded.**

Il benchmark è stato eseguito con Node `--expose-gc`, cache fake sempre-miss e
provider embedding fake. Non ha importato né chiamato BGE/Qdrant reali.

| Metrica | Osservato |
| --- | ---: |
| identità sintetiche | 4096 |
| embedding batch size | 128 |
| massimo batch osservato | 128 |
| chiamate fake embedding | 32 |
| upsert fake | 4096 |
| RSS baseline | 48.67 MiB |
| RSS dopo costruzione input | 56.73 MiB |
| RSS massimo | 77.66 MiB |
| delta RSS massimo | 28.99 MiB |
| RSS dopo GC | 77.53 MiB |
| delta RSS dopo GC | 28.86 MiB |

Il risultato contiene 4096 identità leggere e nessun campo testo, user ID,
embedding o vector. Il fake cache adapter non conserva vettori; il massimo
batch è rimasto 128 e il sorgente elimina i riferimenti vettoriali dopo ogni
upsert. Il RSS dopo GC non è interpretato come heap vivo: V8 può trattenere
pagine dell'allocator. La conclusione di non-accumulo deriva congiuntamente dal
bound osservato, dall'assenza di storage nel fake, dall'output chiuso e dal
rilascio sequenziale verificato nel sorgente, non dal solo RSS.

## 12. Sicurezza

**Esito: PASS con hardening P3 rinviato.**

- Errori di provider, adapter, coordinator e script espongono messaggi stabili,
  codici chiusi e al massimo status numerico; endpoint, raw body, API key,
  testo, payload e vettori non entrano nei report.
- L'ispezione reale ha prodotto soltanto conteggi e booleani sanitizzati.
- Qdrant non usa oggi API key: l'accesso EC-7/EC-8 viene consentito soltanto su
  endpoint privato/LAN/Tailscale riconoscibile e viene registrato come
  `absent-private-network` senza host o IP.
- Nessun segreto o endpoint è riportato in questo documento.

## 13. Rischi P3 rinviati

1. **P3-EC8-001 — Qdrant authentication:** aggiungere autenticazione e gestione
   credenziali prima di ampliare il perimetro di rete; oggi resta obbligatoria
   la rete privata/Tailscale.
2. **P3-EC8-002 — top-k vs complete-link:** il futuro design clustering deve
   mantenere limiti espliciti, gestire `truncated` e non assumere esaustività
   dalla neighbor search.
3. **P3-EC8-003 — stale retention:** la cache non implementa delete o pruning;
   una futura policy di capacità/stale cleanup richiederà un fix separato,
   autorizzazione esplicita e protezioni distruttive.
4. **P3-EC8-004 — benchmark envelope:** il profilo RSS è sintetico e dipende da
   runtime/allocator. Prima di attivazioni operative serviranno budget RAM,
   workload bounded rappresentativo e metriche di processo, senza dati reali
   finché non autorizzati.

## 14. Verifiche riproducibili

- regressioni EC-1…EC-7 serializzate: 130/130 passate, zero fail, skip o
  cancellazioni;
- scansione import: zero import del vector path storico nella cache/runtime;
- scansione coordinator: zero parallelismo globale, bound 4096/128 e rilascio
  sequenziale verificati;
- ispezione Qdrant reale read-only: PASS, 6/6 point esclusivamente sintetici,
  zero write tentate;
- benchmark 4096×128 con soli provider fake: PASS;
- suite repository completa non rilanciata, in accordo con lo scope EC-8.

## 15. Verdetto unico

`EMBEDDING_CACHE_READY_FOR_BOUNDED_CLUSTERING_DESIGN`

Il verdetto resta subordinato ai confini dichiarati: design bounded,
CurrentEmbeddingIdentityIndex autorevole, Qdrant non autorevole, nessun wiring
runtime e nessun dato reale.
