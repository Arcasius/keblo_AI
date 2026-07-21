# KINT-1B — Keblo package boundary

`@keblo/memoria-orbitale` is a private CommonJS package whose only public
subpath is `.`. Its entrypoint exposes a fixed read-only recall and contract API
through lazy getters: importing the package does not load the underlying core
modules.

There is no exported `RecallRouter`, `RecallRequestBuilder`,
`LegacyRecallAdapter`, or `MemoryContractNormalizer` class because those names
do not exist in the implementation. The public equivalents are the real
factories and functions `createRecallRouter`, `buildRecallRequest`,
`createLegacyRecallAdapter`, `detectMemoryContract`, `normalizeMemory`, and
`projectMemoryForCandidateSelection`.

Daemon, control-plane, commit bridge, providers, clustering, storage
implementations, and every module under `scripts/` remain private. Any future
runtime composition or chat integration is deferred to KINT-2.
