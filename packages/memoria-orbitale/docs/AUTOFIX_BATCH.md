# Autofix Batch Mode

Questa guida descrive il ciclo Batch Mode senza chiamare Codex dal runner. Il runner prepara artifact, controlla stati e produce prompt riutilizzabili; l'esecuzione Codex resta manuale.

## 1. Aggiungere fix alla queue

Aggiungere ogni fix in `automation/fix_queue.json` con stato `pending` e campi obbligatori:

- `id`
- `title`
- `status`
- `goal`
- `scope`
- `forbidden`
- `acceptance`
- `checks`

Ogni fix deve restare piccolo, verificabile e coerente con le regole di `AGENTS.md`.

## Regole operative

- Preparare al massimo 5 fix in stato `prepared`.
- Tenere un solo fix in stato `running`.
- Non eseguire commit se build o check falliscono.
- Non modificare `server.js` o `package.json` senza autorizzazione esplicita.
- Se `scope-check` produce esito `review-required`, leggere il report prima di completare il fix.

## 2. Prepare batch

Preparare fino a 4 fix pending per ciclo:

```bash
node automation/codex_runner.js --prepare-batch --limit 4
```

Il comando:

- seleziona fix `pending` per priorita;
- genera prompt, piano e contratto;
- porta i fix selezionati a `prepared`;
- non chiama Codex.

Non superare mai 5 fix totali in stato `prepared`.

## 3. Batch ready

Generare il riepilogo dei fix pronti:

```bash
node automation/codex_runner.js --batch-ready
```

Leggere:

- `automation/logs/batch-ready.json`
- `automation/logs/batch-ready.md`

## 4. Start next prepared

Avviare un solo fix prepared:

```bash
node automation/codex_runner.js --start-next-prepared
```

Il comando porta il primo fix `prepared` a `running`, stampa gli artifact da usare e non chiama Codex.

## 5. Export Codex prompt

Esportare il prompt pronto per il fix running o prepared:

```bash
node automation/codex_runner.js --export-codex-prompt --fix fix-XXX
```

Il comando richiede `--fix`, accetta solo fix in stato `prepared` oppure `running`, legge:

- `automation/logs/<fix-id>/codex-task.json`
- `automation/logs/<fix-id>/fix-plan.md`

e crea:

- `automation/logs/<fix-id>/codex-ready-prompt.md`

Non chiama Codex, non modifica `automation/fix_queue.json` e non cambia stato.

## 6. Lanciare Codex

Leggere il prompt generato:

```bash
sed -n '1,240p' automation/logs/<fix-id>/codex-ready-prompt.md
```

Passare quel contenuto a Codex. Codex deve applicare solo il fix corrente e alla fine riportare file modificati, riepilogo e verifiche.

## 7. Scope, snapshot, verify e final report

Dopo l'esecuzione del fix, produrre i controlli:

```bash
node automation/codex_runner.js --scope-check --fix fix-XXX
node automation/codex_runner.js --snapshot-diff --fix fix-XXX
node automation/codex_runner.js --verify --fix fix-XXX
node automation/codex_runner.js --final-report --fix fix-XXX
```

Leggere sempre `scope-check` e `final-report` prima di cambiare stato. Se `scope-check` indica `review-required`, leggere il report e risolvere o documentare il motivo prima di procedere.

## 8. Verified e completed

Quando scope, diff e verifiche sono coerenti e i check sono passati:

```bash
node automation/codex_runner.js --set-state verified --fix fix-XXX
```

Dopo revisione e approvazione finale:

```bash
node automation/codex_runner.js --set-state completed --fix fix-XXX
```

Non marcare automaticamente un fix come `completed`.

## 9. Commit

Controllare lo stato Git:

```bash
git status --short
git diff
```

Committare solo quando diff, artifact, build/check e stato del fix sono coerenti:

```bash
git add <file-modificati>
git commit -m "<messaggio-fix>"
```
