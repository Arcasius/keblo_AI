# KINT-5E — proiezione read-only flat → warm

KINT-5E consente al reader Keblo di presentare al ranker i ricordi storici `flat` come memorie
canoniche `raw` nel tier `warm`. La proiezione avviene soltanto in memoria e soltanto durante
una ricerca warm; il tier core continua ad accettare esclusivamente SuperMemory canoniche.

Sono proiettabili solo record flat normalizzabili, con identità e contenuto non vuoti,
activation finita nell'intervallo `[0, 1]`, e senza `memoryKind` o `storageTier` espliciti.
Record che sembrano SuperMemory, dichiarano campi canonici conflittuali o risultano malformati
vengono rifiutati. Il campo storico `type` e gli altri dati originali vengono conservati nella
copia runtime; non vengono aggiunti campi di processing.

Il reader espone esclusivamente i contatori aggregati `projectedFlatWarmCount` e
`rejectedFlatWarmCount`. La lettura usa ancora un file descriptor `O_RDONLY | O_NOFOLLOW` e non
esegue write, reinforcement, aggiornamenti di accesso, lock o creazione di file temporanei.
