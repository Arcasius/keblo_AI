# HIPPOCAMPUS_BOUNDED_CLUSTERING_BC6

## Stato

BC-6 è `VERIFIED`. Il blocker BC-2→BC-3 è stato corretto senza cambiare
threshold, policy, reason code, certificazione o algoritmo complete-link.
Successivamente il benchmark sintetico 100/1k/10k/40k è stato eseguito una
sola volta e ha completato tutti i livelli.

## Causa radice e correzione

Prima del fix, ogni query BC-2 chiamava l'API standalone BC-3 con lo snapshot
raw. BC-3 invocava ogni volta `validateGlobalIdentitySnapshot`, che ricreava,
ordinava e rifingerprintava tutte le N identità. Il costo sparse era quindi
superlineare/quadratico anche con k=0.

`prepareThresholdDiscoveryContext` esegue ora una sola validazione BC-1 prima
della prima provider call, clona e congela le identità correnti e costruisce
lookup privati per point ID e memory ID. Il contesto è frozen, non espone le
Map e vive nella closure di una singola build. L'API standalone precedente è
compatibile e prepara internamente; `CandidateGraphBuilder` usa invece il
percorso preparato per tutte le query della build.

I contatori strutturali per una build con N query dimostrano:

- `preparationCount = 1`;
- `snapshotValidationCount = 1`;
- `globalOrderingCount = 1`;
- `globalFingerprintCalculationCount = 1`;
- `certificateEvaluationCount = N`;
- `certificateQueryLookupCount = N`.

Il test zero-edge completa 100/250/500/1.000 identità con una sola operazione
globale per campione e N lookup. Snapshot stale viene respinto prima di zero
provider call; query estranea e certificate snapshot mismatch restano
fail-closed. Due build successive ricevono contesti e contatori distinti.

Complessità prima: N × O(N log N) per la sola rivalidazione globale. Dopo:
O(N log N) una volta per preparazione, poi O(1) per validazione scalare di ogni
query oltre ai suoi hit, quindi O(N log N + N·k) per graph sparse.

## Dataset e budget

Il dataset è procedurale e contiene tre clique da tre, catena A-B-C non clique,
coppia sparse, componente uncertified/truncated e una componente bounded-degree
molto grande, certificata dal solo fake provider perché esso controlla
integralmente il dataset. Include hit stale, duplicati, ordine hit/proprietà
variabile, timestamp validi/mancanti/invalidi e label batch simboliche. Nessuna
proprietà viene attribuita a Qdrant.

Budget comuni:

| Budget | Valore |
| --- | ---: |
| timeout complessivo per livello | 180.000 ms |
| timeout BC-2 | 120.000 ms |
| timeout BC-4 | 120.000 ms |
| RSS delta massimo | 536.870.912 byte |
| vettori componente in RAM | 32 |
| confronti pairwise | 10.000 |
| dimensione cluster | 8 |
| candidate edge | 3 × identityCount |
| neighbor query | identityCount |

## Risultati del run unico

| Identità | Query | Edge candidate | Edge canonici | Componenti | Complete | Deferred | Pairwise | Max componente | Max vettori | Tempo ms | RSS delta byte |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 100 | 194 | 96 | 7 | 3 | 2 | 21 | 84 | 3 | 407,61 | 9.973.760 |
| 1.000 | 1.000 | 2.003 | 996 | 7 | 3 | 2 | 21 | 984 | 3 | 1.343,70 | 15.728.640 |
| 10.000 | 10.000 | 20.096 | 9.996 | 7 | 3 | 2 | 21 | 9.984 | 3 | 11.457,10 | 62.554.112 |
| 40.000 | 40.000 | 80.405 | 39.996 | 7 | 3 | 2 | 21 | 39.984 | 3 | 47.747,54 | 180.752.384 |

In ogni livello il resolver è stato chiamato 14 volte soltanto, sempre in modo
sequenziale. La componente densa è stata rinviata integralmente con
`DEFERRED_DENSE_COMPONENT`; la componente top-k senza certificato è stata
rinviata con `DEFERRED_INCOMPLETE_NEIGHBOR_DISCOVERY`. Non è stato estratto
alcun sotto-cluster da tali componenti.

## Correttezza e determinismo

Al livello 100 membership, minimum pair similarity e reason code coincidono
esattamente con la reference globale `complete-link-greedy-v1`. La catena
A-B-C non produce mai un cluster di tre.

I run diretto/inverso con ordine hit, proprietà e scheduling async diverso a 100 e
1.000 producono lo stesso digest semantico, inclusi cluster ID, component ID,
membership, minimum pair similarity, reason code e provenance temporale. I
livelli maggiori usano lo stesso percorso canonico; tempo e RSS sono esclusi
dal digest. Le label batch simboliche 1, 2, 17, 50 e 128 non entrano nei
contratti o nelle identità.

BC-5 ha prodotto sezioni chronological/undated e qualità COMPLETE,
PARTIAL_MISSING e PARTIAL_INVALID senza cambiare membership o cluster ID.

## Verifiche

- `node --check`: moduli BC-2/BC-3, harness e test passati;
- test correttivi BC-2/BC-3: 50/50 passati;
- harness BC-6 ridotto: 4/4 passati;
- regressioni BC-1→BC-5: 111/111 passate;
- regressioni EC-1→EC-8: 148/148 passate;
- benchmark 100/1k/10k/40k: un solo run, tutti completati;
- suite repository serializzata, eseguita una sola volta: 650/650 passati;
- privacy, whitespace nello scope BC-6, shape e import: passati. Il
  `git diff --check` globale segnala whitespace preesistente in
  `chat_orbitale_ollama.js`, file estraneo e non modificato da questo fix.

Non sono stati usati rete, Qdrant, BGE-M3, Qwen, storage, daemon, dati reali,
provisioning, SuperMemory, wiring o commit. Il report non contiene liste di
identità, testi, vettori, payload, endpoint o segreti.

## Verdetto unico

`BC6_PASSED`
