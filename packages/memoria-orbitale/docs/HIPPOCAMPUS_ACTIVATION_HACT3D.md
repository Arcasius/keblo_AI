# HACT-3D — BGE-M3 preflight provenance mapping

## Stato e verdetti

- `VERIFIED`;
- `BGE_M3_PREFLIGHT_PROVENANCE_FIXED`;
- `HIPPOCAMPUS_REAL_SHADOW_PREFLIGHT_READY`;
- `REAL_SHADOW_RUN_NOT_EXECUTED`.

La coda locale non contiene una voce HACT-3D: non è stata inventata né
applicata alcuna transizione in `automation/fix_queue.json`.

## Riproduzione e causa esatta

La response health reale approvata, priva di `normalized`, riproduceva
`BGE_M3_PROVENANCE_MISMATCH` dopo configuration, storage, Qdrant e embedding
cache PASS; Qwen restava `NOT_RUN`.

Il confronto fallito era `body.normalized === true` in
`createRealPreflightEvaluator`: il valore effettivo era `undefined`. Non era
un problema snake_case/camelCase. La stessa predicate non verificava invece i
campi health obbligatori `status` e `device`.

## Patch circoscritta

La health BGE-M3 viene ora accettata soltanto quando:

- `status === "healthy"`;
- `model === "BAAI/bge-m3"`;
- `revision === "5617a9f61b028005a4858fdac845db406aefb181"`;
- `model_loaded === true`;
- `device === "cuda"`;
- `dimension === 1024`.

`normalized` non viene letto né inventato come dato health. La normalizzazione
resta separatamente garantita dalla configurazione provider
`normalized:true`, dall'envelope embedding, dalla verifica della norma con
tolleranza `1e-3` e dal contratto cache EC-1. Provider BGE-M3, cache e servizio
BGE-M3 sono invariati.

## Test e regressioni

```text
node --check scripts/hippocampus-run.js
node --check test/hippocampus/hippocampus-runtime-preflight.test.js
node --test --test-concurrency=1 test/hippocampus/hippocampus-runtime-preflight.test.js
node --test --test-concurrency=1 test/providers/bge-m3-embedding-provider.test.js test/hippocampus/bge-m3-embedding-cache-coordinator.test.js test/hippocampus/embedding-cache-record.test.js test/providers/qdrant-embedding-cache-provider.test.js test/hippocampus/embedding-cache-collection-lifecycle.test.js test/hippocampus/hippocampus-runtime-preflight.test.js
```

Esiti: syntax PASS; preflight 15/15; regressioni combinate 110/110, zero fail,
cancelled, skipped e todo. I test dimostrano PASS della response reale senza
`normalized`; mismatch per modello, revisione, `model_loaded`, device,
dimensione e status errati; mismatch per ogni campo obbligatorio assente. Le
regressioni provider/cache confermano che `normalized:false` e gli embedding
con norma non valida restano rifiutati.

## Esecuzione reale autorizzata

Una sola GET health BGE-M3 è stata effettivamente inviata: HTTP 200, tutti i
sei campi conformi, `normalized` assente. Un tentativo precedente si era
fermato al parsing dello script locale prima di `fetch` e non aveva prodotto
alcuna richiesta di rete.

Una sola CLI `--preflight-only` è stata eseguita: exit code 0,
`PREFLIGHT_READY`, durata 25444 ms e tutti i check PASS, inclusa Qwen. I
contatori riportano 0 letture ricordi, 0 write autorevoli, 0 write cache e 0
commit. Nessuna SHADOW run, embedding, upsert o commit Git.

## Verdetto

`BGE_M3_PREFLIGHT_PROVENANCE_FIXED`

`HIPPOCAMPUS_REAL_SHADOW_PREFLIGHT_READY`
