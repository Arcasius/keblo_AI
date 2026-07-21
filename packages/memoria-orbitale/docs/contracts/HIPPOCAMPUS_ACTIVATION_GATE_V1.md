# HIPPOCAMPUS_ACTIVATION_GATE_V1

## Scopo

HACT-1 definisce un gate backend puro e fail-closed per una singola decisione
di attivazione Ippocampo. Il gate non compone provider, non costruisce il
daemon, non legge configurazione globale e non esegue cicli.

Stato architetturale:

- `SYNTHETIC_END_TO_END_VERIFIED`;
- `REAL_RUNTIME_DISABLED`;
- `DEFAULT_ACTIVATION_MODE_OFF`.

## API

```js
createHippocampusActivationGate({
  mode,
  liveConfirmation,
  commitCapability,
  storageCapability
})
```

La configurazione omessa equivale a `{ mode: "OFF" }`. Ogni invocazione crea
una decisione indipendente; non esiste stato globale o transizione fra cicli.

L'output ha esattamente questa forma ed è profondamente immutabile:

```js
{
  mode: "OFF" | "SHADOW" | "LIVE",
  activationAuthorized: boolean,
  shadowAuthorized: boolean,
  liveAuthorized: boolean,
  commitAuthorized: boolean,
  reasonCode: string
}
```

## Modalità

### OFF

OFF è il default di ogni nuova istanza/processo. Tutte le autorizzazioni sono
false e il reason code è `ACTIVATION_OFF`.

HACT-1 non possiede riferimenti a provider, storage, daemon o scheduler:
l'output OFF non può quindi comporli o invocarli.

### SHADOW

SHADOW richiede `mode: "SHADOW"` esplicito:

- `activationAuthorized=true`;
- `shadowAuthorized=true`;
- `liveAuthorized=false`;
- `commitAuthorized=false`;
- reason code `SHADOW_AUTHORIZED`.

Una capability commit eventualmente iniettata viene validata ma non invocata
e non diventa autorizzata. HACT-1 non esegue ancora una shadow run.

### LIVE

LIVE non degrada mai a SHADOW e richiede simultaneamente:

1. `mode: "LIVE"`;
2. token esatto `ENABLE_HIPPOCAMPUS_LIVE_V1`;
3. capability commit esplicita;
4. attestazione storage compatibile e verificata.

La capability commit ha forma chiusa:

```js
{
  schemaVersion: 1,
  capabilityId: "hippocampus-authoritative-commit-v1",
  commit: Function
}
```

Il gate verifica soltanto la forma e non chiama `commit`.

L'attestazione storage è distaccata dal backend operativo:

```js
{
  schemaVersion: 1,
  contractVersion: "hippocampus-live-storage-capability-attestation-v1",
  capabilities: [
    { capability: "commit.atomic", status: "supported", verified: true },
    { capability: "lock.acquire", status: "supported", verified: true },
    { capability: "lock.release", status: "supported", verified: true },
    { capability: "memory.readAll", status: "supported", verified: true },
    { capability: "memory.writeAll", status: "supported", verified: true }
  ]
}
```

La lista è canonica, ordinata e coincide con i requisiti storage della
transazione autorevole esistente. La futura composition root dovrà produrre
l'attestazione dopo l'ispezione del backend; HACT-1 non importa né ispeziona
lo storage reale.

Anche con tutti i requisiti validi, `LIVE_AUTHORIZED` autorizza soltanto la
decisione del gate. HACT-1 non collega il wiring LIVE e non esegue commit.

## Reason code

- `ACTIVATION_OFF`
- `SHADOW_AUTHORIZED`
- `LIVE_CONFIRMATION_REQUIRED`
- `LIVE_COMMIT_CAPABILITY_REQUIRED`
- `LIVE_STORAGE_CAPABILITY_REQUIRED`
- `LIVE_AUTHORIZED`
- `INVALID_ACTIVATION_MODE`
- `INVALID_ACTIVATION_CONFIGURATION`

Modalità sconosciute, booleani ambigui, proprietà non previste, accessor e
capability malformed producono errori tipizzati e sanitizzati.

## Preflight puro

`HippocampusActivationPreflight` è un contratto separato per rappresentare
evidenza futura senza eseguire chiamate:

- Qdrant pronto;
- collection cache pronta;
- BGE-M3 pronto con modello, revisione, dimensione e normalizzazione esatti;
- Ollama raggiungibile;
- Qwen elencato e capace di completare una mini-inference JSON con
  `doneReason: "stop"`;
- storage autorevole disponibile con attestazione valida;
- capability commit presente soltanto per readiness LIVE.

La sola presenza del modello in `/api/tags` lascia
`qwen.verifiedReady=false`. `shadowReady` richiede tutte le evidenze operative
read/analysis, mentre `liveReady` richiede inoltre la presenza della capability
commit.

Il report preflight è chiuso, profondamente immutabile, privo di timestamp e
non contiene endpoint, API key, user ID, testi, path, payload o vettori.

## Privacy e side effect

I moduli HACT-1:

- non hanno import;
- non leggono `process.env`;
- non usano rete o filesystem;
- non importano frontend, daemon, Qdrant, BGE, Qwen, RecallRouter o storage;
- non eseguono read, write, commit, cleanup o delete.

## Non-obiettivi

HACT-1 non modifica frontend, API HTTP, scheduler, daemon, storage,
processing state, commit transaction, collection Qdrant, provider, RecallRouter
o vector path storico. La composition root operativa resta un fix futuro.
