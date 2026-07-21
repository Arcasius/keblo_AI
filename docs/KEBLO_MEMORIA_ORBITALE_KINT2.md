# KINT-2 — Read-only user-scoped recall adapter

`createKebloUserRecallAdapter({ userId, storageReader })` binds one adapter to
one explicit authenticated user identifier. `storageReader` is injected and
must expose `searchReadOnly({ schemaVersion, userId, query, tier, limit,
mutate })`. It must return synthetic or persisted entries shaped as
`{ memory, score }`, with score in `[0, 1]`.

Construction performs no read. Search always sends `mutate: false`; the public
low-level `search` rejects both `mutate: true` and an absent mutate flag. The
adapter has no write or reinforcement dependency.

Core admits only valid `memoryKind: super_memory` records stored in `core`.
Warm admits only `memoryKind: raw` records stored in `warm`. Malformed and
incompatible records are counted without recording IDs, text, queries, or user
identifiers. The package `RecallRouter` owns ranking, exact deduplication,
covered-source suppression, limiting, and public reason codes.

The existing file-backed Keblo storage is intentionally not constructed here:
its constructor creates a directory and its legacy recall path mutates memory.
KINT-3 must supply an authenticated runtime composition and a concrete
read-only reader without adding conversation ingestion or cross-user fallback.
Server and chat integration remain out of scope.
