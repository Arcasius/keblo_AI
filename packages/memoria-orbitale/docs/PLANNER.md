# Planner locale

Il Planner e uno strumento locale per analizzare il repository e proporre fix futuri. Non applica modifiche al codice applicativo: produce report e suggerimenti sotto `automation/planner-output/` e puo importare suggerimenti pending in `automation/fix_queue.json`.

## Cosa fa

- scansiona il repository ignorando sempre directory generate, backup/import, runtime data e cache: `node_modules`, `dist`, `.git`, `automation/logs`, `automation/planner-output`, `backup_orbitale_chat_data`, `backups`, `openai_export_backup`, `orbitale_chat_data`, `imports`, `tmp_orbitale_bridge_data`, `tmp_orbitale_data` e `__pycache__`;
- ignora file generati o dati export/memoria: `*.map`, `*.min.js`, `conversations-*.json` e `*_memories.json`;
- segnala `initialData.ts` nella sezione `Known large data files`, senza proporlo come target di refactor;
- rileva file JS/TS/TSX grandi, file oltre 500 righe, TODO/FIXME, `package.json`, script npm e cartelle principali;
- individua possibili aree da modularizzare;
- genera fix suggeriti in un formato compatibile con gli elementi di `automation/fix_queue.json`;
- importa i fix suggeriti nella queue assegnando id `fix-NNN`, status `pending` e priority progressive;
- esegue il ciclo completo scan -> suggest -> import con `node automation/planner.js --plan --limit 4`;
- evita di suggerire fix su `node_modules`, `dist`, backup/import/runtime data, archivi, lockfile e file JSON di memoria/export, limitando i target a codice sorgente o automation/docs testuali.

## Cosa non fa

- non applica fix;
- non chiama Codex;
- non installa o usa dipendenze esterne;
- non cambia API contract, endpoint, payload o formato dati.

## Comandi

```bash
node automation/planner.js --plan --limit 4
```

Esegue in sequenza scan, suggest e import. Il limite predefinito e 4, il massimo effettivo e 5. Crea o aggiorna:

- `automation/planner-output/scan-report.json`
- `automation/planner-output/scan-report.md`
- `automation/planner-output/suggested-fixes.json`
- `automation/planner-output/suggested-fixes.md`
- `automation/planner-output/import-report.json`
- `automation/planner-output/import-report.md`
- `automation/planner-output/planner-run.json`
- `automation/planner-output/planner-run.md`

Se non ci sono fix importabili, il report lo indica esplicitamente e `automation/fix_queue.json` non viene modificato.

```bash
node automation/planner.js --scan
```

Crea:

- `automation/planner-output/scan-report.json`
- `automation/planner-output/scan-report.md`

```bash
node automation/planner.js --suggest --limit 4
```

Legge `automation/planner-output/scan-report.json` e crea:

- `automation/planner-output/suggested-fixes.json`
- `automation/planner-output/suggested-fixes.md`

```bash
node automation/planner.js --import --limit 4
```

Legge `automation/planner-output/suggested-fixes.json` e `automation/fix_queue.json`, importa al massimo 4 fix non duplicati e crea:

- `automation/planner-output/import-report.json`
- `automation/planner-output/import-report.md`

L'import assegna id progressivi dopo l'ultimo `fix-NNN` presente, assegna priority progressive dopo l'ultima priority esistente, mantiene `status: "pending"` e salta i suggerimenti con `title` gia presente nella queue. Se non ci sono fix importabili, non modifica `automation/fix_queue.json`.

## Flusso consigliato

```bash
node automation/planner.js --plan --limit 4
node automation/codex_runner.js --prepare-batch --limit 4
node automation/codex_runner.js --batch-ready
node automation/codex_runner.js --start-next-prepared
node automation/codex_runner.js --export-codex-prompt --fix fix-XXX
```
