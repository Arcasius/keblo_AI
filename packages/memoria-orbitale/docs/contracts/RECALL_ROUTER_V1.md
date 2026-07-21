# RECALL_ROUTER_V1

## 1. Scopo e non-obiettivi

Il FIX 11 definisce un RecallRouter puro, read-only, deterministico e non integrato. Interroga retriever espliciti per tier, fonde risultati, valida contratti, deduplica, sopprime raw coperti da super-memory, ordina e applica il solo limite richiesto dal chiamante.

Il V1 non accede allo storage, non modifica `KebloMemory`, chat, bridge o server, non applica reinforcement, non riconosce comandi linguistici, non chiama modelli/rete/Qdrant e non crea adapter runtime. L'integrazione appartiene al FIX 12, che non è iniziato.

## 2. Posizione futura

Nel FIX 12 il router potrà essere collocato sopra i percorsi di retrieval, prima della selezione finale e del reinforcement. Non sostituisce oggi `KebloMemory.recall()` e non viene importato dai chiamanti esistenti. I retriever dovranno adattare i backend reali al contratto V1 garantendo `mutate: false`.

## 3. Retriever contract

Ogni retriever è esplicito:

```js
{
  schemaVersion: 1,
  id: "stable-retriever-id",
  search: async ({ query, tier, limit, filters, mutate }) => []
}
```

Core e warm sono obbligatori. Deep è opzionale finché non viene richiesto o attivato dal fallback. ID non vuoto, schema V1 e `search` callable sono verificati. Il router passa sempre query invariata, tier previsto, final limit, filters vuoti e congelati e `mutate: false`. Non esiste retriever globale o fallback implicito.

## 4. Request e assenza di interpretazione linguistica

La request chiusa contiene `query`, mode opzionale, `includeDeep` opzionale, `limit` obbligatorio e `deepFallback` opzionale. Query deve essere stringa non vuota e viene inoltrata esattamente, senza trim operativo, riscrittura o interpretazione semantica. Espressioni come “cerca nello storico completo” non cambiano route nel FIX 11.

Mode validi: `default` e `full-history`. `includeDeep` è boolean e false per default. `limit` è un intero positivo obbligatorio: non esiste default, top-five o slice nascosto.

## 5. Tier e classificazione

I tier sono `core`, `warm`, `deep` e non sono alias di `memoryDepth` o `orbitalLevel`.

- Core accetta soltanto `memoryKind: super_memory` e `storageTier: core`.
- Warm accetta `storageTier: warm` e kind raw/episodic/semantic/structural esplicito.
- Deep accetta `storageTier: deep` e non accetta super-memory.

Ogni memoria passa attraverso `normalizeMemory()`. Il router non inventa tier per memorie untiered e non riclassifica risultati incompatibili. `retrievalTier` deve coincidere col retriever invocato; mismatch e kind incompatibili vengono esclusi con reason code. Un link boost o dato interno del retriever non può cambiare il tier dichiarato.

## 6. Default core + warm

La route default invoca core e warm in parallelo, poi valida, fonde, deduplica, sopprime source, ordina e applica il limite finale. Deep non viene invocato e routing registra `DEEP_NOT_REQUESTED`.

## 7. Deep esplicito

`includeDeep: true` attiva deep con `DEEP_EXPLICIT`. Mode `full-history` è una richiesta API esplicita e registra `DEEP_FULL_HISTORY`. Entrambe richiedono `deepRetriever`; la sua assenza o failure interrompe il recall con errore esplicito. Il router non deduce queste opzioni dalla query.

## 8. Deep fallback

Il fallback default è `{ enabled: false, minResults: null, minBestScore: null }`. Se abilitato richiede almeno una soglia: count intero `>=1` o best score finito `[0,1]`. Deep viene interrogato soltanto quando i risultati core+warm validi sono sotto count o best score è sotto soglia; le cause sono `DEEP_FALLBACK_LOW_COUNT` e/o `DEEP_FALLBACK_LOW_SCORE`.

Una failure del solo fallback deep viene registrata senza perdere core/warm. Una failure deep esplicitamente richiesta fallisce chiusa. Il fallback non può essere attivato dalla policy globale.

## 9. Risultato retriever e score

Ogni entry è plain e contiene almeno ID, score, retrieval tier e memory plain. Score deve essere number finito in `[0,1]`; 0 e 1 sono validi. Non avvengono clamp, normalizzazione o correzione. Entry, score, tier o memoria invalidi vengono esclusi e descritti in `invalidResults` senza testo raw.

La vista pubblica contiene solo ID, text, score/finalScore, tier, kind, storage tier, timestamp, source memory ID, SHA-256 content hash, retriever ID e reason code. Non contiene raw memory o `sourceSnapshot`.

## 10. Read-only e reinforcement rinviato

Il router non chiama `updateAccess`, reinforce, activation engine, Echo policy, link mutation o save. Non modifica activation, `lastAccess`, `accessCount`, processing, link, request, policy, retriever o risultati backend. L'output dichiara sempre `readOnly: true` e `reinforcementApplied: false`.

`reinforcementPendingIds` è soltanto l'elenco tecnico ordinato dei risultati finali. Il FIX 12 potrà decidere se applicare reinforcement una sola volta dopo la selezione finale; il FIX 11 non autorizza alcuna mutazione.

## 11. Merge e deduplica

I risultati validi vengono ordinati col comparatore finale prima della deduplica, rendendo la scelta indipendente dall'ordine backend/async.

Per ID duplicato vince score maggiore, poi priorità core/warm/deep, retriever ID e memory ID. Per contenuto duplicato viene calcolato SHA-256 del testo UTF-8 esatto, senza lowercase, trim, normalizzazione spazi/Unicode o similarità semantica; si usa lo stesso comparatore. Ogni scarto viene registrato senza duplicarne il testo.

## 12. Super-memory e source suppression

Con `suppressCoveredSources: true`, una super-memory core selezionata sopprime risultati non-super il cui ID compare in `sourceMemoryIds`. La source resta persistita e immutata; il report usa `SOURCE_COVERED_BY_SUPER_MEMORY` con soli dettagli tecnici. La policy può essere impostata esplicitamente a false e il routing lo rende visibile.

La soppressione evita di restituire contemporaneamente una sintesi e tutte le sue source raw, ma non prova che la super-memory sia semanticamente migliore per ogni query.

## 13. Ranking

Nel V1 `finalScore === score` del retriever. Non esistono boost per tier, super-memory, activation, freshness, Echo o link. Una warm con score maggiore precede una core. Solo a parità si applicano core, warm, deep, poi retriever ID e memory ID.

Scoring avanzato richiederà regression test separati e non può essere introdotto implicitamente durante l'integrazione.

## 14. Limit

Il final limit viene passato ai retriever come budget tecnico e applicato una sola volta dopo merge, deduplica, source suppression e ranking. Se tronca, routing espone `truncated`, stats conserva `beforeFinalLimit` e ogni risultato escluso riceve `FINAL_LIMIT_APPLIED`. Con `limit >= 12`, dodici risultati validi non vengono ridotti a cinque.

## 15. Output e statistiche

L'output include schema, query/mode, flag read-only/reinforcement, routing, risultati, suppressed, invalid results, stats e pending IDs. Routing distingue tier richiesti/invocati, deep esplicito/usato, reason code deep, policy suppression, limite e truncation.

Le statistiche riportano returned per tier, validi pre-deduplica, duplicati ID/contenuto, source coperte, count pre-limit e finale. I reason code sono canonici e i messaggi liberi non sono l'unica evidenza.

## 16. Determinismo async e immutabilità

Core e warm possono completare in qualsiasi ordine. Validazione, comparatori, suppressed, invalid results, reason code e stats restano identici. Non vengono usati clock, random o UUID.

L'output è plain, copiato e profondamente congelato; non condivide riferimenti mutabili con request, retriever o backend. Stessi input e risultati producono `deepStrictEqual`.

## 17. Errori

`RecallRouterError` espone code, phase e tier/retriever tecnico quando applicabile, senza memory text o payload backend. Request/retriever invalidi e deep mancante falliscono prima o durante routing. Failure core/warm falliscono chiuse. Failure deep esplicita fallisce; failure del fallback deep viene registrata e conserva core/warm.

Risultati individuali invalidi o con tier violation non interrompono gli altri risultati e sono registrati con `INVALID_RESULT`, `INVALID_SCORE`, `TIER_MISMATCH` o `INCOMPATIBLE_MEMORY_KIND`.

## 18. Rischi legacy osservati, non corretti

`KebloMemory.recall()` ha `mutateOnRecall: true` per default e può aggiornare activation, `lastAccess`, `accessCount`, propagare activation e salvare. Lo score combina match, activation, Echo e link boost. I link non hanno un confine `storageTier`, quindi un traversal futuro non adattato potrebbe reintrodurre deep in una route default.

Il legacy filtra `memoryDepth`, `orbitalLevel` e tag, non il nuovo `storageTier`. `getContextForKeblo()` applica slice 5/5/3 e richiama recall senza disabilitare esplicitamente la mutazione. `OrbitaleBridge.getContext()` usa default/slice cinque. La chat imposta spesso `mutateOnRecall: false`, ma interpreta pattern linguistici di recall/storico, applica filtri historical/long, Echo gate, promotion limit e può rinforzare link dopo il recall.

Queste osservazioni guidano il FIX 12 ma nessun percorso legacy viene modificato dal FIX 11.

## 19. Garanzie e non-garanzie

Il V1 garantisce route default core+warm, deep soltanto esplicito/fallback, classificazione conservativa, score invariato, deduplica esatta, source suppression configurabile, limite finale visibile, determinismo, immutabilità e assenza di mutation/storage/runtime integration.

Non garantisce qualità dei retriever, semantic correctness, adapter legacy non mutante, isolamento deep di link traversal interno a un retriever scorretto, reinforcement, integrazione chat/bridge, comprensione linguistica, vector search o scoring avanzato.

## 20. Piano FIX 12

Il FIX 12 dovrà progettare adapter core/warm/deep sopra i backend reali, dimostrare che `mutate: false` viene rispettato, separare tier senza inferenze da `memoryDepth`/orbite, impedire link traversal cross-tier, sostituire i limiti legacy impliciti e applicare eventuale reinforcement una sola volta dopo l'output finale. Dovrà integrare progressivamente chiamanti e regression test senza riutilizzare automaticamente scoring/mutazioni legacy.

## 21. Nota d'integrazione FIX 12

Il FIX 12 realizza questo piano tramite `MemoryTierClassifier`, `LegacyRecallAdapter` e `RecallRequestBuilder`. Chat, `getContextForKeblo()` e bridge condividono una pipeline registrata esplicitamente; l'adapter usa soltanto `recallReadOnly()` e il reinforcement viene applicato in batch una volta dopo la selezione finale. Il mapping legacy e le garanzie runtime sono definiti in `RECALL_ROUTER_INTEGRATION_V1.md`; il contratto puro e i suoi reason code restano invariati.
