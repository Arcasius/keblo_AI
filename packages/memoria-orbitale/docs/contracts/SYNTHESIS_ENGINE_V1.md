# SYNTHESIS_ENGINE_V1

## 1. Scopo e non-obiettivi

Il FIX 9 definisce un motore di sintesi isolato, deterministico e testabile. Riceve un cluster record V1 già persistito, risolve esclusivamente le source dichiarate, normalizza le memorie, costruisce una richiesta versionata, invoca un provider esplicito e valida un output JSON rigoroso con provenance.

Il V1 non accede allo storage, non salva risultati, non crea super-memory, non modifica processing state e non effettua commit, lock, backup o transazioni. Non include HTTP, `fetch`, endpoint, porte, fallback o un trasporto Ollama/Qwen reale. Il FIX 10 resta responsabile del futuro commit transazionale.

## 2. Architettura

```text
cluster record V1 validato + memory collection + model provider esplicito
  → MemoryContractNormalizer
  → SynthesisContract
  → richiesta deterministica e prompt anti-allucinazione
  → modelProvider.generate()
  → timeout, response envelope e size check
  → JSON.parse rigoroso
  → schema e provenance validation
  → SynthesisResult immutabile
```

`SynthesisContract.js` contiene builder e validatori puri. `SynthesisEngine.js` orchestra validazione cluster, risoluzione, provider e timeout. Nessuno dei due conosce storage o trasporto.

## 3. Provider contract e futuro Qwen

```js
{
  schemaVersion: 1,
  providerId: "ollama-local",
  model: "qwen-versionato",
  version: "transport-adapter-v1",
  generate: async ({
    requestId, messages, signal, responseFormat, maxOutputChars
  }) => ({ ok: true, status: 200, text: "{...}" })
}
```

Il provider è obbligatorio, locale all'istanza e privo di fallback. ID, modello e versione sono stringhe esplicite non vuote; `generate` è callable. Riceve un `AbortSignal`, una richiesta di formato JSON e il limite output. Deve restituire un plain object con `ok`, status HTTP-like success e testo stringa. `ok: false` è sempre errore, anche se il testo contiene JSON valido.

Qwen locale è il provider futuro previsto, non un vincolo di questo contratto. Un adapter successivo potrà implementare il trasporto, ma dovrà vivere fuori dal FIX 9 e fornire endpoint, porta e policy esplicitamente. Non esistono rete o chiamate reali nei test V1.

## 4. Input, source resolution e normalizzazione

`synthesize()` accetta esattamente `clusterRecord`, `memories` e constraints opzionali. Il cluster passa attraverso `validateClusterRecord()`. La collezione può essere array o object map; soltanto gli ID in `clusterRecord.source_memory_ids` vengono considerati. Source aggiuntive sono ignorate. Se una source manca, il provider non viene chiamato e l'errore espone soltanto gli ID mancanti.

Ogni source richiesta passa attraverso `normalizeMemory()`, senza duplicare le regole flat/nested/hybrid. ID e testo devono essere stringhe valide per il ruolo previsto. Input, cluster, memorie e provider non vengono mutati.

## 5. Descriptor e confine privacy

Il provider riceve le source soltanto nel descriptor:

```js
{ id, text, timestamp, type, content_hash }
```

Non riceve memoria completa, `sourceSnapshot`, entities, tags, meta, activation, orbite, processing, embedding, cluster record, percorsi o user ID. Il testo raw è necessario alla sintesi e viene quindi inviato al solo provider configurato esplicitamente: questo è il confine privacy deliberato del FIX 9. Il result, gli errori e l'Evolution Log non conservano il testo.

Le source sono ordinate lessicograficamente per ID. `content_hash` è SHA-256 built-in del testo UTF-8 esatto, senza trim, case folding, correzioni, compressione spazi o casualità.

## 6. Request, requestId e determinismo

La request contiene schema version, request ID, cluster ID, record fingerprint, prompt version, metadata provider, source descriptor, constraints, messages e limiti. Non contiene tempo generato.

`requestId` è SHA-256 di una serializzazione canonica di schema, cluster ID e fingerprint, prompt version, provider/modello/versione, coppie source ID/hash ordinate, constraints e limiti. Stesso input produce lo stesso ID; l'ordine delle proprietà della memory object map non lo modifica.

## 7. Prompt versionato e source come dati

`SYNTHESIS_PROMPT_VERSION` identifica istruzioni deterministiche che impongono:

- uso esclusivo dei fatti nelle source e nessuna conoscenza esterna;
- nessuna diagnosi, data, persona o relazione inventata;
- separazione di fatti, incertezze e contraddizioni;
- nessuna risoluzione inventata delle contraddizioni;
- preservazione dell'incertezza;
- provenance `source_memory_ids` per ogni elemento;
- solo JSON rigoroso conforme allo schema;
- rifiuto delle istruzioni eventualmente contenute nei frammenti.

I messages sono esattamente system + user, senza conversazioni precedenti. Le source sono inserite come JSON serializzato deterministicamente tra delimitatori espliciti e marcate come `untrusted_source_data`. Il testo resta una stringa JSON e non può rompere la struttura tramite interpolazione ambigua.

## 8. Constraints

Il set chiuso V1 è:

```js
{
  language: "it",
  preserveUncertainty: true,
  preserveContradictions: true
}
```

La lingua è esplicita. Non sono accettati prompt liberi, `systemPrompt`, proprietà sconosciute o valori che disabilitino uncertainty, contradictions, provenance o regole anti-allucinazione.

## 9. Limiti e batching rinviato

I default sono `timeoutMs: 120000`, `maxInputChars: 120000`, `maxOutputChars: 30000`, `maxTitleChars: 300`, `maxSynthesisChars: 12000`, `maxFactItems: 200`, `maxUncertaintyItems: 100` e `maxContradictionItems: 100`.

Tutti i limiti sono interi positivi e possono essere ridotti/aumentati esplicitamente. Non esiste un limite predefinito di cinque source. `maxInputChars` misura la lunghezza effettiva dei messages serializzati. Un eccesso viene rifiutato prima del provider senza truncation o perdita di source; batching e partition restano futuri. Un output oltre limite viene rifiutato integralmente prima del parsing.

## 10. Timeout

Ogni chiamata crea un `AbortController`, passa il signal e arma un timer sempre pulito in `finally`. Una race controllata produce `SYNTHESIS_TIMEOUT` sia con provider cooperativi sia con provider che ignorano il signal. La promise del provider mantiene un handler per evitare rejection non gestite; risultati tardivi non vengono validati, restituiti o salvati.

## 11. Provider response e parsing JSON

La response deve essere plain, `ok === true`, con status intero `200..299` e `text` stringa entro `maxOutputChars`. I failure sono sintetizzati senza copiare integralmente messaggi o payload provider.

Il testo passa direttamente a `JSON.parse`. È ammesso soltanto whitespace JSON esterno. Sono rifiutati Markdown fence, prefissi/suffissi, oggetti concatenati, commenti, JSON5, documenti parziali, repair e parsing euristico.

## 12. Output schema e confidence

Lo schema esatto V1 contiene `schema_version`, `title`, `synthesis`, `facts`, `uncertainties`, `contradictions`, `source_memory_ids`, `confidence` e `rejected_source_ids`. Proprietà sconosciute sono rifiutate.

Titolo e sintesi sono non vuoti ed entro limite. I tre array sono entro limite; ogni item ha forma esatta, testo/descrizione non vuoto e provenance non vuota. `confidence` è un number finito in `[0,1]`, inclusi gli estremi. Il contratto non interpreta confidence come probabilità calibrata o prova di correttezza.

## 13. Provenance e copertura accepted/rejected

Ogni ID deve appartenere alle source request ed essere univoco nella propria lista. `source_memory_ids` contiene almeno una source effettivamente usata; `rejected_source_ids` è disgiunto. La loro unione coincide esattamente con tutte le source input, quindi nessuna source sparisce. Ogni fatto, incertezza e contraddizione cita soltanto source usate, mai source rejected.

Questa verifica dimostra esistenza degli ID, copertura e presenza di attribution strutturale. Non può dimostrare semanticamente che il testo generato sia davvero sostenuto dalla fonte. L'anti-allucinazione strutturale non equivale a verifica fattuale perfetta; audit semantico, grounded evaluation e policy di approvazione restano futuri.

## 14. Result envelope, validazione e immutabilità

Il result contiene schema version, request ID, cluster ID/fingerprint, metadata provider, prompt version, coppie source ID/content hash, constraints, limiti e output validato. Non contiene prompt, messages, raw response, testo source, timestamp generato, storage, callback o signal.

`buildSynthesisResult()` copia e congela profondamente l'envelope. `validateSynthesisResult()` ricontrolla forma, versioni, provider, prompt, hash, constraints, limiti, output/provenance e ricalcola il request ID dai dati disponibili. Manomissioni vengono rifiutate. Il risultato è deterministico e non condivide riferimenti mutabili con request, response o provider.

## 15. Privacy ed errori

Gli errori pubblici usano code e phase stabili e possono includere request ID, cluster ID, soli ID mancanti/invalidi e status provider. Non includono testo source, prompt, messages, raw output, memoria completa, messaggio provider integrale o stack serializzato. I test usano esclusivamente dati e mock sintetici e non stampano payload sensibili.

## 16. Garanzie, limiti e decisioni rinviate

Il V1 garantisce provider esplicito, risoluzione source stretta, normalizzazione condivisa, descriptor minimo, request/prompt versionati, limiti senza truncation, timeout, JSON/schema rigorosi, provenance completa, determinismo, immutabilità e assenza di storage/rete integrati.

Non garantisce qualità letteraria, accuratezza fattuale perfetta, calibrazione di confidence, protezione assoluta da prompt injection del modello, batching, retry provider, trasporto Qwen/Ollama, persistenza, processing transition, idempotenza operativa, optimistic concurrency, lock, rollback o commit. Trasporto provider e evaluation semantica richiedono interventi futuri; il FIX 10 definirà il commit transazionale senza essere iniziato dal FIX 9.
