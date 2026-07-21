"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createFileLockManager } = require("../locking/FileLockManager");

const HIPPOCAMPUS_JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_EVENT_TYPES = Object.freeze([
  "RUN_STARTED", "PLAN_COMPLETED", "CLUSTER_SELECTED", "CLUSTER_PERSISTED", "SOURCES_CLAIMED",
  "SYNTHESIS_STARTED", "SYNTHESIS_SUCCEEDED", "SYNTHESIS_FAILED", "COMMIT_STARTED", "COMMIT_SUCCEEDED",
  "COMMIT_FAILED", "SOURCES_FAILED", "RUN_COMPLETED", "RUN_FAILED", "RECOVERY_STARTED",
  "RECOVERY_ACTION", "RECOVERY_COMPLETED", "RUN_RECONCILED"
]);
const TYPE_SET = new Set(JOURNAL_EVENT_TYPES);
const FIELDS = ["schema_version", "event_id", "event_type", "sequence", "run_id", "mode", "phase", "status", "timestamp", "cluster_id", "transaction_id", "attempt_id", "source_memory_ids", "details", "event_fingerprint"];
const BANNED_KEYS = new Set(["text", "content", "prompt", "messages", "rawoutput", "centroid", "embedding", "sourcesnapshot", "stack", "token", "path"]);
const RUN_TERMINAL_TYPES = new Set(["RUN_COMPLETED", "RUN_FAILED", "RUN_RECONCILED"]);
const CLUSTER_EVENT_TYPES = new Set([
  "CLUSTER_SELECTED", "CLUSTER_PERSISTED", "SOURCES_CLAIMED", "SYNTHESIS_STARTED",
  "SYNTHESIS_SUCCEEDED", "SYNTHESIS_FAILED", "COMMIT_STARTED", "COMMIT_SUCCEEDED",
  "COMMIT_FAILED", "SOURCES_FAILED"
]);
const CLUSTER_EVENT_RANK = Object.freeze({
  CLUSTER_SELECTED: 1,
  CLUSTER_PERSISTED: 2,
  SOURCES_CLAIMED: 3,
  SYNTHESIS_STARTED: 4,
  SYNTHESIS_SUCCEEDED: 5,
  SYNTHESIS_FAILED: 5,
  COMMIT_STARTED: 6,
  COMMIT_SUCCEEDED: 7,
  COMMIT_FAILED: 7,
  SOURCES_FAILED: 8,
  RUN_RECONCILED: 9
});

class HippocampusJournalError extends Error { constructor(code, message, details = {}) { super(message); this.name = "HippocampusJournalError"; this.code = code; Object.assign(this, details); } }
function fail(code, message, details) { throw new HippocampusJournalError(code, message, details); }
function plain(v) { return v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)); }
function clone(v) { if (Array.isArray(v)) return v.map(clone); if (plain(v)) return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clone(x)])); return v; }
function freeze(v) { Object.freeze(v); for (const x of Object.values(v)) if (x && typeof x === "object" && !Object.isFrozen(x)) freeze(x); return v; }
function stable(v) { if (v === null || typeof v !== "object") return JSON.stringify(v); if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`; return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`; }
function sha(v) { return createHash("sha256").update(typeof v === "string" ? v : stable(v), "utf8").digest("hex"); }
function normalizedKey(key) { return key.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function isIdentityKey(key) {
  const normalized = normalizedKey(key);
  return normalized === "username" || normalized === "useridentifier" ||
    (normalized.endsWith("userid") && !normalized.endsWith("useridhash"));
}
function inspectDetails(value, userId, validationOptions = {}, seen = new WeakSet()) {
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return false;
  if (typeof value === "string") {
    const privateValue = value.includes(userId);
    if (privateValue && validationOptions.allowLegacyIdentity !== true) fail("PRIVATE_EVENT_VALUE", "Journal event contains a forbidden private value");
    return privateValue;
  }
  if (!value || typeof value !== "object") fail("INVALID_EVENT", "Journal details must be finite plain JSON");
  if (seen.has(value)) fail("INVALID_EVENT", "Journal details must be acyclic plain JSON");
  seen.add(value);
  if (!Array.isArray(value) && !plain(value)) fail("INVALID_EVENT", "Journal details must be finite plain JSON");
  let legacyIdentity = false;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (BANNED_KEYS.has(normalized)) fail("PRIVATE_EVENT_FIELD", "Journal event contains a forbidden field");
    if (isIdentityKey(key)) {
      if (validationOptions.allowLegacyIdentity !== true) fail("PRIVATE_EVENT_FIELD", "Journal event contains a forbidden identity field");
      legacyIdentity = true;
    }
    if (inspectDetails(child, userId, validationOptions, seen)) legacyIdentity = true;
  }
  seen.delete(value);
  return legacyIdentity;
}

function createHippocampusJournal(options = {}) {
  if (!plain(options) || typeof options.directory !== "string" || !options.directory || typeof options.userId !== "string" || !options.userId || options.clock !== undefined && typeof options.clock !== "function" || options.lockManager !== undefined && typeof options.lockManager.withLock !== "function") fail("INVALID_OPTIONS", "Journal directory and userId are required");
  const userHash = sha(options.userId);
  const filePath = path.join(options.directory, `${userHash}_hippocampus_journal.jsonl`);
  const lockManager = options.lockManager || createFileLockManager({ lockDirectory: path.join(options.directory, ".journal-locks") });
  const lockKey = `journal:${userHash}`;
  const clock = options.clock || Date.now;

  function normalizeInput(event, validationOptions = {}) {
    if (!plain(event) || Object.keys(event).some(k => !["event_type","run_id","mode","phase","status","timestamp","cluster_id","transaction_id","attempt_id","source_memory_ids","details"].includes(k))) fail("INVALID_EVENT", "Journal event shape is invalid");
    if (!TYPE_SET.has(event.event_type) || typeof event.run_id !== "string" || !event.run_id || !Number.isSafeInteger(event.timestamp) || event.timestamp < 0) fail("INVALID_EVENT", "Journal event identity is invalid");
    const ids = event.source_memory_ids === undefined ? [] : event.source_memory_ids;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) fail("INVALID_EVENT", "Journal source IDs are invalid");
    inspectDetails(event, options.userId, validationOptions);
    return { event_type: event.event_type, run_id: event.run_id, mode: event.mode ?? null, phase: event.phase ?? null, status: event.status ?? null, timestamp: event.timestamp, cluster_id: event.cluster_id ?? null, transaction_id: event.transaction_id ?? null, attempt_id: event.attempt_id ?? null, source_memory_ids: [...ids].sort(), details: clone(event.details || {}) };
  }
  function semanticId(input) { return sha(input); }
  function fingerprint(event) { return sha({ ...event, event_fingerprint: undefined }); }
  function validateEvent(event, expectedSequence) {
    if (!plain(event) || Object.keys(event).sort().join(",") !== [...FIELDS].sort().join(",") || event.schema_version !== 1 || event.sequence !== expectedSequence) fail("JOURNAL_CORRUPT", "Journal event schema or sequence is invalid");
    const input = normalizeInput({ event_type:event.event_type, run_id:event.run_id, mode:event.mode, phase:event.phase, status:event.status, timestamp:event.timestamp, cluster_id:event.cluster_id, transaction_id:event.transaction_id, attempt_id:event.attempt_id, source_memory_ids:event.source_memory_ids, details:event.details }, { allowLegacyIdentity: true });
    if (event.event_id !== semanticId(input) || event.event_fingerprint !== fingerprint({ ...event, event_fingerprint: undefined })) fail("JOURNAL_CORRUPT", "Journal event fingerprint is invalid");
    return freeze(clone(event));
  }
  function parseRaw(raw) {
    if (!raw) return { events: [], tailIncomplete: false, validOffset: 0, legacyPrivacyEventCount: 0 };
    const endsNewline = raw.endsWith("\n");
    const lines = raw.split("\n"); if (endsNewline) lines.pop();
    const events = []; let offset = 0; let legacyPrivacyEventCount = 0;
    for (let i=0;i<lines.length;i++) {
      const line = lines[i];
      if (!line) fail("JOURNAL_CORRUPT", "Journal contains an empty intermediate line");
      let parsed;
      try { parsed = JSON.parse(line); } catch {
        if (i === lines.length - 1 && !endsNewline) return { events, tailIncomplete: true, validOffset: offset, legacyPrivacyEventCount };
        fail("JOURNAL_CORRUPT_INTERMEDIATE", "Journal contains intermediate corruption");
      }
      if (inspectDetails(parsed, options.userId, { allowLegacyIdentity: true })) legacyPrivacyEventCount += 1;
      events.push(validateEvent(parsed, events.length + 1)); offset += Buffer.byteLength(line + "\n");
    }
    return { events, tailIncomplete: !endsNewline, validOffset: offset, legacyPrivacyEventCount };
  }
  async function rawRead() { try { return await fs.promises.readFile(filePath, "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; } }
  async function readAll() { const parsed = parseRaw(await rawRead()); if (parsed.tailIncomplete) fail("JOURNAL_TRUNCATED_TAIL", "Journal has an incomplete tail"); return freeze(parsed.events.map(clone)); }
  async function append(event) {
    const input = normalizeInput(event); const eventId = semanticId(input);
    return lockManager.withLock(lockKey, async () => {
      const parsed = parseRaw(await rawRead()); if (parsed.tailIncomplete) fail("JOURNAL_TRUNCATED_TAIL", "Journal tail must be repaired before append");
      const existing = parsed.events.find(item => item.event_id === eventId);
      if (existing) return freeze({ event: existing, appended: false, idempotentReplay: true });
      const record = { schema_version: 1, event_id: eventId, event_type: input.event_type, sequence: parsed.events.length + 1, run_id: input.run_id, mode: input.mode, phase: input.phase, status: input.status, timestamp: input.timestamp, cluster_id: input.cluster_id, transaction_id: input.transaction_id, attempt_id: input.attempt_id, source_memory_ids: input.source_memory_ids, details: input.details, event_fingerprint: "" };
      record.event_fingerprint = fingerprint({ ...record, event_fingerprint: undefined });
      await fs.promises.mkdir(options.directory, { recursive: true }); const handle = await fs.promises.open(filePath, "a", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      return freeze({ event: validateEvent(record, record.sequence), appended: true, idempotentReplay: false });
    });
  }
  async function inspect() {
    const raw = await rawRead(); const fileFingerprint = sha(raw);
    try { const parsed = parseRaw(raw); return freeze({ valid: !parsed.tailIncomplete, tailIncomplete: parsed.tailIncomplete, eventCount: parsed.events.length, legacyPrivacyDetected: parsed.legacyPrivacyEventCount > 0, legacyPrivacyEventCount: parsed.legacyPrivacyEventCount, journalFingerprint: fileFingerprint, fileSize: Buffer.byteLength(raw), validOffset: parsed.validOffset, corruption: parsed.tailIncomplete ? "TRUNCATED_TAIL" : null }); }
    catch (error) { return freeze({ valid: false, tailIncomplete: false, eventCount: null, journalFingerprint: fileFingerprint, fileSize: Buffer.byteLength(raw), validOffset: null, corruption: error.code || "JOURNAL_CORRUPT" }); }
  }
  async function repairTail(request = {}) {
    const state = await inspect(); const plan = freeze({ dryRun: true, repairable: state.tailIncomplete, journalFingerprint: state.journalFingerprint, fileSize: state.fileSize, truncateOffset: state.validOffset });
    if (request.commitRepair !== true) return plan;
    if (request.confirmRepair !== "REPAIR_HIPPOCAMPUS_JOURNAL_V1") fail("REPAIR_CONFIRMATION_REQUIRED", "Journal repair confirmation is required");
    if (!state.tailIncomplete) { if (!state.valid) fail("REPAIR_BLOCKED", "Only an incomplete tail can be repaired"); return freeze({ ...plan, repaired: false, idempotentReplay: true }); }
    return lockManager.withLock(lockKey, async () => {
      const current = await rawRead(); if (sha(current) !== state.journalFingerprint || Buffer.byteLength(current) !== state.fileSize) fail("REPAIR_PRECONDITION_FAILED", "Journal changed before repair");
      await fs.promises.copyFile(filePath, `${filePath}.bak`); const handle = await fs.promises.open(filePath, "r+");
      try { await handle.truncate(state.validOffset); await handle.sync(); } finally { await handle.close(); }
      await readAll(); return freeze({ ...plan, dryRun: false, repaired: true, backupCreated: true });
    });
  }
  async function getRunEvents(runId) { return freeze((await readAll()).filter(event => event.run_id === runId).map(clone)); }
  function clusterClassification(events, blocked) {
    const types = events.map(event => event.event_type);
    if (blocked) return "CORRUPT_OR_AMBIGUOUS";
    if (types.includes("RUN_RECONCILED")) return "RECOVERED";
    if (types.includes("COMMIT_SUCCEEDED")) return "COMMITTED";
    if (types.includes("SOURCES_FAILED")) return "FAILED";
    if (types.includes("COMMIT_FAILED")) return "COMMIT_FAILED_NO_SOURCE_TERMINAL";
    if (types.includes("COMMIT_STARTED")) return "COMMIT_STARTED_NO_RESULT";
    if (types.includes("SYNTHESIS_FAILED")) return "SYNTHESIS_FAILED_NO_SOURCE_TERMINAL";
    if (types.includes("SYNTHESIS_SUCCEEDED")) return "SYNTHESIS_SUCCEEDED_NO_COMMIT";
    if (types.includes("SYNTHESIS_STARTED")) return "SYNTHESIS_STARTED_NO_RESULT";
    if (types.includes("SOURCES_CLAIMED")) return "CLAIMED_NO_SYNTHESIS";
    if (types.includes("CLUSTER_PERSISTED")) return "CLUSTER_PERSISTED_NO_CLAIM";
    if (types.includes("CLUSTER_SELECTED")) return "CLUSTER_SELECTED_NO_PERSIST";
    return "CORRUPT_OR_AMBIGUOUS";
  }
  function reconstructCluster(runId, clusterId, events) {
    const attempts = [...new Set(events.map(event => event.attempt_id).filter(Boolean))];
    const transactions = [...new Set(events.map(event => event.transaction_id).filter(Boolean))];
    const claims = events.filter(event => event.event_type === "SOURCES_CLAIMED");
    const claimIds = [...new Set(claims.map(event => event.details?.claimPlan?.claimId).filter(Boolean))];
    const clusterRecordIds = [...new Set(events.filter(event => event.event_type === "CLUSTER_PERSISTED").map(event => event.details?.clusterRecordId).filter(Boolean))];
    const sourceSets = [...new Set(events.filter(event => event.source_memory_ids.length).map(event => stable(event.source_memory_ids)))];
    const reasonCodes = [];
    if (attempts.length > 1) reasonCodes.push("ATTEMPT_ID_CONFLICT");
    if (transactions.length > 1) reasonCodes.push("TRANSACTION_ID_CONFLICT");
    if (claimIds.length > 1) reasonCodes.push("CLAIM_ID_CONFLICT");
    if (clusterRecordIds.length > 1) reasonCodes.push("CLUSTER_RECORD_ID_CONFLICT");
    if (sourceSets.length > 1) reasonCodes.push("SOURCE_IDS_CONFLICT");
    for (const claim of claims) {
      const descriptor = claim.details?.claimPlan;
      const descriptorIds = descriptor?.sources?.map(source => source.memoryId).sort();
      if (!descriptor || descriptor.attemptId !== claim.attempt_id ||
          stable(descriptorIds) !== stable(claim.source_memory_ids)) reasonCodes.push("CLAIM_CORRELATION_MISMATCH");
    }
    let rank = 0;
    for (const event of events) {
      const next = CLUSTER_EVENT_RANK[event.event_type] || rank;
      if (next < rank) reasonCodes.push("CLUSTER_EVENT_ORDER_INVALID");
      rank = Math.max(rank, next);
    }
    const uniqueReasons = [...new Set(reasonCodes)].sort();
    const classification = clusterClassification(events, uniqueReasons.length > 0);
    const terminal = ["COMMITTED", "FAILED", "RECOVERED"].includes(classification);
    return freeze({
      correlationKey: sha({ schemaVersion: 1, domain: "hippocampus.cluster-work-v1", runId, clusterId }),
      clusterId,
      clusterRecordId: clusterRecordIds.length === 1 ? clusterRecordIds[0] : null,
      classification,
      terminal,
      blocked: uniqueReasons.length > 0,
      reasonCodes: uniqueReasons,
      claimId: claimIds.length === 1 ? claimIds[0] : null,
      claimIds: [...claimIds].sort(),
      attemptId: attempts.length === 1 ? attempts[0] : null,
      attemptIds: [...attempts].sort(),
      transactionId: transactions.length === 1 ? transactions[0] : null,
      sourceMemoryIds: sourceSets.length === 1 ? JSON.parse(sourceSets[0]) : [],
      firstSequence: events[0].sequence,
      lastSequence: events.at(-1).sequence,
      lastTimestamp: events.at(-1).timestamp
    });
  }
  function reconstructRun(runId, events) {
    const clusterGroups = new Map();
    let missingClusterCorrelation = false;
    for (const event of events) {
      const clusterLevel = CLUSTER_EVENT_TYPES.has(event.event_type) || event.event_type === "RUN_RECONCILED" && event.cluster_id !== null;
      if (!clusterLevel) continue;
      if (typeof event.cluster_id !== "string" || !event.cluster_id) { missingClusterCorrelation = true; continue; }
      if (!clusterGroups.has(event.cluster_id)) clusterGroups.set(event.cluster_id, []);
      clusterGroups.get(event.cluster_id).push(event);
    }
    const clusters = [...clusterGroups.entries()].map(([clusterId, list]) => reconstructCluster(runId, clusterId, list)).sort((a, b) => a.clusterId.localeCompare(b.clusterId));
    const terminalClusters = clusters.filter(cluster => cluster.terminal).map(cluster => cluster.clusterId);
    const incompleteClusters = clusters.filter(cluster => !cluster.terminal && !cluster.blocked).map(cluster => cluster.clusterId);
    const blockedClusters = clusters.filter(cluster => cluster.blocked).map(cluster => cluster.clusterId);
    const runTerminalEvents = events.filter(event => RUN_TERMINAL_TYPES.has(event.event_type) && event.cluster_id === null);
    const runTerminalTypes = [...new Set(runTerminalEvents.map(event => event.event_type))];
    const runReasonCodes = [];
    const claimOwners = new Map();
    const attemptOwners = new Map();
    const sourceOwners = new Map();
    for (const cluster of clusters) {
      for (const [values, owners, code] of [
        [cluster.claimIds, claimOwners, "CLAIM_ID_SHARED_ACROSS_CLUSTERS"],
        [cluster.attemptIds, attemptOwners, "ATTEMPT_ID_SHARED_ACROSS_CLUSTERS"]
      ]) {
        for (const value of values) {
          if (owners.has(value) && owners.get(value) !== cluster.clusterId) runReasonCodes.push(code);
          else owners.set(value, cluster.clusterId);
        }
      }
      for (const sourceId of cluster.sourceMemoryIds) {
        if (sourceOwners.has(sourceId) && sourceOwners.get(sourceId) !== cluster.clusterId) runReasonCodes.push("SOURCE_ASSIGNED_TO_MULTIPLE_CLUSTERS");
        else sourceOwners.set(sourceId, cluster.clusterId);
      }
    }
    if (missingClusterCorrelation) runReasonCodes.push("MISSING_CLUSTER_CORRELATION");
    if (runTerminalTypes.length > 1) runReasonCodes.push("RUN_TERMINAL_CONFLICT");
    if (runTerminalEvents.length && (incompleteClusters.length || blockedClusters.length)) runReasonCodes.push("RUN_TERMINAL_WITH_NONTERMINAL_CLUSTER");
    const blocked = runReasonCodes.length > 0 || blockedClusters.length > 0;
    let classification;
    if (blocked) classification = "CORRUPT_OR_AMBIGUOUS";
    else if (runTerminalTypes[0] === "RUN_COMPLETED" || runTerminalTypes[0] === "RUN_RECONCILED") classification = "COMPLETE";
    else if (runTerminalTypes[0] === "RUN_FAILED" && incompleteClusters.length === 0) classification = "FAILED_COMPLETE";
    else if (clusters.length > 1 && incompleteClusters.length) classification = "MULTI_CLUSTER_INCOMPLETE";
    else if (clusters.length === 1) classification = clusters[0].classification === "COMMITTED" ? "COMMIT_SUCCEEDED_NO_RUN_COMPLETION" : clusters[0].classification;
    else if (clusters.length && terminalClusters.length === clusters.length) classification = "ALL_CLUSTERS_TERMINAL_NO_RUN_COMPLETION";
    else classification = "CORRUPT_OR_AMBIGUOUS";
    return freeze({
      runId,
      classification,
      complete: ["COMPLETE", "FAILED_COMPLETE"].includes(classification),
      blocked,
      reasonCodes: [...new Set([...runReasonCodes, ...clusters.flatMap(cluster => cluster.reasonCodes)])].sort(),
      clusters,
      clusterIds: clusters.map(cluster => cluster.clusterId),
      terminalClusters,
      incompleteClusters,
      blockedClusters,
      attemptIds: [...new Set(clusters.map(cluster => cluster.attemptId).filter(Boolean))].sort(),
      lastSequence: events.at(-1).sequence,
      lastTimestamp: events.at(-1).timestamp
    });
  }
  async function reconstructRuns() {
    const groups = new Map();
    for (const event of await readAll()) {
      if (event.event_type.startsWith("RECOVERY_")) continue;
      if (!groups.has(event.run_id)) groups.set(event.run_id, []);
      groups.get(event.run_id).push(event);
    }
    return freeze([...groups.entries()].map(([runId, events]) => reconstructRun(runId, events)).sort((a, b) => a.runId.localeCompare(b.runId)));
  }
  async function getRunState(runId) { return (await reconstructRuns()).find(run => run.runId === runId) || null; }
  async function findIncompleteRuns() { return freeze((await reconstructRuns()).filter(run => !run.complete).map(clone)); }
  return Object.freeze({ append, readAll, inspect, repairTail, reconstructRuns, getRunState, findIncompleteRuns, getRunEvents, userIdHash: userHash, fileName: path.basename(filePath) });
}

module.exports = { HIPPOCAMPUS_JOURNAL_SCHEMA_VERSION, JOURNAL_EVENT_TYPES, HippocampusJournalError, createHippocampusJournal };
