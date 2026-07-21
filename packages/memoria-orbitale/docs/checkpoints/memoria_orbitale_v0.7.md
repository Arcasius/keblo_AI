# Memoria Orbitale v0.7 — Checkpoint

Data: 2026-05-24

## Stato validato

- remember/recall/stats funzionanti
- link semantici creati e visibili
- _linkBoost attivo nel ranking
- rinforzo su accesso corretto:
  - activation +0.03
  - accessCount +1
  - lastAccess aggiornato
- propagazione activation a 1 salto:
  - nodo diretto +0.03
  - nodo collegato +0.01 * link.weight
  - nessuna propagazione a 2 salti
- orbitalLevel validati:
  - short
  - medium
  - long
- cold memory validata:
  - cold non è orbitalLevel
  - cold è flag/stato prodotto da compress() su memorie vecchie + bassa activation
- memoryDepth strutturale attivo:
  - core
  - deep
  - normal
  - temporary
- JsonMemoryStorage attivo:
  - salva memorie su JSON
  - salva link su JSON
  - ricarica memorie/link in nuova istanza
  - recall funziona sui dati ricaricati

## Architettura attuale

- KebloMemory = cuore cognitivo/orbitale
- JsonMemoryStorage = adapter persistente
- test_orbitale_minimo.js = banco diagnostico

## Prossimi step

v0.8:
- creare bridge/API per integrare Memoria Orbitale in Keblo

v0.9:
- campo gravitazionale / nuclei semantici

v1.0:
- motore orbitale collegabile al prompt finale di Keblo
