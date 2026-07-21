# HIPPOCAMPUS_EMBEDDING_CACHE_V1

## 1. Scopo

EC-1 definisce esclusivamente identità, point ID, validazione embedding,
fingerprint float32 e payload della futura cache embedding Ippocampo. Il modulo
è puro e deterministico: non accede a rete, Qdrant, provider embedding, storage,
daemon, configurazione o dati reali.

Memoria Orbitale resta autorevole. La futura collection
`memoria_orbitale_hippocampus_embedding_cache_v1` sarà una cache ricostruibile e
non una sorgente di memorie.

## 2. Provenance chiusa

Il contratto V1 accetta soltanto:

```text
schemaVersion = 1
model = BAAI/bge-m3
revision = 5617a9f61b028005a4858fdac845db406aefb181
dimension = 1024
normalized = true
normTolerance = 1e-3
```

Modello o revisione differenti sono incompatibili con EC-1 e vengono rifiutati.
Una futura revisione richiederà un contratto esplicito; non esiste fallback.

## 3. Identità logica

L'input chiuso di `createIdentity()` è:

```js
{ userId, memoryId, contentHash, model, revision }
```

`userId` deve essere una stringa non vuota dopo `trim`, `memoryId` una stringa
non vuota e `contentHash` uno SHA-256 lowercase di 64 caratteri. Proprietà
aggiuntive sono rifiutate.

La serializzazione canonica concatena in ordine fisso dominio, schema, userId
normalizzato, memoryId, contentHash, modello e revisione. Ogni componente UTF-8
è rappresentato come `<numero-byte>:<byte>`, rendendo non ambigue identità con
separatori o lunghezze differenti. Non contiene timestamp.

`userIdHash` è SHA-256 dei byte UTF-8 di `userId.trim()`.
`logicalKeyHash` è SHA-256 dei byte dell'identità canonica. L'identità restituita
non conserva `userId` in chiaro.

## 4. Point ID e collision guard

`createPointId()` usa i primi 128 bit di `logicalKeyHash`, imposta UUID version 5
e variant RFC 4122 e restituisce un UUID deterministico. Il payload conserva
l'intero `logical_key_hash` a 256 bit: un futuro retrieve dovrà confrontarlo con
l'identità attesa prima di accettare il point.

Cambio di utente, memoryId o contentHash cambia l'identità. Modello e revisione
non approvati vengono rifiutati, quindi non possono essere selezionati come
versioni compatibili.

## 5. Vettore e canonicalizzazione float32

`validateEmbedding()` richiede un normale array JavaScript di esattamente 1024
numeri finiti. Rifiuta dimensioni differenti, valori non numerici, `NaN`,
infinito, zero vector e norma fuori da `1 ± 1e-3`.

Ogni componente viene poi convertito con `Math.fround()`. Finitezza e norma sono
verificate nuovamente dopo la conversione. Non avvengono normalizzazione,
padding, truncation o correzione silenziosa. Il valore restituito è una copia
float32 congelata.

Qdrant conserva vettori float32. Il fingerprint V1 serializza i 1024 valori
canonicali in 4096 byte IEEE-754 little-endian e calcola SHA-256 sui byte.
Differenze eliminate da float32 producono lo stesso fingerprint; differenze
float32 reali producono fingerprint differenti.

## 6. Payload chiuso e privacy

Il payload contiene esattamente:

```js
{
  schema_version,
  logical_key_hash,
  user_id_hash,
  memory_id,
  content_hash,
  embedding_model,
  embedding_revision,
  normalized,
  vector_fingerprint
}
```

Sono vietati userId in chiaro, testo/content/snippet, title, tag, entities,
timestamp, path, endpoint, API key, processing state, metadata orbitali, prompt,
output modello e qualsiasi proprietà non dichiarata.

`validatePayload()` controlla shape, tipi e hash. Un payload malformato produce
`INVALID_PAYLOAD`; una forma valida che non coincide con identità o vettore
attesi produce `IDENTITY_CONFLICT`.

## 7. API pubblica

```js
createIdentity(input)
createPointId(identity)
validateEmbedding(vector)
createVectorFingerprint(vector)
createPayload(identity, vector)
validatePayload(payload, expectedIdentity, vector)
```

Il modulo esporta inoltre le costanti chiuse e `EmbeddingCacheRecordError` per i
FIX successivi. Non esporta serializzatori interni o funzioni di rete/storage.

## 8. Errori

I codici stabili sono:

- `INVALID_IDENTITY`, categoria `identity`;
- `INVALID_VECTOR`, categoria `vector`;
- `INVALID_PAYLOAD`, categoria `payload`;
- `IDENTITY_CONFLICT`, categoria `conflict`.

Il messaggio è fisso e non include userId, memoryId, hash, vettori o input raw.

## 9. Non-obiettivi EC-1

EC-1 non crea collection, provider Qdrant, adapter cache, batching, lookup,
upsert, search, hydration, stale marking o wiring con HippocampusDaemon. Non
modifica il vector path storico e non autorizza provisioning o dati reali.
