# HACT-5 — Shadow rerun idempotency and failure observability

## Stato

`VERIFIED` — `HIPPOCAMPUS_SHADOW_RERUN_IDEMPOTENT`

La queue legacy non contiene HACT-5 e non è stata modificata. Lo stato non è
marcato `completed` automaticamente. Nessun commit Git.

## Diagnosi read-only

Le 20 identità della prima run sono state ricostruite con la stessa projection
legacy, lo stesso planner, lo stesso limite e la provenance cache fissata.
Senza stampare identificativi o dati sensibili sono stati verificati:

- 20 candidati deterministici e 20 content hash coerenti col testo UTF-8;
- 20 point presenti e 20 cache hit;
- payload, modello, revisione, fingerprint e vettori validi per 20/20 point;
- 20 certificati exact completi;
- zero point incompatibili e zero write.

Il report storico aveva perso la causa: `HippocampusActivationController`
intercettava l'eccezione senza conservarla e `HippocampusRuntimeComposition`
restituiva un report vuoto. Di conseguenza anche lettura autorevole, candidati
e hit eventualmente già completati venivano sostituiti con zero. Il motivo
originario antecedente alla normalizzazione non è recuperabile dagli artifact
rimasti; non è stato inventato un guasto cache, perché i 20 point sono validi.

## Correzione minima

Il runner mantiene contatori progressivi esclusivamente dopo operazioni
verificate e produce un envelope di failure chiuso. La composition accetta
soltanto reason code e fasi allowlisted, forza a zero write autorevoli,
processing-state write e commit, e scarta errori raw, stack e campi inattesi.
Una write cache è dichiarata solo dopo acknowledgement del provider.

Sono coperte le fasi authoritative read, legacy projection, cache lookup,
replay verification, exact discovery, clustering, temporal provenance, Qwen,
result normalization e runtime. I codici richiesti sono coperti senza esporre
ID, hash, testi, vettori, payload o endpoint.

## Test

- prima materializzazione crea i point e il rerun identico è hit-only;
- sul rerun BGE e upsert ricevono zero chiamate;
- un content hash diverso genera una nuova identità;
- un point incompatibile fallisce senza overwrite;
- tutte le fasi producono reason code e failure phase sanitizzati;
- metriche parziali verificate sono preservate e write non confermate no;
- errori raw e dati sensibili non sono inclusi;
- regressioni HACT-1→4, EC-4/5/6, BC-8 e provider incluse nella suite completa.

Risultato suite serializzata: 762/762 PASS, zero fail, cancelled, skipped e
todo.

## Unico rerun reale autorizzato

| Contatore | Valore |
| --- | ---: |
| candidateCount | 20 |
| cacheHitCount | 20 |
| cacheCreatedCount | 0 |
| embeddingCacheModified | false |
| exactCertificateCount | 20 |
| clusterCount | 0 |
| authoritativeMemoryReads | 1 |
| authoritativeMemoryWrites | 0 |
| processingStateWrites | 0 |
| commitCalls | 0 |

Preflight e run sono passati, il processo è uscito con codice zero e il file
autorevole è rimasto byte-identico. Non sono state eseguite ulteriori run.

## Confini successivi

Ippocampo non è ancora collegato a `chat_orbitale_ollama`. La CLI standalone è
attualmente uno strumento operativo manuale. Daemon e commit LIVE restano fix
futuri separati; HACT-5 non li autorizza.
