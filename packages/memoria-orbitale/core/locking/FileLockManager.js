"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");

const DEFAULT_LOCK_OPTIONS = Object.freeze({
  timeoutMs: 10000,
  retryIntervalMs: 25
});

class FileLockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FileLockError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FileLockError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateTiming(options, defaults) {
  if (options === undefined) return { ...defaults };
  if (!isPlainObject(options)) fail("LOCK_INVALID_OPTIONS", "Lock options must be a plain object");
  for (const key of Object.keys(options)) {
    if (!["timeoutMs", "retryIntervalMs"].includes(key)) {
      fail("LOCK_INVALID_OPTIONS", "Lock options contain an unsupported property");
    }
  }
  const merged = { ...defaults, ...options };
  for (const key of ["timeoutMs", "retryIntervalMs"]) {
    if (!Number.isInteger(merged[key]) || merged[key] <= 0) {
      fail("LOCK_INVALID_OPTIONS", `${key} must be a positive integer`);
    }
  }
  return merged;
}

function hashKey(lockKey) {
  return createHash("sha256").update(lockKey, "utf8").digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createFileLockManager(options) {
  if (!isPlainObject(options)) fail("LOCK_INVALID_OPTIONS", "File lock manager options are required");
  const allowed = new Set(["lockDirectory", "timeoutMs", "retryIntervalMs"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail("LOCK_INVALID_OPTIONS", "File lock manager options contain an unsupported property");
  }
  if (typeof options.lockDirectory !== "string" || options.lockDirectory.length === 0) {
    fail("LOCK_INVALID_OPTIONS", "lockDirectory must be a non-empty string");
  }
  const defaults = validateTiming({
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.retryIntervalMs === undefined ? {} : { retryIntervalMs: options.retryIntervalMs })
  }, DEFAULT_LOCK_OPTIONS);
  const lockDirectory = options.lockDirectory;
  const handles = new WeakMap();
  const ownerId = `${process.pid}:${randomUUID()}`;

  async function acquire(lockKey, acquireOptions) {
    if (typeof lockKey !== "string" || lockKey.trim().length === 0) {
      fail("LOCK_INVALID_KEY", "lockKey must be a non-empty string");
    }
    const timing = validateTiming(acquireOptions, defaults);
    const lockKeyHash = hashKey(lockKey);
    const lockPath = path.join(lockDirectory, `${lockKeyHash}.lock`);
    const startedAt = Date.now();
    const token = randomUUID();
    const record = JSON.stringify({ schemaVersion: 1, token, ownerId, pid: process.pid, host: os.hostname(), createdAt: Date.now() });
    await fs.promises.mkdir(lockDirectory, { recursive: true });

    while (true) {
      let fileHandle;
      try {
        fileHandle = await fs.promises.open(lockPath, "wx", 0o600);
        await fileHandle.writeFile(record, "utf8");
        await fileHandle.sync();
        await fileHandle.close();
        fileHandle = null;
        const handle = Object.freeze({ schemaVersion: 1, lockKeyHash, token, ownerId });
        handles.set(handle, { lockPath, lockKeyHash, token, ownerId, released: false });
        return handle;
      } catch (error) {
        if (fileHandle) await fileHandle.close().catch(() => {});
        if (error.code === "ENOENT") {
          await fs.promises.mkdir(lockDirectory, { recursive: true });
          continue;
        }
        if (error.code !== "EEXIST") fail("LOCK_ACQUIRE_FAILED", "Lock acquisition failed");
        if (Date.now() - startedAt >= timing.timeoutMs) {
          fail("LOCK_ACQUIRE_TIMEOUT", "Lock acquisition timed out");
        }
        await delay(Math.min(timing.retryIntervalMs, timing.timeoutMs));
      }
    }
  }

  function validateHandle(lockHandle, expectedLockKey) {
    const state = handles.get(lockHandle);
    if (!state) fail("LOCK_INVALID_HANDLE", "Lock handle is not owned by this manager");
    if (state.released) fail("LOCK_ALREADY_RELEASED", "Lock handle was already released");
    if (expectedLockKey !== undefined && state.lockKeyHash !== hashKey(expectedLockKey)) {
      fail("LOCK_KEY_MISMATCH", "Lock handle does not match the requested key");
    }
    return state;
  }

  async function release(lockHandle) {
    const state = validateHandle(lockHandle);
    let persisted;
    try {
      persisted = JSON.parse(await fs.promises.readFile(state.lockPath, "utf8"));
    } catch {
      fail("LOCK_OWNERSHIP_LOST", "Lock ownership cannot be verified");
    }
    if (persisted.token !== state.token || persisted.ownerId !== state.ownerId) {
      fail("LOCK_OWNERSHIP_LOST", "Lock token or owner does not match");
    }
    try {
      await fs.promises.unlink(state.lockPath);
    } catch {
      fail("LOCK_RELEASE_FAILED", "Lock release failed");
    }
    state.released = true;
    try {
      await fs.promises.rmdir(lockDirectory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) {
        fail("LOCK_RELEASE_FAILED", "Lock directory cleanup failed");
      }
    }
  }

  async function withLock(lockKey, callback, acquireOptions) {
    if (typeof callback !== "function") fail("LOCK_INVALID_CALLBACK", "Lock callback must be callable");
    const handle = await acquire(lockKey, acquireOptions);
    try {
      return await callback(handle);
    } finally {
      await release(handle);
    }
  }

  async function inspect(lockKey, request = {}) {
    if (typeof lockKey !== "string" || !lockKey.trim()) fail("LOCK_INVALID_KEY", "lockKey must be a non-empty string");
    if (!isPlainObject(request) || Object.keys(request).some(key => key !== "staleAfterMs") || request.staleAfterMs !== undefined && (!Number.isInteger(request.staleAfterMs) || request.staleAfterMs <= 0)) fail("LOCK_INVALID_OPTIONS", "Lock inspection options are invalid");
    const lockPath = path.join(lockDirectory, `${hashKey(lockKey)}.lock`);
    let raw;
    try { raw = await fs.promises.readFile(lockPath, "utf8"); } catch (error) {
      if (error.code === "ENOENT") return Object.freeze({ exists: false, metadataValid: false, sameHost: null, pidAlive: null, ageMs: null, staleCandidate: false, lockFingerprint: null });
      fail("LOCK_INSPECT_FAILED", "Lock inspection failed");
    }
    let metadata;
    try { metadata = JSON.parse(raw); } catch { metadata = null; }
    const metadataValid = isPlainObject(metadata) && metadata.schemaVersion === 1 && typeof metadata.token === "string" && typeof metadata.ownerId === "string" && Number.isInteger(metadata.pid) && metadata.pid > 0 && typeof metadata.host === "string" && Number.isInteger(metadata.createdAt) && metadata.createdAt >= 0;
    const sameHost = metadataValid ? metadata.host === os.hostname() : null;
    let pidAlive = null;
    if (metadataValid && sameHost) {
      try { process.kill(metadata.pid, 0); pidAlive = true; } catch (error) { pidAlive = error.code === "EPERM"; }
    }
    const ageMs = metadataValid ? Math.max(0, Date.now() - metadata.createdAt) : null;
    const staleCandidate = Boolean(metadataValid && sameHost && pidAlive === false && request.staleAfterMs !== undefined && ageMs >= request.staleAfterMs);
    return Object.freeze({ exists: true, metadataValid, sameHost, pidAlive, ageMs, staleCandidate, lockFingerprint: createHash("sha256").update(raw).digest("hex") });
  }

  async function recoverStale(lockKey, request = {}) {
    if (!isPlainObject(request) || Object.keys(request).some(key => !["staleAfterMs", "recover", "confirmRecovery"].includes(key))) fail("LOCK_INVALID_OPTIONS", "Stale recovery request is invalid");
    const inspected = await inspect(lockKey, { staleAfterMs: request.staleAfterMs });
    if (!inspected.exists) return Object.freeze({ recovered: false, idempotentReplay: true, reasonCode: "LOCK_ABSENT" });
    if (request.recover !== true || request.confirmRecovery !== "RECOVER_STALE_LOCK_V1") fail("LOCK_RECOVERY_CONFIRMATION_REQUIRED", "Explicit stale lock recovery confirmation is required");
    if (!inspected.metadataValid) fail("LOCK_RECOVERY_BLOCKED", "Lock metadata is invalid");
    if (inspected.sameHost !== true) fail("LOCK_RECOVERY_BLOCKED", "Lock host cannot be verified locally");
    if (inspected.pidAlive !== false) fail("LOCK_RECOVERY_BLOCKED", "Lock owner process is still alive");
    if (!inspected.staleCandidate) fail("LOCK_NOT_STALE", "Lock does not satisfy stale recovery criteria");
    const lockPath = path.join(lockDirectory, `${hashKey(lockKey)}.lock`);
    let current;
    try { current = await fs.promises.readFile(lockPath, "utf8"); } catch (error) {
      if (error.code === "ENOENT") return Object.freeze({ recovered: false, idempotentReplay: true, reasonCode: "LOCK_ABSENT" });
      fail("LOCK_RECOVERY_FAILED", "Lock could not be rechecked");
    }
    if (createHash("sha256").update(current).digest("hex") !== inspected.lockFingerprint) fail("LOCK_RECOVERY_RACE", "Lock changed during stale recovery");
    try { await fs.promises.unlink(lockPath); } catch (error) {
      if (error.code === "ENOENT") return Object.freeze({ recovered: false, idempotentReplay: true, reasonCode: "LOCK_ABSENT" });
      fail("LOCK_RECOVERY_FAILED", "Stale lock removal failed");
    }
    return Object.freeze({ recovered: true, idempotentReplay: false, reasonCode: "STALE_LOCK_RECOVERED" });
  }

  return Object.freeze({ acquire, release, withLock, validateHandle, inspect, recoverStale });
}

module.exports = {
  DEFAULT_LOCK_OPTIONS,
  FileLockError,
  createFileLockManager
};
