"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  SYMBOLIC_BATCH_SIZES,
  createSyntheticDataset,
  runBenchmarkLevel,
  verifySymbolicBatchInvariance
} = require("../../scripts/hippocampus-bounded-clustering-benchmark");

test("reduced harness is deterministic, bounded and exercises required dispositions", async () => {
  const options = {
    rssRead: () => 4096,
    now: () => 100,
    budgets: {
      candidateTimeoutMs: 1000,
      refinementTimeoutMs: 1000,
      maxRssDeltaBytes: 1024,
      maxComponentVectorsInMemory: 16
    }
  };
  const direct = await runBenchmarkLevel(100, { ...options, variant: 0 });
  const inverse = await runBenchmarkLevel(100, { ...options, variant: 1 });
  assert.equal(direct.semanticDigest, inverse.semanticDigest);
  assert.equal(direct.checks.referenceEquivalent, true);
  assert.equal(direct.checks.chainRejected, true);
  assert.equal(direct.checks.denseDeferred, true);
  assert.equal(direct.checks.incompleteDeferred, true);
  assert.equal(direct.checks.preparedSnapshotValidationCount, 1);
  assert.equal(direct.checks.preparedCertificateQueryLookupCount, 100);
  assert.equal(direct.checks.symbolicBatchInvariant, true);
  assert.equal(direct.checks.crossBatchAffinity1To50, true);
  assert.ok(direct.metrics.maximumVectorsInMemory <= 16);
  assert.ok(direct.checks.vectorRetrieveCount <= 16);
  assert.equal(direct.metrics.rssDeltaBytes, 0);
});

test("symbolic batches 1, 2, 17, 50 and 128 cannot alter snapshot identity", () => {
  assert.deepEqual(SYMBOLIC_BATCH_SIZES, [1, 2, 17, 50, 128]);
  assert.equal(verifySymbolicBatchInvariance(100), true);
});

test("direct and inverse procedural inputs produce the same BC-1 snapshot", () => {
  const direct = createSyntheticDataset(100, "direct");
  const inverse = createSyntheticDataset(100, "inverse");
  assert.equal(direct.identitySnapshot.snapshotFingerprint,
    inverse.identitySnapshot.snapshotFingerprint);
  assert.deepEqual(direct.identitySnapshot.identities, inverse.identitySnapshot.identities);
});

test("benchmark source has no network, runtime provider, global Promise.all or N² matrix", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../../scripts/hippocampus-bounded-clustering-benchmark.js"), "utf8");
  assert.doesNotMatch(source,
    /\bfetch\s*\(|Promise\.all|Qdrant|BgeM3|Qwen|JsonMemoryStorage|HippocampusDaemon|SuperMemory|new\s+Array\([^)]*identityCount[^)]*\)\s*\.fill\([^)]*new\s+Array/iu);
  assert.doesNotMatch(source,
    /"(?:text|content|payload|endpoint|apiKey|secret)"\s*:/u);
});
