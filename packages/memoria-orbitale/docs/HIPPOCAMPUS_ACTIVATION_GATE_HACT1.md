# HIPPOCAMPUS_ACTIVATION_GATE_HACT1

## Stato

- `SYNTHETIC_END_TO_END_VERIFIED`
- `REAL_RUNTIME_DISABLED`
- `DEFAULT_ACTIVATION_MODE_OFF`

HACT-1 introduce esclusivamente una decisione backend pura, immutabile per
istanza e indipendente dal frontend. Nessun composition root operativo è stato
aggiunto.

## Implementazione

- gate chiuso `OFF | SHADOW | LIVE`;
- OFF predefinito per ogni nuova istanza;
- SHADOW esplicito senza capability commit autorizzata;
- LIVE fail-closed con token esatto, capability commit e attestazione delle
  cinque capability storage richieste;
- nessuna promozione automatica o fallback;
- errori tipizzati e sanitizzati;
- preflight futuro separato, soltanto rappresentativo;
- mini-inference Qwen obbligatoria per readiness: `/api/tags` non basta.

## Verifiche

| Verifica | Risultato |
| --- | --- |
| `node --check` nuovi file | PASS |
| test HACT-1 isolati | 19/19 PASS |
| regressioni BC/BC-8/daemon/storage | 161/161 PASS |
| regressioni EC/Qdrant | 166/166 PASS |
| suite completa serializzata, una esecuzione | 695/695 PASS |
| fail / cancelled / skipped / todo | 0 / 0 / 0 / 0 |
| whitespace scope HACT-1 | PASS |
| privacy e output shape | PASS |
| import check moduli puri | PASS |

Tutte le prove HACT-1 usano capability ed evidenze fake. Non sono stati usati
rete, endpoint reali, dati reali, storage reale, daemon, scheduler, Qdrant,
BGE-M3, Qwen o commit.

## Runtime

Il runtime reale resta disabilitato. HACT-1 non avvia cicli OFF/SHADOW/LIVE e
non collega il gate al daemon. Una futura composition root dovrà creare una
nuova decisione per ogni ciclo e rispettarne la modalità immutabile.

## Verdetto

`ACTIVATION_SWITCH_READY_DEFAULT_OFF`
