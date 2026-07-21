"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const fsPromises = fs.promises;
const DIRECTORY_FSYNC_UNSUPPORTED = new Set([
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
  "EPERM"
]);

const ERROR_CODES = Object.freeze({
  ARGUMENT: "ERR_ATOMIC_JSON_INVALID_ARGUMENT",
  SERIALIZATION: "ERR_ATOMIC_JSON_SERIALIZATION",
  TEMP_WRITE: "ERR_ATOMIC_JSON_TEMP_WRITE",
  VALIDATION: "ERR_ATOMIC_JSON_VALIDATION",
  BACKUP: "ERR_ATOMIC_JSON_BACKUP",
  COMMIT: "ERR_ATOMIC_JSON_COMMIT",
  DIRECTORY_SYNC: "ERR_ATOMIC_JSON_DIRECTORY_SYNC",
  CLEANUP: "ERR_ATOMIC_JSON_CLEANUP"
});

class AtomicJsonCommitError extends Error {
  constructor(message, { code, phase, cause, committed = false } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AtomicJsonCommitError";
    this.code = code;
    this.phase = phase;
    this.committed = committed;
  }
}

function fail(message, code, phase, cause, committed = false) {
  return new AtomicJsonCommitError(message, {
    code,
    phase,
    cause,
    committed
  });
}

function assertFilePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw fail(
      "Atomic JSON target path must be a non-empty string",
      ERROR_CODES.ARGUMENT,
      "argument"
    );
  }
}

function assertSerializable(value, ancestors = new Set()) {
  const type = typeof value;
  if (type === "undefined" || type === "function" || type === "symbol") {
    throw fail(
      `Atomic JSON value contains unsupported type: ${type}`,
      ERROR_CODES.SERIALIZATION,
      "serialization"
    );
  }
  if (type === "bigint") {
    throw fail(
      "Atomic JSON value contains unsupported type: bigint",
      ERROR_CODES.SERIALIZATION,
      "serialization"
    );
  }
  if (value === null || type !== "object") return;
  if (ancestors.has(value)) {
    throw fail(
      "Atomic JSON value contains a circular reference",
      ERROR_CODES.SERIALIZATION,
      "serialization"
    );
  }

  ancestors.add(value);
  for (const key of Object.keys(value)) {
    assertSerializable(value[key], ancestors);
  }
  ancestors.delete(value);
}

function serializeOnce(value) {
  if (value === undefined) {
    throw fail(
      "Atomic JSON top-level value must not be undefined",
      ERROR_CODES.SERIALIZATION,
      "serialization"
    );
  }

  assertSerializable(value);
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    throw fail(
      "Atomic JSON serialization failed",
      ERROR_CODES.SERIALIZATION,
      "serialization",
      error
    );
  }
  if (serialized === undefined) {
    throw fail(
      "Atomic JSON serialization produced undefined",
      ERROR_CODES.SERIALIZATION,
      "serialization"
    );
  }
  try {
    JSON.parse(serialized);
  } catch (error) {
    throw fail(
      "Atomic JSON serialization could not be parsed",
      ERROR_CODES.SERIALIZATION,
      "serialization",
      error
    );
  }
  return serialized;
}

async function readAndParseJson(filePath) {
  const content = await fsPromises.readFile(filePath, "utf8");
  return { content, parsed: JSON.parse(content) };
}

async function validateJsonFile(filePath) {
  assertFilePath(filePath);
  try {
    const { content } = await readAndParseJson(filePath);
    return {
      valid: true,
      filePath,
      bytes: Buffer.byteLength(content, "utf8")
    };
  } catch (error) {
    throw fail(
      `JSON validation failed for ${filePath}`,
      ERROR_CODES.VALIDATION,
      "validation",
      error
    );
  }
}

function temporaryPathFor(filePath, label) {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  return path.join(
    directory,
    `.${baseName}.${label}.${process.pid}.${randomUUID()}.tmp`
  );
}

async function writeExclusive(filePath, content) {
  let handle;
  try {
    handle = await fsPromises.open(filePath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await fsPromises.open(directoryPath, fs.constants.O_RDONLY);
    await handle.sync();
    return true;
  } catch (error) {
    if (DIRECTORY_FSYNC_UNSUPPORTED.has(error.code)) return false;
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function removeIfPresent(filePath) {
  if (!filePath) return;
  try {
    await fsPromises.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function atomicWriteJson(filePath, value, options = {}) {
  assertFilePath(filePath);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw fail(
      "Atomic JSON options must be an object",
      ERROR_CODES.ARGUMENT,
      "argument"
    );
  }
  if (options.validator !== undefined && typeof options.validator !== "function") {
    throw fail(
      "Atomic JSON validator must be a function",
      ERROR_CODES.ARGUMENT,
      "argument"
    );
  }

  const serialized = serializeOnce(value);
  const directoryPath = path.dirname(filePath);
  const backupPath = `${filePath}.bak`;
  const tempPath = temporaryPathFor(filePath, "write");
  const backupTempPath = temporaryPathFor(filePath, "backup");
  let phase = "temp-write";
  let committed = false;
  let replacedExistingFile = false;
  let backupCreated = false;

  try {
    await fsPromises.mkdir(directoryPath, { recursive: true });
    await writeExclusive(tempPath, serialized);

    phase = "validation";
    const temp = await readAndParseJson(tempPath);
    if (options.validator) await options.validator(temp.parsed);

    phase = "backup";
    let previous = null;
    try {
      previous = await readAndParseJson(filePath);
      replacedExistingFile = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (previous) {
      await writeExclusive(backupTempPath, previous.content);
      await validateJsonFile(backupTempPath);
      await fsPromises.rename(backupTempPath, backupPath);
      backupCreated = true;
    }

    phase = "commit";
    await fsPromises.rename(tempPath, filePath);
    committed = true;

    phase = "directory-sync";
    const directorySynced = await syncDirectory(directoryPath);

    return {
      targetPath: filePath,
      backupCreated,
      bytesWritten: Buffer.byteLength(serialized, "utf8"),
      replacedExistingFile,
      directorySynced
    };
  } catch (error) {
    let wrapped = error;
    if (!(error instanceof AtomicJsonCommitError) || error.phase !== phase) {
      const details = {
        "temp-write": [ERROR_CODES.TEMP_WRITE, "Atomic JSON temp write failed"],
        validation: [ERROR_CODES.VALIDATION, "Atomic JSON temp validation failed"],
        backup: [ERROR_CODES.BACKUP, "Atomic JSON backup failed"],
        commit: [ERROR_CODES.COMMIT, "Atomic JSON commit rename failed"],
        "directory-sync": [
          ERROR_CODES.DIRECTORY_SYNC,
          "Atomic JSON directory sync failed"
        ]
      }[phase];
      wrapped = fail(details[1], details[0], phase, error, committed);
    }

    const cleanupFailures = [];
    for (const residue of [tempPath, backupTempPath]) {
      try {
        await removeIfPresent(residue);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError.code || "UNKNOWN");
      }
    }
    if (cleanupFailures.length > 0) {
      if (!wrapped) {
        throw fail(
          "Atomic JSON cleanup failed",
          ERROR_CODES.CLEANUP,
          "cleanup",
          undefined,
          committed
        );
      }
      wrapped.cleanupFailures = cleanupFailures;
    }
    throw wrapped;
  }
}

module.exports = {
  atomicWriteJson,
  validateJsonFile,
  AtomicJsonCommitError
};
