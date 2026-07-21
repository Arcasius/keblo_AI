"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const JsonMemoryStorage = require("../../core/JsonMemoryStorage");
const { createProcessingState } = require("../../core/consolidation/ProcessingState");
const {
  createSourceClaimPlan,
  createJournalSourceClaimDescriptor,
  restoreSourceClaimPlanFromJournal,
  claimSources
} = require("../../core/hippocampus/SourceClaimTransaction");
const { createHippocampusJournal } = require("../../core/hippocampus/HippocampusJournal");
const { createRecoveryManager, RECOVERY_ACTIONS } = require("../../core/hippocampus/RecoveryManager");

const USER = "fix16-private-user-sentinel";
const BASE = 1910000000000;
const sha = value => createHash("sha256").update(value, "utf8").digest("hex");

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fix16-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function raw(id) {
  return {
    id,
    type: "episodic",
    content: { text: `synthetic ${id}` },
    timestamp: BASE - 10,
    memoryKind: "raw",
    storageTier: "warm",
    processing: createProcessingState({ state: "raw", revision: 0, attempt_id: null, updated_at: BASE - 20, error: null })
  };
}

function claimPlan(memories = [raw("a"), raw("b")]) {
  return createSourceClaimPlan({
    userId: USER,
    sourceMemories: memories,
    sourceIds: memories.map(memory => memory.id),
    attemptId: "attempt-fix16",
    claimedAt: BASE,
    sourceContentHashes: Object.fromEntries(memories.map(memory => [memory.id, sha(memory.content.text)]))
  });
}

function event(details) {
  return {
    event_type: "SOURCES_CLAIMED",
    run_id: "run-fix16",
    mode: "commit",
    phase: "synthesis",
    status: "claimed",
    timestamp: BASE + 1,
    cluster_id: "cluster-fix16",
    attempt_id: "attempt-fix16",
    source_memory_ids: ["a", "b"],
    details
  };
}

function containsValue(value, sentinel, seen = new WeakSet()) {
  if (typeof value === "string") return value.includes(sentinel);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, child]) => key.includes(sentinel) || containsValue(child, sentinel, seen));
}

function legacyRecord(input, sequence) {
  const normalized = {
    event_type: input.event_type,
    run_id: input.run_id,
    mode: input.mode ?? null,
    phase: input.phase ?? null,
    status: input.status ?? null,
    timestamp: input.timestamp,
    cluster_id: input.cluster_id ?? null,
    transaction_id: input.transaction_id ?? null,
    attempt_id: input.attempt_id ?? null,
    source_memory_ids: [...(input.source_memory_ids || [])].sort(),
    details: input.details || {}
  };
  const eventId = sha(stable(normalized));
  const record = {
    schema_version: 1,
    event_id: eventId,
    event_type: normalized.event_type,
    sequence,
    run_id: normalized.run_id,
    mode: normalized.mode,
    phase: normalized.phase,
    status: normalized.status,
    timestamp: normalized.timestamp,
    cluster_id: normalized.cluster_id,
    transaction_id: normalized.transaction_id,
    attempt_id: normalized.attempt_id,
    source_memory_ids: normalized.source_memory_ids,
    details: normalized.details,
    event_fingerprint: ""
  };
  record.event_fingerprint = sha(stable({ ...record, event_fingerprint: undefined }));
  return record;
}

test("journal-safe claim preserves recovery identifiers and removes user identity", () => {
  const plan = claimPlan();
  const descriptor = createJournalSourceClaimDescriptor(plan);
  assert.deepEqual(Object.keys(descriptor).sort(), ["attemptId", "claimId", "claimedAt", "schemaVersion", "sources"].sort());
  assert.equal(descriptor.claimId, plan.claimId);
  assert.equal(descriptor.attemptId, plan.attemptId);
  assert.deepEqual(descriptor.sources.map(source => source.memoryId), ["a", "b"]);
  assert.equal(containsValue(descriptor, USER), false);
  assert.deepEqual(restoreSourceClaimPlanFromJournal(descriptor, USER), plan);
});

test("journal rejects user identity recursively, casing variants and hidden values", async t => {
  const journal = createHippocampusJournal({ directory: temp(t), userId: USER });
  const forbidden = [
    { userId: USER },
    { nested: { USER_ID: "masked" } },
    { nested: [{ UserIdentifier: "masked" }] },
    { nested: ["prefix-", { value: `hidden:${USER}:suffix` }] }
  ];
  for (const details of forbidden) {
    await assert.rejects(journal.append(event(details)), error => {
      assert.match(error.code, /^PRIVATE_EVENT_(FIELD|VALUE)$/);
      assert.doesNotMatch(error.message, new RegExp(USER));
      return true;
    });
  }
  const circular = {}; circular.self = circular;
  await assert.rejects(journal.append(event(circular)), { code: "INVALID_EVENT" });
});

test("safe JSONL and replay contain no user sentinel", async t => {
  const directory = temp(t);
  const journal = createHippocampusJournal({ directory, userId: USER });
  const descriptor = createJournalSourceClaimDescriptor(claimPlan());
  const first = await journal.append(event({ claimPlan: descriptor }));
  const replay = await journal.append(event({ claimPlan: descriptor }));
  assert.equal(first.appended, true);
  assert.equal(replay.idempotentReplay, true);
  const events = await journal.readAll();
  assert.equal(events.length, 1);
  assert.equal(containsValue(events, USER), false);
  assert.doesNotMatch(fs.readFileSync(path.join(directory, journal.fileName), "utf8"), new RegExp(USER));
  const inspection = await journal.inspect();
  assert.equal(inspection.legacyPrivacyDetected, false);
  assert.equal(inspection.legacyPrivacyEventCount, 0);
});

test("recovery rebuilds scoped claim from safe descriptor", async t => {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  const memories = [raw("a"), raw("b")];
  await storage.saveMemories(USER, memories);
  const plan = claimPlan(memories);
  await claimSources({ storage, plan });
  const journal = createHippocampusJournal({ directory, userId: USER });
  await journal.append({ event_type: "RUN_STARTED", run_id: "run-fix16", mode: "commit", phase: "commit", status: "started", timestamp: BASE - 100, details: {} });
  await journal.append(event({ claimPlan: createJournalSourceClaimDescriptor(plan) }));
  const recovery = createRecoveryManager({ storage, journal, userId: USER, clock: () => BASE + 1000, recoveryGraceMs: 1 });
  const recoveryPlan = await recovery.buildRecoveryPlan({ generatedAt: BASE + 1000 });
  assert.equal(recoveryPlan.actions[0].action, RECOVERY_ACTIONS.MARK_INTERRUPTED_CLAIM_FAILED);
  assert.equal(recoveryPlan.actions[0].claimDescriptor.claimId, plan.claimId);
  assert.equal(containsValue(recoveryPlan, USER), false);
  assert.equal(JSON.stringify(await journal.readAll()).includes(USER), false);
});

test("valid legacy V1 claim remains readable and is reported without exposing its value", async t => {
  const directory = temp(t);
  const journal = createHippocampusJournal({ directory, userId: USER });
  const legacy = legacyRecord(event({ claimPlan: claimPlan() }), 1);
  fs.writeFileSync(path.join(directory, journal.fileName), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const events = await journal.readAll();
  assert.equal(events.length, 1);
  assert.equal(restoreSourceClaimPlanFromJournal(events[0].details.claimPlan, USER).claimId, legacy.details.claimPlan.claimId);
  const inspection = await journal.inspect();
  assert.equal(inspection.valid, true);
  assert.equal(inspection.legacyPrivacyDetected, true);
  assert.equal(inspection.legacyPrivacyEventCount, 1);
  assert.doesNotMatch(JSON.stringify(inspection), new RegExp(USER));
});

test("privacy rejection before append does not mutate a synthetic dataset", async t => {
  const directory = temp(t);
  const storage = new JsonMemoryStorage(directory);
  const memories = [raw("a"), raw("b")];
  await storage.saveMemories(USER, memories);
  const before = await storage.loadMemories(USER);
  const journal = createHippocampusJournal({ directory, userId: USER });
  await assert.rejects(journal.append(event({ nested: { user_id: USER } })), { code: "PRIVATE_EVENT_FIELD" });
  assert.deepEqual(await storage.loadMemories(USER), before);
  assert.equal(fs.existsSync(path.join(directory, journal.fileName)), false);
});
