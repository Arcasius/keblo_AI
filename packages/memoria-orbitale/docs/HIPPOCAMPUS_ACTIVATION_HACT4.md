# HACT-4 — Legacy flat memory SHADOW projection

## Stato

`VERIFIED` — `LEGACY_FLAT_SHADOW_PROJECTION_READY` —
`HIPPOCAMPUS_REAL_SHADOW_RUN_PASSED`

## Scope

HACT-4 aggiunge esclusivamente la projection read-only
`hippocampus-legacy-flat-shadow-projection-v1` al runtime SHADOW standalone.
CandidateSelector, memoria autorevole, write path, processing state persistito,
commit, LIVE, provider, frontend/backend, scheduler, cleanup e `.env` restano
invariati. La queue legacy non contiene HACT-4 e non è stata modificata.

## Diagnosi reale read-only

Il file autorevole è un object map con 40.774 record. I contatori sanitizzati
sono:

- chiave oggetto uguale a `record.id`: 40.774;
- mismatch chiave/identità: 0;
- identità mancanti: 0;
- record coinvolti in identità duplicate: 0;
- `content.text` stringa non vuota: 40.774;
- `processingState` assente: 40.774.

Il primo batch di 20 era stato rinviato interamente con
`LEGACY_UNCLASSIFIED`. CandidateSelector richiede lo stato canonico `raw` per
l'eleggibilità esplicita. BC-8 deriva `memoryId` dall'identità `id`, calcola
SHA-256 sul testo UTF-8 esatto e rifiuta una rilettura il cui hash non coincide
prima della synthesis.

## Projection e confini

La projection conserva `id`, verifica la chiave, rifiuta identità mancanti,
duplicate, ambigue o incompatibili e accetta soltanto testo stringa non vuota.
Calcola SHA-256 senza normalizzazione e attribuisce `processingState:raw`,
`memoryKind:raw` e `storageTier:warm` soltanto a un descriptor nuovo in RAM.
La provenance dichiara versione, modalità SHADOW e stato non persistito.

Non viene aggiunto eventTime e `lastAccess` non è usato come tempo semantico.
La selezione è canonica e conserva al massimo `maxCandidates` descriptor con
testo. La rilettura usa la stessa projection e BC-8 verifica l'hash fail-closed
prima della synthesis.

Il risultato zero è `SHADOW_NO_ELIGIBLE_CANDIDATES` con sole cause aggregate.
Il report distingue anche letture e write autorevoli.

## Verifiche

- syntax dei tre moduli modificati: PASS;
- test HACT-4 + runtime: 29/29 PASS;
- regressioni HACT-1→3D, CandidateSelector, BC/BC-8, EC, provider e synthesis:
  423/423 PASS;
- projection reale: 40.774 eleggibili, 20 selezionati, 20 candidati planner,
  esclusioni tutte a zero;
- memoria autorevole invariata e processing-state write: 0;
- test BC-8 stale reread/hash mismatch: PASS.

## Unico ciclo reale autorizzato

| Contatore | Valore |
| --- | ---: |
| authoritativeMemoryReads | 1 |
| authoritativeMemoryWrites | 0 |
| candidateCount | 20 |
| cacheHitCount | 0 |
| cacheCreatedCount | 20 |
| embeddingCacheModified | true |
| exactCertificateCount | 20 |
| clusterCount | 0 |
| simulatedSuperMemoryCount | 0 |
| commitCalls | 0 |

I 20 point derivati sono stati creati esclusivamente nella collection cache
dedicata già contrattuale. Non sono state eseguite altre run, cleanup, delete,
write autorevoli, processing-state write o commit. LIVE resta disabilitato.
