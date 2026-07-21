"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const JsonMemoryStorage = require("../../core/JsonMemoryStorage");
const {
  createProcessingState
} = require("../../core/consolidation/ProcessingState");
const {
  createAuthoritativeLegacyProcessingBoundary
} = require("../../core/hippocampus/AuthoritativeLegacyProcessingBoundary");

const USER = "francesco";
const ATTEMPT = "hact9-boundary-test";
const CLAIMED_AT = 2000;

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function legacy(id, text = `legacy ${id}`) {
  return { id, type: "episodic", content: { text }, timestamp: 1000,
    activation: 0.5, orbitalLevel: "medium", tags: ["preserve"] };
}

function fixture(t, records) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hact9-processing-boundary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, `${USER}_memories.json`);
  let map = Object.fromEntries(records.map((record) => [record.id, structuredClone(record)]));
  fs.writeFileSync(file, JSON.stringify(map));
  const storage = new JsonMemoryStorage(directory);
  const boundary = createAuthoritativeLegacyProcessingBoundary({
    authoritativeStorage: storage,
    loadAuthoritativeMap: async () => JSON.parse(fs.readFileSync(file, "utf8")),
    userId: USER,
    processingAttemptId: ATTEMPT,
    claimedAt: CLAIMED_AT
  });
  return {
    get map() { return map; },
    setMap(value) {
      map = structuredClone(value);
      fs.writeFileSync(file, JSON.stringify(map));
    },
    storage, boundary
  };
}

async function authorize(state, ids) {
  return state.boundary.authorizeSources({
    sourceIdentities: ids.map((id) => ({
      memoryId: id, contentHash: hash(state.map[id].content.text)
    }))
  });
}

test("legacy absence derives canonical raw claim without persisting it", async (t) => {
  const state = fixture(t, [legacy("a")]);
  const receipt = await authorize(state, ["a"]);
  assert.equal(receipt.policyVersion, "legacy-absence-initial-raw-v1");
  assert.equal(receipt.claimPlan.sources[0].expectedProcessing.state, "raw");
  assert.equal(receipt.claimPlan.sources[0].claimedProcessing.state, "synthesizing");
  assert.equal((await state.boundary.storage.loadMemories(USER))[0].processing.state,
    "synthesizing");
  assert.equal(Object.hasOwn((await state.storage.loadMemories(USER))[0], "processing"), false);
});

test("present valid processing is preserved and invalid processing fails closed", async (t) => {
  const valid = legacy("a");
  valid.processing = createProcessingState({
    state: "raw", revision: 0, attempt_id: null, updated_at: 10, error: null
  });
  const validState = fixture(t, [legacy("a")]);
  await authorize(validState, ["a"]);
  validState.setMap({ a: valid });
  assert.deepEqual((await validState.boundary.storage.loadMemories(USER))[0].processing,
    valid.processing);

  const invalidState = fixture(t, [legacy("b")]);
  await authorize(invalidState, ["b"]);
  invalidState.setMap({ b: { ...legacy("b"), processing: null } });
  await assert.rejects(() => invalidState.boundary.storage.loadMemories(USER),
    { code: "SOURCE_PROCESSING_STATE_CONFLICT" });
});

test("non-legacy, key mismatch, wrong user and stale hash fail closed", async (t) => {
  const structured = fixture(t, [{ ...legacy("a"), memoryKind: "raw" }]);
  await assert.rejects(() => authorize(structured, ["a"]),
    { code: "AUTHORITATIVE_LEGACY_RECORD_INCOMPATIBLE" });

  const mismatch = fixture(t, [legacy("a")]);
  mismatch.setMap({ wrong: legacy("a") });
  await assert.rejects(() => mismatch.boundary.authorizeSources({
    sourceIdentities: [{ memoryId: "a", contentHash: hash(legacy("a").content.text) }]
  }),
    { code: "AUTHORITATIVE_LEGACY_RECORD_INCOMPATIBLE" });

  assert.throws(() => createAuthoritativeLegacyProcessingBoundary({
    authoritativeStorage: mismatch.storage,
    loadAuthoritativeMap: async () => mismatch.map,
    userId: "other", processingAttemptId: ATTEMPT, claimedAt: CLAIMED_AT
  }), { code: "INVALID_LEGACY_PROCESSING_BOUNDARY_CONFIGURATION" });

  const crossUser = fixture(t, [{
    ...legacy("a"), meta: { user_id: "other" }
  }]);
  await assert.rejects(() => authorize(crossUser, ["a"]),
    { code: "AUTHORITATIVE_LEGACY_USER_SCOPE_MISMATCH" });

  const stale = fixture(t, [legacy("a")]);
  await assert.rejects(() => stale.boundary.authorizeSources({
    sourceIdentities: [{ memoryId: "a", contentHash: "f".repeat(64) }]
  }), { code: "STALE_SOURCE_REJECTED" });
});

test("save changes selected sources only and strips virtual state on rollback", async (t) => {
  const state = fixture(t, [legacy("a"), legacy("b")]);
  const receipt = await authorize(state, ["a"]);
  const adapted = await state.boundary.storage.loadMemories(USER);
  await state.boundary.storage.saveMemories(USER, adapted);
  const rolledBack = await state.storage.loadMemories(USER);
  assert.equal(Object.hasOwn(rolledBack.find((item) => item.id === "a"), "processing"), false);
  assert.deepEqual(rolledBack.find((item) => item.id === "b"), legacy("b"));

  adapted.find((item) => item.id === "a").processing = createProcessingState({
    state: "consolidated", revision: 3, attempt_id: ATTEMPT,
    updated_at: 3000, error: null
  });
  await state.boundary.storage.saveMemories(USER, adapted);
  const committed = await state.storage.loadMemories(USER);
  assert.equal(committed.find((item) => item.id === "a").processing.state, "consolidated");
  assert.equal(committed.find((item) => item.id === "a")
    .processing_provenance.origin, "legacy_absence_derived");
  assert.deepEqual(committed.find((item) => item.id === "b"), legacy("b"));
  assert.equal(receipt.sourceCount, 1);
});
