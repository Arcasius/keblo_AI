# HACT-3C — Qdrant health preflight compatibility

## Stato

- `VERIFIED`;
- `QDRANT_HEALTH_PREFLIGHT_FIXED`;
- `HIPPOCAMPUS_REAL_SHADOW_PREFLIGHT_READY` non raggiunto;
- nuova causa preflight: `BGE_M3_PROVENANCE_MISMATCH`;
- `REAL_SHADOW_RUN_NOT_EXECUTED`.

## Scope e causa

Il fix modifica soltanto la lettura della risposta health nel transport di
`QdrantEmbeddingCacheProvider`. La riproduzione isolata tramite l'API pubblica
del provider ha consegnato i 20 byte dichiarati da `Content-Length` senza
chiudere lo stream: il reader attendeva comunque un ulteriore `done`, scadeva
al timeout e restituiva `QDRANT_TIMEOUT` retryable. Il `Content-Type` non era
la causa: il ramo health ammetteva già `text/plain`.

Il ramo health ora termina al raggiungimento esatto del `Content-Length`
validato, cancella il reader residuo e continua invece a leggere fino a EOF le
risposte senza lunghezza dichiarata. Limite dichiarato e limite streamed,
UTF-8, redirect manuale, timeout, AbortSignal e sanitizzazione restano attivi.
La modalità vale soltanto per health; collection, retrieve, upsert, search e
gli altri endpoint continuano a richiedere `application/json`, JSON valido ed
envelope Qdrant valido. Non sono stati introdotti retry o fallback.

## Verifiche sintetiche

- riproduzione pre-fix isolata: `QDRANT_TIMEOUT`, retryable, dopo il timeout;
- riproduzione post-fix isolata: health PASS e reader cancellato esattamente a
  20 byte;
- syntax provider e test: PASS;
- test provider/EC-2: 21/21 PASS;
- regressione HACT-3B: 12/12 PASS.

I test coprono health `200 text/plain` bounded, body health oltre limite,
redirect vietato, timeout retryable, abort chiamante distinto, 401/403
fail-closed, sanitizzazione e permanenza dei vincoli JSON/envelope sulle altre
API.

## Verifiche reali autorizzate

È stata eseguita una sola `provider.health` reale: PASS in 417 ms. È stata poi
eseguita una sola CLI `--preflight-only`: exit code 3, durata 472 ms,
configurazione/storage/Qdrant/collection cache PASS e
`BGE_M3_PROVENANCE_MISMATCH`. Qwen è rimasto `NOT_RUN`.

I contatori della preflight sono rimasti a zero per letture ricordi, write
autorevoli, write cache e commit. Non è stata eseguita alcuna SHADOW run. `.env`,
storage, daemon, clustering, frontend/backend, processing state e provider
BGE/Qwen non sono stati modificati. Nessun commit Git.

## Verdetto

`QDRANT_HEALTH_PREFLIGHT_FIXED`

Il verdetto `HIPPOCAMPUS_REAL_SHADOW_PREFLIGHT_READY` non viene emesso perché
la preflight completa si arresta su `BGE_M3_PROVENANCE_MISMATCH`.
