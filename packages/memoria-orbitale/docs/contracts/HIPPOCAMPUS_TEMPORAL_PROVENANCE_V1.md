# HIPPOCAMPUS TEMPORAL PROVENANCE V1

## 1. Scope

BC-5 aggiunge provenance temporale vectorless ai cluster semanticamente
verificati da BC-4. Non modifica membership, complete-link, cluster ID o piano
BC-1 e non esegue synthesis. Non legge storage, testo o dati reali e non
invoca provider, rete, Qwen, Qdrant o BGE.

I moduli puri sono:

- `HippocampusTemporalProvenance.js`;
- `HippocampusTemporalSynthesisRequest.js`.

## 2. Ispezione read-only dello schema esistente

L'ispezione di codice, contratti e sole fixture sintetiche ha osservato:

| Sorgente | Campo | Formato osservato | Interpretazione BC-5 |
| --- | --- | --- | --- |
| flat operativo | `timestamp` | number, millisecondi epoch | `recordedAt` autorevole |
| flat operativo | `lastAccess` | number, millisecondi epoch | metrica operativa esclusa |
| flat storico fixture | `timestamp` | number, anche `0` o negativo | `recordedAt` valido |
| legacy | `timestamp` | stringa numerica | non convertita, invalida per BC-5 |
| nested teorico | `meta.timestamp` | ISO 8601 string | nessuna precedenza inventata |
| nested teorico | `orbital.birth` | ISO 8601 string | non promosso a `recordedAt` |
| nested teorico | `orbital.last_access` | ISO 8601 string | metrica operativa esclusa |

`JsonMemoryStorage` conserva oggetti JSON senza migrazione temporale.
`MemoryContractNormalizer` e `CandidateSelector` espongono una vista tecnica con
precedenza flat→nested, ma non definiscono autorità semantica e non validano il
tempo dell'evento. `ConsolidationPlan` trasporta il valore `timestamp` nelle
decisioni senza trasformarlo in cronologia narrativa.

Nessun campo strutturato `eventTime` è presente nel contratto flat operativo o
nelle fixture. BC-5 non interpreta testo e non chiama LLM per ricavarlo.

## 3. Distinzione temporale

- `recordedAt`: momento di registrazione. In V1 proviene soltanto da
  `timestamp` del source contract esattamente `flat`, se è un safe integer
  finito. Millisecondi epoch negativi e zero sono preservati.
- `eventTime`: momento dell'evento. Resta `null/UNKNOWN` salvo un'evidenza
  strutturata con contratto esplicito
  `EXPLICIT_STRUCTURED_EVENT_TIME`; non deriva mai da `recordedAt`.
- `lastAccess`: metrica operativa. Può essere presente nell'input tecnico ma è
  ignorata e non compare nell'output, nell'ordine o nell'identità.

Nested, hybrid e unknown ricevono
`recordedAtStatus: UNSUPPORTED_SOURCE_CONTRACT` e restano undated. BC-5 non
sceglie tra `meta.timestamp`, `orbital.birth` o path flat/nested concorrenti.

## 4. Input temporale

```js
createTemporalClusterProvenance({
  identitySnapshot,
  boundedClusteringPlan,
  clusterId,
  sources: [{
    memoryId,
    contentHash,
    sourceContract,
    timestamp,
    lastAccess,
    eventTimeEvidence
  }]
})
```

Snapshot e piano devono essere output immutabili e validi BC-1/BC-4. Il
`clusterId` deve identificare un cluster verificato del piano. Ogni membro deve
apparire una volta e il `contentHash` deve coincidere con lo snapshot; stale,
duplicati, omissioni e source estranee falliscono chiusi.

L'input source ha shape chiusa e non accetta testo, content narrativo, payload,
vettori o centroidi. L'eventuale evidenza event time V1 è:

```js
{
  evidenceContractVersion: 1,
  authority: "EXPLICIT_STRUCTURED_EVENT_TIME",
  eventTime: 0
}
```

Un'evidenza assente produce `eventTime:null` e `eventTimeStatus:UNKNOWN`; una
shape incompatibile fallisce chiusa.

## 5. Output temporale

```js
{
  schemaVersion: 1,
  temporalPolicyVersion: 1,
  clusterId,
  sourceIds,
  chronologicalSourceIds,
  undatedSourceIds,
  temporalStart,
  temporalEnd,
  timestampQuality,
  sourceTimeDescriptors: [{
    memoryId,
    contentHash,
    recordedAt,
    recordedAtStatus,
    eventTime,
    eventTimeStatus
  }]
}
```

`sourceIds` resta la membership canonica BC-4. Le source con recordedAt valido
sono ordinate per valore crescente e poi per memory ID. Le altre sono separate
in `undatedSourceIds`, ordinate per ID. I due insiemi sono disgiunti e coprono
esattamente `sourceIds`.

`temporalStart` e `temporalEnd` derivano soltanto dai recordedAt validi. Senza
valori utilizzabili sono entrambi null. Nessun timestamp viene corretto,
parsato, sostituito o inventato.

## 6. timestampQuality

- `COMPLETE`: tutti i recordedAt sono validi;
- `PARTIAL_MISSING`: esiste almeno una source missing/unsupported, nessuna è
  invalida e almeno una è valida;
- `PARTIAL_INVALID`: esiste almeno una source invalida e almeno una è valida;
- `UNKNOWN`: nessun recordedAt è utilizzabile.

`UNKNOWN` ha precedenza quando il set valido è vuoto, perché non esiste alcun
range temporale dimostrabile.

## 7. Contratto request synthesis temporale

`createTemporalSynthesisRequest({ temporalProvenance })` costruisce soltanto un
request contract immutabile e versionato. Non modifica `SynthesisContract` V1
e non invoca provider.

Il request contiene esattamente due sezioni ordinate:

1. `RECORDED_AT_CHRONOLOGY`;
2. `UNDATED_SOURCES`.

Ogni reference contiene solo memory ID, content hash e descrittori temporali.
Il futuro runtime deve rileggere ogni source autorevole e richiedere match di
memory ID/content hash; mismatch significa `FAIL_CLOSED`.

La policy dichiara esplicitamente:

- recordedAt non equivale a eventTime;
- lastAccess è escluso;
- il source più recente non è automaticamente lo stato attuale;
- cambiamenti, contraddizioni e supersessioni devono essere preservati.

Il campo versionato `currentStateEvidence` nasce con:

```js
{
  evidenceContractVersion: 1,
  evidenceStatus: "NOT_PROVIDED",
  currentStateSupported: false,
  evidenceReferences: []
}
```

BC-5 non lo valorizza automaticamente. Un futuro supporto di evidenza
autorevole esplicita richiederà un contratto/versione successiva.

## 8. Identità, privacy e determinismo

Cluster ID e membership provengono immutati da BC-4; ordine cronologico,
timestamp e metriche non vengono usati per ricalcolare il cluster ID. Il
request ID synthesis è separato e lega la provenance temporale completa.

Output diretto/inverso è identico e profondamente immutabile. Non contiene
testo, vettori, embedding, centroidi, payload provider, user ID, endpoint,
segreti o callback. I moduli importano soltanto contratti puri e `node:crypto`
per il request ID.
