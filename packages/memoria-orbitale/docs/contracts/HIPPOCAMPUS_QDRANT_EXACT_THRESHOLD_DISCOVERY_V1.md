# HIPPOCAMPUS QDRANT EXACT THRESHOLD DISCOVERY V1

## Scope

Questo contratto definisce esclusivamente il prerequisito BC-8 per discovery
Qdrant read-only certificabile. Non modifica `complete-link-greedy-v1`, il
candidate graph, il refiner, `searchNeighbors`, storage, daemon, RecallRouter,
synthesis, SuperMemory o commit.

Il provider pubblico espone soltanto `discoverNeighbors` e dipendenze
iniettate. Non legge ambiente o configurazione globale e non espone create,
upsert, delete, provisioning, retry o fallback.

## Query esatta

Ogni discovery usa una singola Qdrant Query API:

```js
{
  query: queryPointId,
  filter: {
    must: [
      schema_version,
      user_id_hash,
      embedding_model,
      embedding_revision,
      normalized: true
    ],
    must_not: [{ has_id: [queryPointId] }]
  },
  params: { exact: true },
  score_threshold: 0.70,
  limit: maxHitsPerQuery + 1,
  with_payload: true,
  with_vector: false
}
```

La query usa il point ID corrente e il vettore già conservato da Qdrant. Non
carica il query vector nel provider BC-8 e non esegue paginazione. Il transport
deve attestare `exact:true`; una risposta approssimata non può produrre un
certificato.

## Budget

Sono obbligatori:

- `maxHitsPerQuery`, intero tra 1 e 4096;
- `timeoutMs`, entro i limiti del transport Qdrant;
- `maxResponseBytes`, entro i limiti del transport Qdrant;
- `AbortSignal` per ogni query.

Il provider dedicato richiede che timeout e response-byte limit coincidano con
i budget del transport iniettato. Non esistono default, retry o fallback.

## Verifica identità

Il provider è legato a:

- user ID in closure, mai restituito;
- `CurrentEmbeddingIdentityIndex` dello stesso user;
- fingerprint dello snapshot globale BC-1;
- modello e revisione EC-1;
- threshold esatta 0.70.

Ogni hit deve avere point ID UUID V5, score finito almeno 0.70, vector assente
e payload EC-1 con shape esatta. Memory ID, content hash, logical hash, user
hash, modello, revisione e point ID vengono ricostruiti e confrontati con
l'indice corrente. Hit stale, foreign, duplicate, con provenance o point
mismatch rendono l'intera query `FAILED` senza certificato.

Il self-hit viene escluso dal filtro e rimosso difensivamente se ricevuto.

## Cap e certificazione

Dopo la verifica completa:

- fino a `maxHitsPerQuery` vicini unici: discovery
  `COMPLETE_ABOVE_THRESHOLD` e certificato BC-3;
- `maxHitsPerQuery + 1` vicini: `INCOMPLETE_TRUNCATED`, al massimo
  `maxHitsPerQuery` hit tecnici e nessun certificato;
- risposta oltre `maxHitsPerQuery + 1`, malformed, non-exact, timeout,
  oversized, abort o failure: `FAILED`, zero hit e nessun certificato.

Il certificato usa:

- `hippocampus-threshold-discovery-certificate-v1`;
- mode `EXACT_ABOVE_THRESHOLD_ENUMERATION_V1`;
- snapshot fingerprint;
- query point ID;
- threshold, modello e revisione;
- `eligibleIdentityCount = currentIdentityIndex.size - 1`;
- conteggio dei vicini verificati;
- `exhausted:true`, `truncated:false`, `continuation:null`.

`truncated:false` di una API top-k storica non è accettato come prova.

## Determinismo e privacy

Gli hit vengono ordinati per point ID, score e memory ID. L'output è immutabile
e usa la shape BC-2/BC-3. Non contiene testo, vettori, endpoint, API key,
payload raw o user ID. Errori e failure hanno messaggi/codici sanitizzati.

Qdrant resta una cache tecnica non autorevole. Il provider verifica soltanto
identità correnti già costruite dalla fonte autorevole e non crea o modifica
memorie.
