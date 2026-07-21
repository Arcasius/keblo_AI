# HIPPOCAMPUS_CONTROL_PLANE_HACT2B_HTTP_MOUNT

## Esito

HACT-2B è stato arrestato in preflight senza montare endpoint.

Stato registrato:

- `ACTIVATION_GATE_READY`;
- `CONTROL_PLANE_READY`;
- `HTTP_MOUNT_BLOCKED_BACKEND_AUTHORIZATION_BOUNDARY_REQUIRED`;
- `DEFAULT_MODE_OFF`;
- `REAL_RUNNER_NOT_WIRED`;
- `REAL_RUNTIME_DISABLED`.

## Backend Keblo ispezionati

L'ispezione non ha individuato un unico backend Keblo operativo, autorevole e
dotato di un confine di autorizzazione riusabile per API sensibili.

### Keblo Memoria Orbitale

Il launcher corrente avvia:

1. la sincronizzazione dei dati verso il cockpit;
2. Vite come frontend.

Non avvia un backend autenticato. Il frontend invoca `/api/chat`, ma la
configurazione Vite non contiene un proxy backend. Nella stessa copia esiste un
server Express per il cockpit, ma non è il processo avviato dal launcher e non
possiede sessione, autenticazione o autorizzazione.

### Keblo Final

Il progetto dichiara un server Express con sessione, ma:

- le dipendenze runtime dichiarate non sono installate;
- il login crea una sessione accettando un'email client senza verifica
  credenziali;
- la configurazione di firma della sessione è una configurazione di sviluppo
  incorporata nel sorgente;
- non esiste un ruolo o una policy server-side per autorizzare il control
  plane;
- non è stato rilevato un processo in ascolto.

Questa sessione non è un confine verificabile per API amministrative.

### Keblo Chatbot

Il server corrente usa un login e una firma JWT di sviluppo incorporati nel
sorgente. Il frontend inoltre divide il flusso fra autenticazione sulla porta
3000 e chat sulla porta 3001, mentre il server corrente espone il login sulla
porta 3001.

Nel repository esiste un middleware storico più forte che verifica JWT e
sessione database, ma non è montato dal server corrente. I file server storici
che lo usano non costituiscono l'entrypoint autorevole. Non è stato rilevato un
processo backend in ascolto.

Non è quindi possibile riusare silenziosamente quel middleware come confine
operativo già verificato.

## Confine moduli HACT-2

`Memoria_Orbitale_Autonomo` contiene i moduli autorevoli HACT-2, ma non espone
attualmente un confine consumabile da un altro progetto:

- nessun `package.json` locale;
- nessun campo `exports`;
- nessun workspace;
- nessuna dipendenza package dichiarata da un backend Keblo;
- nessun entrypoint pubblico versionato per il control plane.

Un import relativo fra repository dipenderebbe dalla disposizione locale delle
directory. Un import assoluto dipenderebbe dalla macchina. Entrambi sono
confini fragili vietati da HACT-2B. I file HACT-2 non sono stati copiati né
duplicati.

## Decisione fail-closed

Non sono stati:

- montati i quattro endpoint HACT-2;
- creati server paralleli;
- aggiunti header amministrativi inventati;
- usati Origin o Referer come autorizzazione;
- modificati frontend, CORS o environment;
- iniettati runner, capability commit o storage;
- letti ricordi o processing state;
- chiamati provider, rete o storage reale.

Il blocker primario è l'assenza di un backend Keblo canonico con identità,
sessione e autorizzazione server-side verificabili. Anche dopo la sua
risoluzione resterà necessario esporre HACT-2 tramite un confine package/export
stabile, come FIX separato.

## Verifiche

| Verifica | Risultato |
| --- | --- |
| worktree Keblo e Autonomo ispezionati | PASS, modifiche preesistenti preservate |
| launcher/processi/porte backend ispezionati | nessun backend canonico operativo verificato |
| syntax HACT-1/HACT-2 | PASS |
| regressioni HACT-1/HACT-2 | 35/35 PASS |
| syntax backend candidati | PASS |
| dipendenze Keblo Final | BLOCKED, dipendenze runtime assenti |
| import boundary HACT-2 | BLOCKED, package/export/workspace assente |
| test HACT-2B mount | NOT RUN, mount non autorizzabile |
| suite completa | NOT RUN, nessun codice runtime modificato |
| rete/dati/provider/storage/commit | 0 |

## Prossimo FIX minimo

Il prossimo FIX deve prima designare un solo composition root Keblo realmente
avviato e dotarlo di un confine di autorizzazione server-side verificabile per
il control plane. Non deve ancora montare HACT-2.

Successivamente un FIX separato dovrà pubblicare un entrypoint HACT stabile dal
repository autorevole, senza copiare moduli e senza dipendere dalla directory
di avvio.

## Verdetto

`BLOCKED_BACKEND_AUTHORIZATION_BOUNDARY_REQUIRED`
