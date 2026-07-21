# HIPPOCAMPUS_SCALE_BUDGET_V1

## 1. Scopo

FIX 22 definisce il percorso read-only scalabile per candidate selection e
consolidation plan. L'obiettivo DEV è contabilizzare circa 40.000 memorie senza
troncamento semantico, con budget e telemetria riproducibili.

## 2. Proiezione minimale

`projectMemoryForCandidateSelection()` valida plain data e riusa il rilevamento
flat/nested/hybrid del normalizzatore. La proiezione trattiene soltanto ID, testo,
timestamp, memory kind, storage tier e processing state. Il testo viene convertito
immediatamente nel SHA-256 UTF-8 esatto e non sopravvive negli entry intermedi.
Non sono copiati `sourceSnapshot`, content object, meta, entities, tag o campi
orbitali non usati dalla policy.

Il normalizzatore pubblico e gli input restano invariati.

## 3. API

```js
const { selection, telemetry } =
  await selectConsolidationCandidatesScalable(memories, options);

const { plan, telemetry } =
  await buildConsolidationPlanScalable(memories, options);
```

Le API sincrone legacy condividono le stesse funzioni pure di proiezione,
classificazione, deduplica e finalizzazione. La API scalabile elabora batch
sequenziali e cede il controllo fra batch senza introdurre scheduling semantico.

## 4. Batch e determinismo

`batchSize` è un intero positivo operativo; non è un limite candidate. La
deduplica ID e SHA-256 contenuto è globale e avviene dopo la raccolta delle
proiezioni. Nessun record viene perso tra batch. Batch size 1, 7, 100, 500, 1000
o superiore, ordine differente e array/object map producono identico piano.

`maxCandidates` resta l'unico limite semantico esplicito: gli eccedenti sono
`deferred/LIMIT_EXPLICITLY_APPLIED`, mai cancellati dal report.

## 5. Telemetria e privacy

La telemetria frozen contiene `inputCount`, `processedCount`, `batchCount`,
`batchSize`, conteggi eligible/excluded/deferred e duplicati, `elapsedMs`,
`rssStartBytes`, `rssPeakBytes`, `rssDeltaBytes`, budget, `budgetExceeded` e
`algorithmVersion`.

Non contiene ID memoria, testo, content hash, source snapshot, user ID, prompt,
payload o path. Tempo e RSS sono osservabilità locale e sono esclusi da policy,
decisioni e `planId`.

## 6. Budget V1

Il default esportato e configurabile è:

```js
{
  batchSize: 500,
  budget: {
    maxElapsedMs: 9500,
    maxRssDeltaBytes: 134217728
  }
}
```

Il superamento imposta `budgetExceeded: true` ma non tronca né altera la
selezione. Un `AbortSignal` consente invece di rifiutare in modo controllato tra
batch, senza dichiarare valido un risultato parziale.

## 7. Benchmark riproducibile

Il runner `test/performance/hippocampus-scale-benchmark.js` genera input
sintetico deterministico in RAM, separa generazione e pipeline, esegue warm-up,
usa `process.hrtime.bigint()` e RSS, e riporta mediane senza stampare record.
Accetta `--count`, `--batch-size`, `--runs`, `--max-rss-mib`,
`--max-elapsed-ms` e `--seed`. `--expose-gc` migliora la comparabilità ma non è
richiesto per la correttezza.

Su Node v18.19.1, Linux x64, 40.000 record, batch 500 e tre run, la baseline
locale pre-FIX 22 era 12.227 ms mediani (primo incremento RSS 167 MiB; audit
originario circa 9.500 ms/+252 MiB). Il percorso ottimizzato ha misurato 2.888 ms
mediani, 24,7 MiB RSS mediana e 93,3 MiB come massimo incremento osservato. Ha
prodotto 40.000 decisioni e lo stesso `planId` in ogni run: budget V1 superato.

Queste misure sono un acceptance benchmark sintetico del portatile DEV, non un
benchmark scientifico né una garanzia per hardware o dataset differenti.

## 8. Integrazione e non-obiettivi

HippocampusDaemon usa la pipeline scalabile solo per il piano dry-run. Non sono
aggiunti provider, scritture, rete, migrazioni, vector hydration o Activation
Gate. La fase commit conserva il piano validato esistente. Il budget non
autorizza elaborazione di dati reali.
