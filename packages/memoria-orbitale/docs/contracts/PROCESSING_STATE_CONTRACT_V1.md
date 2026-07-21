# PROCESSING_STATE_CONTRACT_V1

## 1. Scopo

Il FIX 6 definisce una macchina a stati pura, deterministica e versionata per il futuro ciclo di consolidamento. `ProcessingState.js` crea e valida stati persistibili futuri e produce piani di transizione read-only. Nessuna transizione è automatica e un piano non autorizza una scrittura.

## 2. Non-obiettivi

Il V1 non modifica dati o fixture, non migra legacy, non deduce `raw`, non integra storage o Ippocampo, non promuove candidate, non crea cluster, lock o commit e non chiama modelli.

## 3. Schema persistibile futuro

```js
{
  schema_version: 1,
  state: "raw|candidate|synthesizing|consolidated|failed",
  revision: 0,
  attempt_id: null,
  updated_at: 1780000000000,
  error: null
}
```

La forma è completa, plain, profondamente congelata e separata dall'input. Sono rifiutate proprietà sconosciute e versioni diverse da `1`. Il FIX 6 non aggiunge questa struttura alle memorie.

## 4. Stati e significato

- `raw`: memoria esplicitamente disponibile, non candidata.
- `candidate`: candidatura esplicita già acquisita, non ancora in sintesi.
- `synthesizing`: tentativo identificato in corso.
- `consolidated`: tentativo concluso con successo; terminale nel V1.
- `failed`: tentativo concluso con errore strutturato; richiede decisione esplicita di retry o reset.

Maiuscole, alias e typo non vengono corretti.

## 5. Revision

`revision` è un intero `>= 0`. Una nuova struttura usa `0`; `createProcessingState()` consente un valore esplicito valido per import/validazione di uno stato futuro già revisionato. Ogni transition plan incrementa esattamente di uno. La revision non deriva dall'orologio e costituisce una futura precondizione di optimistic concurrency.

## 6. Attempt ID

`attempt_id` è `null` in `raw` e `candidate`. È una stringa non vuota e non composta solo da whitespace in `synthesizing`, poi viene conservato senza cambiamenti in `consolidated` o `failed`. `failed → candidate` e `failed → raw` lo puliscono. Non è generato internamente.

## 7. Updated at

`updated_at` è epoch millisecondi, intero finito `>= 0`, sempre fornito dal chiamante. Non viene usato `Date.now()`, non si genera tempo e non si converte ISO. Il successivo timestamp può essere uguale al corrente ma non inferiore.

## 8. Error

`error` è `null` salvo in `failed`, dove è obbligatorio:

```js
{ code: "STABLE_CODE", message: "descrizione tecnica", retryable: true }
```

Il V1 richiede esattamente `code`, `message`, `retryable`; il code usa maiuscole, numeri e underscore con iniziale alfabetica, message è non vuoto e `retryable` è boolean. Stack, cause, payload, prompt e testo sorgente sono vietati. Il contratto può verificare struttura e campi, non determinare semanticamente se una descrizione fornita dal chiamante sia sensibile.

## 9. Transizioni consentite

| Da | A | Significato |
|---|---|---|
| `raw` | `candidate` | candidatura esplicita futura |
| `candidate` | `raw` | release senza sintesi |
| `candidate` | `synthesizing` | nuovo tentativo con `attempt_id` |
| `synthesizing` | `consolidated` | successo, stesso tentativo |
| `synthesizing` | `failed` | fallimento, stesso tentativo ed error obbligatorio |
| `failed` | `candidate` | retry esplicito, attempt/error puliti |
| `failed` | `raw` | abbandono/reset, attempt/error puliti |

## 10. Transizioni vietate e terminalità

Ogni self transition è vietata. Sono vietate tutte le coppie non elencate, inclusi `raw → synthesizing|consolidated|failed`, `candidate → consolidated|failed`, `failed → synthesizing` e ogni uscita da `consolidated`. È vietato cambiare `attempt_id` durante `synthesizing → consolidated|failed`.

`consolidated` è terminale nel V1. Riapertura, riconciliazione o deconsolidamento richiederebbero un nuovo contratto versionato.

## 11. Retry, release e reset

Il retry è soltanto `failed → candidate`; non riparte direttamente in sintesi e pulisce tentativo ed errore. La release è `candidate → raw`. Il reset/abbandono è `failed → raw`. Tutte richiedono un piano esplicito e una reason tecnica.

## 12. Transition plan

```js
{
  schemaVersion: 1,
  transitionId,
  memoryId,
  fromState,
  toState,
  expectedRevision,
  nextRevision,
  expectedUpdatedAt,
  expectedAttemptId,
  nextProcessing,
  reason
}
```

`current` deve essere un processing V1 valido. `nextProcessing` è completo, valido, separato e con revision consecutiva. `reason` è una stringa tecnica non vuota. Il piano è profondamente congelato e non contiene memoria raw.

## 13. Transition ID e determinismo

`transitionId` è SHA-256 di una serializzazione canonica di schema, memoria, stati, revision attesa/successiva, timestamp atteso/successivo, attempt atteso/successivo, error code e reason. Tempo corrente, UUID e casualità non sono usati. La stessa richiesta produce output `deepStrictEqual`.

## 14. Optimistic concurrency futura

Il piano dichiara `fromState`, `expectedRevision`, `expectedUpdatedAt` ed `expectedAttemptId`. Un futuro commit dovrà rileggere la memoria e rifiutare il piano se almeno stato, revision o timestamp persistiti non coincidono più; per i tentativi dovrà anche preservare l'ID atteso. Il FIX 6 non esegue il confronto, non accede allo storage e non impedisce race condition.

## 15. Validazione, privacy e immutabilità

`validateProcessingState()` e `validateProcessingTransitionPlan()` restituiscono `{ valid, errors }`. Il piano viene controllato per schema, stati, transizione, revision, timestamp, attempt/error, reason, plain data, cicli, funzioni, campi privati o di scrittura e ricalcolo del transition ID. Un piano manomesso viene rifiutato.

Gli output non condividono riferimenti con gli input e sono profondamente congelati. Sono vietati contenuto memoria, `sourceSnapshot`, payload, stack, prompt, callback, storage, writer e commit.

## 16. Processing assente e CandidateSelector

L'assenza di processing non equivale a `raw`: la memoria resta legacy/unclassified secondo FIX 5 e richiede opt-in o futura migrazione esplicita. CandidateSelector non crea processing e usa gli stati canonici così:

- `raw`: eligible se gli altri criteri passano;
- `candidate`: deferred con `EXPLICIT_CANDIDATE_ALREADY_CLAIMED`;
- `synthesizing`: excluded;
- `consolidated`: excluded;
- `failed`: deferred con `EXPLICIT_FAILED_REQUIRES_RETRY`;
- stato sconosciuto: deferred con `UNSUPPORTED_PROCESSING_STATE`.

## 17. Garanzie, non-garanzie e decisioni rinviate

Il V1 garantisce vocabolario esatto, transizioni esplicite, revision consecutive, tentativo ed errore coerenti, determinismo, privacy strutturale e immutabilità. Non garantisce persistenza, compare-and-swap, lock, assenza di race, idempotenza, recovery, retry scheduling, qualità della sintesi o autorizzazione al commit.

Restano rinviati: integrazione storage, optimistic concurrency effettiva, transazione multi-file, idempotenza/recovery, ownership e timeout dei tentativi, policy di retry, migrazione legacy, cluster e sintesi.
