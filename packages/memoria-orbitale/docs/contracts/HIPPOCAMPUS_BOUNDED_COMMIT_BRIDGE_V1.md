# HIPPOCAMPUS_BOUNDED_COMMIT_BRIDGE_V1

## Scopo

`HippocampusBoundedCommitBridge` è il confine applicativo V1 tra un cluster
bounded finale già validato e la transazione di consolidamento esistente. Il
modulo non esegue clustering, embedding o synthesis, non legge configurazione
globale e non compone daemon, chat, CLI o provider.

HACT-7 verifica il bridge soltanto con storage e capability fake. Non abilita
un percorso LIVE e non autorizza dati reali.

## Dipendenze iniettate

```js
createHippocampusBoundedCommitBridge({
  authoritativeStorage,
  commitCoordinator,
  superMemoryRecordFactory,
  processingStateContract,
  clock,             // opzionale; non entra nell'identità
  commitCapability,  // opzionale, assente in SHADOW
  logger             // opzionale, riceve soltanto receipt sanitizzati
})
```

Il coordinator espone `createPlan()` e `commit()`. L'adapter verificato usa
`createConsolidationCommitPlan()` e `commitConsolidation()` esistenti. Journal
e recovery rimangono responsabilità del coordinator/orchestratore storico:
il bridge non importa, crea o replica `HippocampusJournal` o `RecoveryManager`.

Il `processingStateContract` produce transition plan usando esclusivamente la
tassonomia V1 esistente e valida lo stato autorevole riletto. In HACT-7 i fake
partono da `synthesizing`; la projection legacy `raw` di SHADOW resta tecnica,
in RAM e non autorevole. L'inizializzazione/claim autorevole del legacy è un
obbligo del futuro orchestratore e non viene simulata come write da HACT-7.

## Prepare

`prepare()` accetta esclusivamente:

```js
{
  userId,
  gateSnapshot,
  identityIndexFingerprint,
  cluster,
  temporalProvenance,
  synthesisResult,
  signal
}
```

Cluster, temporal provenance e synthesis result sono rivalidati con i
validator esistenti. Membership e coppie source/content hash devono coincidere
esattamente. Il factory crea e rivalida una `SuperMemoryRecord` V1 e il
coordinator crea un `ConsolidationTransaction` V1. Nessuna source viene letta
o scritta durante prepare.

Il risultato è `{ preparedCommit, receipt }`, profondamente immutabile. In
SHADOW il receipt è `PREPARED/COMMIT_NOT_AUTHORIZED_IN_SHADOW`.

Il prepared contiene soltanto schema/versione, scope tecnico, cluster ID
bounded, SuperMemory validata, identità e hash source canonici, provenance
temporale e synthesis, transition plan, idempotency key HACT-7, fingerprint
attesi e piano transazionale storico. Non contiene vettori, centroidi, payload
Qdrant, endpoint, segreti, raw provider output o metriche operative.

## Adapter di identità V1

`SuperMemoryRecord` V1 e `ConsolidationTransaction` V1 sono contratti storici:
il loro ID include il fingerprint del `ClusterRecord` di compatibilità. HACT-7
non li modifica silenziosamente. Il bridge aggiunge una idempotency key di
confine, versionata e vectorless, derivata da:

- versione bridge;
- algoritmo e cluster ID bounded;
- source ID canonici e SHA-256 del testo UTF-8 esatto;
- modello/revisione embedding;
- schema, prompt e fingerprint dell'output synthesis validato;
- schema e policy temporale.

Timestamp, durata, ordine di risoluzione, batch, host, endpoint e run ID sono
esclusi. Il record storico rimane validabile e committabile dalla transazione
esistente; l'idempotency key HACT-7 impedisce che provenance vectorless e
identità transazionale vengano confuse. Una futura revisione del contratto
`SuperMemoryRecord` potrà unificare i due domini soltanto con migrazione
esplicita e versionata.

## Commit gate

`commit()` accetta esclusivamente:

```js
{
  preparedCommit,
  confirmation: "COMMIT_HIPPOCAMPUS_BOUNDED_V1",
  signal
}
```

Sono necessari simultaneamente snapshot `LIVE`, `liveAuthorized:true`,
`commitAuthorized:true`, conferma esatta e capability server-side V1
`hippocampus-authoritative-commit-v1`. SHADOW viene rifiutato prima di ogni
read. HACT-7 non espone questa conferma in CLI e non effettua wiring LIVE.

## Rilettura e transazione

Prima della capability il bridge carica lo scope autorevole e, per ogni
source, verifica presenza, scope esplicito se disponibile, ID, SHA-256 del
testo normalizzato senza fidarsi di cache/planner/provider, processing state e
assenza di linkage incompatibile. Il coordinator esistente ripete le
precondition sotto lock e applica nello stesso atomic memory write:

- SuperMemory o replay;
- transition di tutte le source;
- linkage source usate → SuperMemory;
- preservazione integrale delle source originali.

Dopo una risposta di commit il bridge rilegge nuovamente lo storage e verifica
record, provenance, stato e linkage. Nessun successo viene emesso prima di
questa verifica.

Replay identico restituisce `IDEMPOTENT_COMMIT_REPLAY` senza write. Record con
stesso ID e semantica diversa restituisce `SUPERMEMORY_CONFLICT` senza
overwrite.

## Receipt e privacy

Il solo output pubblico è un receipt con forma chiusa:

```js
{
  status: "PREPARED" | "COMMITTED" | "IDEMPOTENT_REPLAY" | "REJECTED",
  reasonCode,
  clusterIdHash,
  sourceCount,
  superMemoryIdHash,
  processingStateTransitionCount,
  authoritativeReadCount,
  authoritativeWriteCount,
  commitCalls
}
```

Receipt, log ed errori non espongono testi, sintesi, source ID, content hash,
user ID, path, stack, endpoint o payload. Gli errori sono chiusi sui reason
code HACT-7; `RUN_ABORTED` è propagato in forma sanitizzata.

## Non-obiettivi

HACT-7 non collega daemon, `RecallRouter`, chat o CLI; non modifica processing
state reale, JSON reali, journal, recovery, storage, provider o contratti
storici. Non effettua rete, smoke SHADOW/LIVE, cleanup, delete o commit Git.

