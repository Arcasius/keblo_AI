# HIPPOCAMPUS_BOUNDED_CLUSTERING_BC8_FINAL

## Scope

BC-8 aggiunge esclusivamente la composizione sintetica end-to-end del percorso
bounded. Il percorso storico `ClusterEngineAdapter` non è stato sostituito,
`runOnce` non è stato modificato e il nuovo adapter rimane disabilitato finché
non viene iniettato esplicitamente nel daemon.

Non sono stati letti o modificati ricordi reali, processing state reale,
RecallRouter, collection storiche o storage reale. Non è stato eseguito alcun
commit Git.

## Composizione implementata

`HippocampusBoundedPipelineAdapter` compone in sequenza:

1. source resolver iniettato;
2. verifica di testo e `contentHash`;
3. materializzazione BGE-M3/cache e barriera globale;
4. snapshot identità e `CurrentEmbeddingIdentityIndex`;
5. provider Qdrant exact threshold iniettato;
6. candidate graph bounded e certificati BC-3;
7. bounded complete-link refinement;
8. temporal provenance e temporal synthesis request;
9. rilettura autorevole di ID e `contentHash`;
10. adattamento validato al contratto storico `ClusterRecord`;
11. Qwen `qwen3.5:27b` tramite `SynthesisEngine`;
12. costruzione e validazione in RAM della `SuperMemoryRecord`;
13. output tecnico chiuso, immutabile e sanitizzato;
14. zero capability di commit.

Tutte le dipendenze operative sono iniettate. Il modulo core non legge
l'ambiente e non contiene retry, fallback di modello/provider/algoritmo,
storage o API distruttive.

La temporal synthesis request resta coerente col proprio contratto
`requestOnly`: viene validata come gate fail-closed e impone la rilettura
autorevole prima che il motore di synthesis già verificato possa invocare
Qwen. `currentStateSupported` resta sempre `false`.

## Daemon

`HippocampusDaemon` accetta opzionalmente `boundedPipelineAdapter` e pubblica
`runBoundedSynthetic`. Senza injection il metodo fallisce con
`BOUNDED_PIPELINE_DISABLED`.

Il comportamento predefinito è invariato:

- nessun auto-start;
- `runOnce` continua a usare il percorso storico;
- nessuna attivazione sui dati reali;
- nessuna nuova scrittura o commit;
- nessuna sostituzione di `ClusterEngineAdapter`.

## Fail-closed e boundedness

- threshold inclusiva `0.70`, `minClusterSize=3` e semantica complete-link
  restano nei contratti BC-1→BC-6;
- soltanto componenti con certificati exact validi raggiungono il refiner;
- componenti incomplete, cap+1, dense o fuori budget sono deferred;
- cluster stale alla rilettura non raggiungono Qwen;
- vettori e densità vengono ricalcolati per una sola componente/cluster alla
  volta e poi rilasciati;
- la similarità di compatibilità usa la stessa formula del coseno normalizzato
  del refiner;
- nessun limite implicito di cinque;
- nessun risultato parziale viene dichiarato completo;
- output ed errori non espongono testo, vettori, centroidi, user ID, endpoint,
  API key, payload raw o segreti.

## Test fake end-to-end

| Verifica | Risultato |
| --- | --- |
| cluster certificato di tre source affini | PASS |
| catena A-B-C esclusa | PASS |
| source stale blocca Qwen | PASS |
| discovery incomplete/cap+1 deferred | PASS |
| dense component deferred | PASS |
| timestamp validi e undated separati | PASS |
| “più recente” non abilita current state | PASS |
| Qwen fake solo per cluster finale | PASS |
| SuperMemory temporanea valida | PASS |
| commit calls | 0 |
| storage reale reads/writes | 0/0 |
| diretto/inverso e ordine hit deterministici | PASS |
| sei source, nessun limite implicito di cinque | PASS |
| daemon default disabilitato | PASS |

Test BC-8 isolati: `7/7 PASS`.

## Regressioni e suite

| Verifica | Risultato |
| --- | --- |
| BC-1→BC-6 | 115/115 PASS |
| EC/Qdrant incluso exact prerequisite | 166/166 PASS |
| path focalizzato BC-8/daemon/exact/refiner/temporal | 107/107 PASS |
| suite completa serializzata, unica esecuzione | 676/676 PASS |
| fail / cancelled / skipped / todo | 0 / 0 / 0 / 0 |
| `node --check` | PASS |
| privacy e output shape | PASS |
| import core e assenza ambiente/storage | PASS |
| whitespace nello scope BC-8 | PASS |

La suite completa ha eseguito i benchmark già registrati nel repository; non è
stato avviato separatamente il benchmark BC-6 40k.

## Smoke live sintetica

Sono stati usati soltanto tre source sintetiche nuove, il numero minimo
necessario, con un'identità sintetica isolata. I point sono stati scritti
esclusivamente nella collection dedicata
`memoria_orbitale_hippocampus_embedding_cache_v1`. Non è stata creata alcuna
collection e non è stato eseguito cleanup automatico.

Prima esecuzione effettiva:

| Campo sanitizzato | Valore |
| --- | --- |
| source sintetiche | 3 |
| cache hit/created/replay | 0/3/0 |
| certificati exact | 3 |
| synthesis calls | 0 |
| commit calls | 0 |
| real data modified | false |

Questa esecuzione ha rilevato un mismatch locale nel ricalcolo di compatibilità
del coseno. Il controllo ha operato fail-closed prima di Qwen. È stata applicata
la correzione minima per usare la stessa formula normalizzata del refiner.

Esecuzione di verifica dopo la correzione, senza creare altri point:

| Campo sanitizzato | Valore |
| --- | --- |
| source sintetiche | 3 |
| cache hit/created/replay | 3/0/0 |
| certificati exact | 3 |
| componenti completed/deferred | 0/1 |
| cluster count / sizes | 0 / [] |
| synthesis calls | 1 |
| temporary SuperMemory valid | false |
| commit calls | 0 |
| real data modified | false |
| elapsed | 121653 ms |

La singola chiamata Qwen non ha completato entro il budget esplicito di
120.000 ms. Non sono stati eseguiti retry o fallback. Il cluster è stato
deferred e nessuna `SuperMemoryRecord` è stata dichiarata valida.

### Ripresa smoke 2026-07-16

Il preflight read-only sanitizzato ha confermato:

- endpoint Qwen raggiungibile;
- modello `qwen3.5:27b` disponibile;
- durata preflight: 470 ms.

È stata quindi eseguita una sola nuova smoke BC-8, senza modifiche a codice,
timeout, provider, prompt, contratti o runtime.

| Campo sanitizzato | Valore |
| --- | --- |
| fase terminale | Qwen synthesis timeout |
| source sintetiche | 3 |
| cache hit/created/replay | 3/0/0 |
| nuovi point | 0 |
| certificati exact | 3 |
| componenti completed/deferred | 0/1 |
| synthesis calls | 1 |
| durata Qwen | >=120000 ms |
| durata totale | 121734 ms |
| temporary SuperMemory valid | false |
| commit calls | 0 |
| storage reale reads/writes | 0/0 |
| real data modified | false |

Non sono stati eseguiti retry, fallback, cleanup o delete. Il timeout si è
ripetuto con endpoint raggiungibile e modello disponibile; il risultato resta
fail-closed.

### Chiusura finale dopo ripristino esterno Ollama

Il servizio Ollama e il modello `qwen3.5:27b` sono stati ripristinati e
verificati esternamente. Senza modificare codice, timeout, prompt, provider o
contratti, è stata rilanciata una sola volta la smoke BC-8 esistente.

| Campo sanitizzato | Valore |
| --- | --- |
| stato | PASS |
| source sintetiche | 3 |
| cache hit/created/replay | 3/0/0 |
| nuovi point | 0 |
| certificati exact | 3 |
| componenti completed/deferred | 1/0 |
| cluster count / sizes | 1 / [3] |
| timestamp quality | PARTIAL_MISSING |
| synthesis calls | 1 |
| temporary SuperMemory valid | true |
| commit calls | 0 |
| storage reale reads/writes | 0/0 |
| real data modified | false |
| durata totale | 12069 ms |

I timeout precedenti dipendevano dal servizio Ollama non correttamente
operativo. Dopo il ripristino esterno del modello, lo stesso wiring e gli
stessi contratti hanno completato end-to-end senza retry o fallback.

Non sono stati eseguiti cleanup, delete, test, suite o commit Git.

## Blocker storico chiuso

`BC8-LIVE-001` registrava l'assenza di una smoke live sintetica conclusa con
output Qwen valido e `temporarySuperMemoryValid=true` entro il budget
autorizzato. BGE-M3, cache, snapshot, exact discovery, certificati, candidate
graph e bounded refinement avevano raggiunto correttamente la fase di
synthesis; il blocker osservato era la mancata conclusione della singola
richiesta Qwen nel budget.

Il blocker è chiuso dalla smoke finale autorizzata. Il runtime reale resta
comunque disabilitato: il verdetto certifica esclusivamente il percorso
sintetico end-to-end.

## Verdetto

`HIPPOCAMPUS_SYNTHETIC_END_TO_END_PASSED`
