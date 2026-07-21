# KINT-3A — Concrete read-only orbital storage reader

`createKebloOrbitaleReadOnlyStorageReader({ userId, baseDir, rankReadOnly,
maxBytes })` creates a lazy, user-scoped reader directly compatible with
`createKebloUserRecallAdapter({ userId, storageReader })`.

The reader opens only `<baseDir>/<validatedUserId>_memories.json`, with
`O_RDONLY | O_NOFOLLOW`. Construction performs no filesystem operation.
`ENOENT` returns `[]`; corrupt JSON, non-array/non-object top-level values,
symlinks and other read failures produce sanitized coded errors without path,
user, query, memory ID or content. Object maps (the current writer format) and
arrays (accepted by the current loader compatibility path) are supported.
The default read ceiling is 256 MiB and can be reduced or increased with the
positive safe-integer `maxBytes` option.

Requests must have schema version 1, the factory-bound user, tier `core` or
`warm`, a positive limit, a non-empty query and exactly `mutate: false`.
Explicit record user identifiers must agree and match the bound user. Core
returns only consolidated `super_memory`/`core` records with valid unique
source IDs. Warm returns only `raw`/`warm` records. Covered raw sources remain
visible to the reader because KINT-2's `RecallRouter` is the authoritative
place that suppresses source delegates covered by a selected SuperMemory.

## Ranking boundary

No sufficient public, pure, non-mutating orbital ranking primitive exists.
The legacy `Keblomemory.recall()` owns its scoring but also loads links and its
default path reinforces memories and persists state. `MemoryIndex` is mutable
and includes time-dependent fallbacks. KINT-3A therefore requires the injected
pure function `rankReadOnly({ schemaVersion, userId, query, tier, limit,
memories })`. It receives deep-frozen clones and must return ordered
`{ id, score }` entries with score in `[0,1]`. The reader maps only IDs from its
validated candidate set, removes repeated IDs deterministically and applies
the requested per-tier limit. KINT-2/RecallRouter retains cross-tier ranking,
deduplication, covered-source suppression and the final limit.

Chat wiring remains outside KINT-3A. Its residual blocker is selecting or
exporting an approved pure orbital `rankReadOnly` implementation and injecting
the authenticated `userId` plus configured orbital `baseDir` at composition.
