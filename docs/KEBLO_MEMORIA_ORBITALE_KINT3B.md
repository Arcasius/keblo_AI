# KINT-3B — Pure public read-only orbital ranker

The CommonJS package exports the lazy function `rankReadOnly({ schemaVersion,
userId, query, tier, limit, memories })`. This is the exact object passed by the
KINT-3A reader. It returns only ordered, frozen `{ id, score }` records and does
not mutate or retain input memories.

## Extracted semantics

The implementation extracts the pure portion already embedded in
`Keblomemory.recall()`: recall stopwords and token matching, strong concept
aliases, warm concept preselection, tag matching, generic/duplicate-query
penalties and echo resonance. It also preserves the configured
`RetrievalBiasCorrector` weights used by `KebloMemory`: relevance `0.6` and
activation `0.4`.

For every compatible candidate:

```
text = matched query tokens / query tokens
tag = matched query tokens in tags / query tokens
relevance = max(text, tag * 0.7)
base = relevance * 0.6 + activation * 0.4
score = clamp(base * 0.65 + echo * 0.25, 0, 0.9)
```

`echo` is the existing clamped `[0,1]` acronym/phrase/alias-density/tag score
minus the existing generic-assistant and duplicate-query penalties. Link boost
is omitted because KINT-3A supplies no link records. Creation time, last access
and access count have zero ranking weight in the current recall implementation;
therefore KINT-3B does not invent temporal decay or call `Date.now()`.

Activation is zero when absent (required for persisted SuperMemory records) and
must otherwise be finite in `[0,1]`. The resulting score is finite in `[0,0.9]`.
Malformed, wrong-tier, invalid-activation or invalid-tag candidates are excluded.
An empty query returns `[]`; malformed requests throw only the sanitized code
`INVALID_RANK_REQUEST`. Equal scores use an ascending code-unit identity order,
independent of input order and locale.

The ranker does not apply cross-tier priority, suppression, deduplication or the
final limit; these remain owned by KINT-3A and `RecallRouter`. It has no storage,
network, provider, timer, global state or npm dependency.
