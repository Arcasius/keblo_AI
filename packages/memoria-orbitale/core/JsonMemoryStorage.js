const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("./AtomicJsonCommit");
const { validateClusterRecord } = require("./clustering/ClusterRecord");
const { createFileLockManager } = require("./locking/FileLockManager");

const SUPPORTED = Object.freeze({ status: "supported", verified: true });
const UNSUPPORTED = Object.freeze({ status: "unsupported", verified: false });

class ClusterStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClusterStorageError";
    this.code = code;
  }
}

class JsonMemoryStorage {
  constructor(dataDir = "./keblo_data") {
    this.dataDir = dataDir;
    this.defaultUserId = "keblo_user";
    this.capabilities = {
      schemaVersion: 1,
      statuses: {
        "memory.readAll": SUPPORTED,
        "memory.readOne": SUPPORTED,
        "memory.writeOne": SUPPORTED,
        "memory.writeAll": SUPPORTED,
        "memory.deleteOne": SUPPORTED,
        "link.readAll": SUPPORTED,
        "link.writeAll": SUPPORTED,
        "link.writeOne": SUPPORTED,
        "link.deleteOne": UNSUPPORTED,
        "cluster.readAll": SUPPORTED,
        "cluster.readOne": SUPPORTED,
        "cluster.writeOne": SUPPORTED,
        "cluster.deleteOne": SUPPORTED,
        "snapshot.create": UNSUPPORTED,
        "snapshot.verify": UNSUPPORTED,
        "snapshot.restore": UNSUPPORTED,
        "commit.atomic": SUPPORTED,
        "lock.acquire": SUPPORTED,
        "lock.release": SUPPORTED,
        rollback: UNSUPPORTED
      }
    };
    fs.mkdirSync(this.dataDir, { recursive: true });
    this._lockManager = createFileLockManager({
      lockDirectory: path.join(this.dataDir, ".locks")
    });
  }

  _path(userId, kind) {
    return path.join(this.dataDir, `${userId || this.defaultUserId}_${kind}.json`);
  }

  _readJson(filePath) {
    if (!fs.existsSync(filePath)) return {};

    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
  }

  _assertNonEmptyString(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ClusterStorageError("INVALID_CLUSTER_ARGUMENT", `${label} must be a non-empty string`);
    }
  }

  _readClusterMap(userId) {
    this._assertNonEmptyString(userId, "userId");
    const clusters = this._readJson(this._path(userId, "clusters"));
    if (!clusters || typeof clusters !== "object" || Array.isArray(clusters)) {
      throw new ClusterStorageError("INVALID_CLUSTER_FILE", "Cluster file must contain an object map");
    }
    const validated = {};
    for (const [key, value] of Object.entries(clusters)) {
      this._assertNonEmptyString(key, "cluster map key");
      if (!value || value.id !== key) {
        throw new ClusterStorageError("CLUSTER_MAP_KEY_MISMATCH", "Cluster map key must match record ID");
      }
      validated[key] = validateClusterRecord(value);
    }
    return validated;
  }

  async _writeJson(filePath, data) {
    await atomicWriteJson(filePath, data);
  }

  _lockKey(userId) {
    if (typeof userId !== "string" || userId.trim().length === 0) {
      throw new TypeError("userId must be a non-empty string");
    }
    return `user:${userId}`;
  }

  _assertWriteOptions(options) {
    if (options === undefined) return {};
    if (!options || typeof options !== "object" || Array.isArray(options) ||
        Object.keys(options).some((key) => key !== "lockHandle")) {
      throw new TypeError("Write options may contain only lockHandle");
    }
    return options;
  }

  _isWriteOptions(value) {
    return value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === 1 && Object.hasOwn(value, "lockHandle");
  }

  async acquireLock(userId, options) {
    return this._lockManager.acquire(this._lockKey(userId), options);
  }

  async releaseLock(lockHandle) {
    return this._lockManager.release(lockHandle);
  }

  validateLock(userId, lockHandle) {
    this._lockManager.validateHandle(lockHandle, this._lockKey(userId));
    return true;
  }

  async withUserLock(userId, callback, options) {
    return this._lockManager.withLock(this._lockKey(userId), callback, options);
  }

  async inspectUserLock(userId, options) {
    return this._lockManager.inspect(this._lockKey(userId), options);
  }

  async recoverStaleUserLock(userId, request) {
    return this._lockManager.recoverStale(this._lockKey(userId), request);
  }

  async _withWriteLock(userId, options, callback) {
    const validated = this._assertWriteOptions(options);
    if (validated.lockHandle) {
      this._lockManager.validateHandle(validated.lockHandle, this._lockKey(userId));
      return callback(validated.lockHandle);
    }
    return this.withUserLock(userId, callback);
  }

  _toObjectById(items) {
    if (!items) return {};
    if (!Array.isArray(items)) return items;

    return items.reduce((acc, item) => {
      if (item && item.id) acc[item.id] = item;
      return acc;
    }, {});
  }

  _userIdFromMemory(memory) {
    return memory?.meta?.user_id || memory?.user_id || this.defaultUserId;
  }

  _userIdFromLink(link) {
    return link?.meta?.user_id || link?.user_id || this.defaultUserId;
  }

  async saveMemory(userIdOrMemory, maybeMemory, options) {
    if (options === undefined && this._isWriteOptions(maybeMemory)) {
      options = maybeMemory;
      maybeMemory = undefined;
    }
    const memory = maybeMemory || userIdOrMemory;
    const userId = maybeMemory ? userIdOrMemory : this._userIdFromMemory(memory);
    return this._withWriteLock(userId, options, async () => {
      const filePath = this._path(userId, "memories");
      const memories = this._readJson(filePath);
      memories[memory.id] = memory;
      await this._writeJson(filePath, memories);
      return memory;
    });
  }

  async getMemory(userIdOrId, maybeId) {
    const userId = maybeId ? userIdOrId : this.defaultUserId;
    const id = maybeId || userIdOrId;
    const memories = this._readJson(this._path(userId, "memories"));
    return memories[id] || null;
  }

  async loadMemories(userId = this.defaultUserId) {
    const memories = this._readJson(this._path(userId, "memories"));
    return Object.values(memories);
  }

  async saveMemories(userId, memories, options) {
    return this._withWriteLock(userId, options, async () => {
      await this._writeJson(
        this._path(userId, "memories"),
        this._toObjectById(memories)
      );
    });
  }

  async deleteMemory(userIdOrId, maybeId, options) {
    if (options === undefined && this._isWriteOptions(maybeId)) {
      options = maybeId;
      maybeId = undefined;
    }
    const userId = maybeId ? userIdOrId : this.defaultUserId;
    const id = maybeId || userIdOrId;
    return this._withWriteLock(userId, options, async () => {
      const filePath = this._path(userId, "memories");
      const memories = this._readJson(filePath);
      delete memories[id];
      await this._writeJson(filePath, memories);
    });
  }

  async saveLink(userIdOrLink, maybeLink, options) {
    if (options === undefined && this._isWriteOptions(maybeLink)) {
      options = maybeLink;
      maybeLink = undefined;
    }
    const link = maybeLink || userIdOrLink;
    const userId = maybeLink ? userIdOrLink : this._userIdFromLink(link);
    return this._withWriteLock(userId, options, async () => {
      const filePath = this._path(userId, "links");
      const links = this._readJson(filePath);
      links[link.id] = link;
      await this._writeJson(filePath, links);
      return link;
    });
  }

  async loadLinks(userId = this.defaultUserId) {
    const links = this._readJson(this._path(userId, "links"));
    return Object.values(links);
  }

  async saveLinks(userId, links, options) {
    return this._withWriteLock(userId, options, async () => {
      await this._writeJson(this._path(userId, "links"), this._toObjectById(links));
    });
  }

  async getLinkBetween(userIdOrSourceId, sourceIdOrTargetId, maybeTargetId) {
    const userId = maybeTargetId ? userIdOrSourceId : this.defaultUserId;
    const sourceId = maybeTargetId ? sourceIdOrTargetId : userIdOrSourceId;
    const targetId = maybeTargetId || sourceIdOrTargetId;
    const links = await this.loadLinks(userId);

    return links.find(l =>
      (l.source === sourceId && l.target === targetId) ||
      (l.source === targetId && l.target === sourceId)
    ) || null;
  }

  async getLinksForMemory(userIdOrMemoryId, maybeMemoryId) {
    const userId = maybeMemoryId ? userIdOrMemoryId : this.defaultUserId;
    const memoryId = maybeMemoryId || userIdOrMemoryId;
    const links = await this.loadLinks(userId);
    return links.filter(l => l.source === memoryId || l.target === memoryId);
  }

  async loadClusters(userId = this.defaultUserId) {
    return Object.values(this._readClusterMap(userId)).map((record) =>
      validateClusterRecord(record)
    );
  }

  async getCluster(userId, clusterId) {
    this._assertNonEmptyString(userId, "userId");
    this._assertNonEmptyString(clusterId, "clusterId");
    const record = this._readClusterMap(userId)[clusterId];
    return record ? validateClusterRecord(record) : null;
  }

  async findClusterByIdempotencyKey(userId, idempotencyKey) {
    this._assertNonEmptyString(userId, "userId");
    this._assertNonEmptyString(idempotencyKey, "idempotencyKey");
    const record = Object.values(this._readClusterMap(userId))
      .find((cluster) => cluster.idempotency_key === idempotencyKey);
    return record ? validateClusterRecord(record) : null;
  }

  async saveCluster(userId, clusterRecord, options) {
    this._assertNonEmptyString(userId, "userId");
    const incoming = validateClusterRecord(clusterRecord);
    if (incoming.user_id !== userId) {
      throw new ClusterStorageError("CLUSTER_USER_MISMATCH", "Cluster user_id does not match storage scope");
    }
    return this._withWriteLock(userId, options, async () => {
      const filePath = this._path(userId, "clusters");
      const clusters = this._readClusterMap(userId);
      const sameId = clusters[incoming.id];
      const sameKey = Object.values(clusters)
        .find((cluster) => cluster.idempotency_key === incoming.idempotency_key);
      if (sameId && sameId.idempotency_key !== incoming.idempotency_key) {
        throw new ClusterStorageError("CLUSTER_ID_CONFLICT", "Cluster ID already uses another idempotency key");
      }
      if (sameKey) {
        if (sameKey.record_fingerprint !== incoming.record_fingerprint) {
          throw new ClusterStorageError("CLUSTER_IDEMPOTENCY_CONFLICT", "Idempotency key has different semantic content");
        }
        return { cluster: validateClusterRecord(sameKey), created: false, idempotentReplay: true };
      }
      clusters[incoming.id] = incoming;
      await this._writeJson(filePath, clusters);
      return { cluster: validateClusterRecord(incoming), created: true, idempotentReplay: false };
    });
  }

  async deleteCluster(userId, clusterId, options) {
    this._assertNonEmptyString(userId, "userId");
    this._assertNonEmptyString(clusterId, "clusterId");
    return this._withWriteLock(userId, options, async () => {
      const filePath = this._path(userId, "clusters");
      const clusters = this._readClusterMap(userId);
      if (!Object.hasOwn(clusters, clusterId)) return { deleted: false, clusterId };
      delete clusters[clusterId];
      await this._writeJson(filePath, clusters);
      return { deleted: true, clusterId };
    });
  }
}

module.exports = JsonMemoryStorage;
module.exports.ClusterStorageError = ClusterStorageError;
