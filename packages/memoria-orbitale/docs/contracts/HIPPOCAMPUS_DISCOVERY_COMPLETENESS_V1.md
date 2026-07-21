# Hippocampus Discovery Completeness V1

Stato del contratto: FIX BC-3.

Questo contratto stabilisce quando una singola query può essere considerata
un'enumerazione completa di tutti i vicini correnti sopra soglia e quando una
componente candidata BC-2 è chiusa. Non esegue refinement complete-link, non
produce cluster finali e non implementa provider reali.

## Regola fondamentale

Un normale risultato top-k resta `INCOMPLETE_UNCERTIFIED`, anche quando:

- `truncated` è `false`;
- il numero di risultati è inferiore al limit;
- non esiste continuation;
- il provider dichiara `COMPLETE_ABOVE_THRESHOLD` senza certificato.

Soltanto un certificato esplicito, valido e legato allo snapshot BC-1 può
produrre `COMPLETE_ABOVE_THRESHOLD` effettivo.

BC-3 verifica il certificato. Non dimostra internamente che il provider abbia
eseguito l'enumerazione e non offre una funzione per fabbricare certificati. Il
provider che emette la mode esatta assume contrattualmente la responsabilità di
avere enumerato l'intero universo corrente sopra soglia.

Nessun adapter Qdrant reale implementa oggi questo contratto.

## Versione e mode

Valori chiusi:

- `certificateVersion`:
  `hippocampus-threshold-discovery-certificate-v1`;
- `mode`: `EXACT_ABOVE_THRESHOLD_ENUMERATION_V1`.

Versioni o mode sconosciute non vengono interpretate né migrate e producono
`INCOMPLETE_UNCERTIFIED`.

## Shape certificato

```js
{
  certificateVersion,
  mode,
  identityIndexFingerprint,
  queryPointId,
  clusterThreshold,
  embeddingModel,
  embeddingRevision,
  eligibleIdentityCount,
  enumeratedAboveThresholdCount,
  exhausted,
  truncated,
  continuation
}
```

La shape è esatta. Campi mancanti o aggiuntivi rendono il certificato
malformato. Il certificato non contiene testo, vettori, centroidi, payload,
userId, endpoint, segreti o batch.

## Binding allo snapshot

`identityIndexFingerprint` deve essere identico allo
`snapshotFingerprint` BC-1 usato dal candidate graph.

`queryPointId` deve:

- essere presente nello snapshot;
- coincidere con la query valutata;
- riferirsi all'identità corrente.

`embeddingModel` e `embeddingRevision` devono coincidere con l'identità
corrente della query. `clusterThreshold` deve essere esattamente la policy BC-1
`0.70`; non sono ammessi arrotondamenti, default o policy alternative.

Un certificato riferito a un altro snapshot, a un point stale/estraneo o a
provenance diversa viene degradato fail-closed, senza esporre il certificato
nell'output.

## Contatori

Per lo snapshot corrente:

```text
eligibleIdentityCount = identityCount - 1
0 <= enumeratedAboveThresholdCount <= eligibleIdentityCount
enumeratedAboveThresholdCount = vicini correnti unici osservati con score >= 0.70
```

I contatori devono essere safe integer. Il builder calcola il numero osservato
soltanto dopo aver rimosso self-hit, foreign, stale, provenance incompatibile,
duplicati e score sotto soglia.

L'uguaglianza fra conteggio certificato e osservato è una verifica di coerenza,
non una prova autonoma che il provider non abbia omesso un vicino. Tale garanzia
resta responsabilità della mode esatta emessa dal provider.

## Exhaustion

Per essere valido il certificato richiede contemporaneamente:

- `exhausted === true`;
- `truncated === false`;
- `continuation === null`.

Queste proprietà sono necessarie ma non sufficienti: senza tutti gli altri
campi validi non esiste certificazione.

## Stato provider ricevuto ed effettivo

BC-3 conserva separatamente:

- `receivedDiscoveryCompleteness`: dichiarazione ricevuta;
- `discoveryCompleteness`: risultato verificato dal contratto;
- `certificateStatus`: `VALID`, `ABSENT` o `INVALID`;
- `certificateFingerprint`: presente soltanto per certificati validi;
- `reasonCode`: motivo chiuso dell'assenza o invalidità.

Un certificato valido può produrre completezza solo se lo stato ricevuto è
`COMPLETE_ABOVE_THRESHOLD`. `FAILED` e `INCOMPLETE_TRUNCATED` non possono mai
essere promossi, anche se accompagnati da una shape di certificato formalmente
valida. `INCOMPLETE_UNCERTIFIED` resta uncertified.

## Reason code certificato

Il vocabolario chiuso distingue:

- certificato assente o malformato;
- version/mode sconosciute;
- snapshot mismatch;
- query non corrente o mismatch;
- provenance o threshold mismatch;
- contatori invalidi o diversi dagli osservati;
- enumeration non exhausted;
- risultato truncated;
- continuation presente;
- stato provider non certificabile;
- query non completata per budget/interruzione.

Gli errori e i reason code sono sanitizzati e non includono input provider,
endpoint o dati della memoria.

## Component closure

Una componente candidata è chiusa esclusivamente quando ogni `memberId` ha una
query con certificato valido e completezza effettiva
`COMPLETE_ABOVE_THRESHOLD`, per lo stesso snapshot e la stessa policy.

Una componente chiusa espone:

```js
{
  closureStatus: "AUTHORIZED_FOR_REFINEMENT",
  reasonCode: null,
  finalizationAuthorized: true
}
```

L'autorizzazione vale esclusivamente come ingresso al futuro BC-4. Non certifica
complete-link, non crea `clusterId`, non dichiara minimum pair similarity e non
produce un cluster finale.

Se anche un solo membro è absent, invalid, truncated, uncertified, failed,
stale o non interrogato, l'intera componente espone:

```js
{
  closureStatus: "DEFERRED",
  reasonCode: "DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY",
  finalizationAuthorized: false
}
```

Non vengono estratti sottoinsiemi e nessun membro viene separato dalla
componente per dichiararlo completo.

Una catena A–B–C interamente certificata è una componente chiusa, ma non è un
cluster: BC-4 deve ancora verificare la similarità A–C e applicare la semantica
complete-link-greedy-v1.

## PARTIAL_DEFERRED

Componenti disgiunte sono valutate separatamente. Se almeno una è chiusa e
almeno una è deferred, lo stato grafo è `PARTIAL_DEFERRED`.

`finalizationAuthorized: true` a livello grafo significa soltanto che esiste
almeno una componente autorizzata per BC-4. Le componenti deferred restano
integralmente deferred e non producono sotto-componenti finali.

## Budget, timeout e abort

Le query non completate per `maxNeighborQueries` o timeout ricevono
`QUERY_NOT_COMPLETED` e `INCOMPLETE_UNCERTIFIED`. Un abort del chiamante fallisce
chiuso; non viene inventato un risultato complete.

Una componente disgiunta già interamente certificata può restare autorizzabile
quando un query budget o timeout interrompe componenti differenti. Questo è il
caso `PARTIAL_DEFERRED` approvato.

Il superamento di `maxCandidateEdges` rende il grafo localmente truncated e
forza tutte le componenti candidate a deferred: un edge scartato potrebbe
alterare la membership, quindi nessuna closure parziale è sicura.

Non esistono retry o fallback automatici.

## Determinismo

Query summary, edge, membri e componenti seguono l'ordine canonico BC-1/BC-2.
Il fingerprint del certificato valido usa serializzazione stabile e non include
metriche operative.

Invertire input, direzione edge o ordine delle risposte non cambia grafo,
closure o autorizzazioni. Batch EC-5 simbolici 1, 17 e 50 non compaiono nel
certificato, negli identificatori o nell'output.

## Output e privacy

Il grafo integra `queryDiscoveries`, ordinato per identità canonica. Contiene
solo pointId, stati, reason code e fingerprint del certificato. Il certificato
raw non viene restituito.

Tutto l'output è profondamente immutabile e vectorless. Non contiene testo,
contenuto memoria, userId chiaro o hash, vettori, centroidi, payload Qdrant,
endpoint, chiavi o segreti.

## Confine BC-3

BC-3 termina con la closure delle componenti candidate. Non implementa:

- retrieval vettori bounded;
- ricalcolo delle similarità;
- complete-link refinement;
- cluster finali;
- temporal ordering;
- synthesis o SuperMemory;
- storage, daemon o wiring;
- provider Qdrant/BGE/Qwen reali.

Il passo successivo autorizzato è esclusivamente BC-4 sulle componenti chiuse.
