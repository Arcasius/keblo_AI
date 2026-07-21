import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createKebloUserRecallAdapter } from "../KebloReadOnlyRecallAdapter.js";
import { createKebloOrbitaleReadOnlyStorageReader } from "../KebloOrbitaleReadOnlyStorageReader.js";

const require = createRequire(import.meta.url);
const api = require("../../../../packages/memoria-orbitale");

test("public CJS rankReadOnly composes through ESM reader, adapter and RecallRouter", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kint3b-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const records = [
    { id: "match", type: "episodic", content: { text: "orbital project" }, activation: 0.4,
      timestamp: 1, memoryKind: "raw", storageTier: "warm", processingState: "raw" },
    { id: "miss", type: "episodic", content: { text: "unrelated" }, activation: 0.4,
      timestamp: 1, memoryKind: "raw", storageTier: "warm", processingState: "raw" }
  ];
  await writeFile(path.join(dir, "alice_memories.json"), JSON.stringify(records));
  const storageReader = createKebloOrbitaleReadOnlyStorageReader({
    userId: "alice", baseDir: dir, rankReadOnly: api.rankReadOnly
  });
  const adapter = createKebloUserRecallAdapter({ userId: "alice", storageReader });
  const output = await adapter.recall({ query: "orbital project", limit: 2 });
  assert.deepEqual(output.results.map(({ id }) => id), ["match", "miss"]);
  assert.equal(output.readOnly, true);
  assert.equal(output.reinforcementApplied, false);
});
