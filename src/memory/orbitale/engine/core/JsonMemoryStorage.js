const fs = require("fs");
const path = require("path");

class JsonMemoryStorage {
  constructor(dataDir = "./keblo_data") {
    this.dataDir = dataDir;
    this.defaultUserId = "keblo_user";
    fs.mkdirSync(this.dataDir, { recursive: true });
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

  _writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
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

  async saveMemory(userIdOrMemory, maybeMemory) {
    const memory = maybeMemory || userIdOrMemory;
    const userId = maybeMemory ? userIdOrMemory : this._userIdFromMemory(memory);
    const filePath = this._path(userId, "memories");
    const memories = this._readJson(filePath);
    memories[memory.id] = memory;
    this._writeJson(filePath, memories);
    return memory;
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

  async saveMemories(userId, memories) {
    this._writeJson(this._path(userId, "memories"), this._toObjectById(memories));
  }

  async deleteMemory(userIdOrId, maybeId) {
    const userId = maybeId ? userIdOrId : this.defaultUserId;
    const id = maybeId || userIdOrId;
    const filePath = this._path(userId, "memories");
    const memories = this._readJson(filePath);
    delete memories[id];
    this._writeJson(filePath, memories);
  }

  async saveLink(userIdOrLink, maybeLink) {
    const link = maybeLink || userIdOrLink;
    const userId = maybeLink ? userIdOrLink : this._userIdFromLink(link);
    const filePath = this._path(userId, "links");
    const links = this._readJson(filePath);
    links[link.id] = link;
    this._writeJson(filePath, links);
    return link;
  }

  async loadLinks(userId = this.defaultUserId) {
    const links = this._readJson(this._path(userId, "links"));
    return Object.values(links);
  }

  async saveLinks(userId, links) {
    this._writeJson(this._path(userId, "links"), this._toObjectById(links));
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

  async loadClusters() {
    return [];
  }
}

module.exports = JsonMemoryStorage;
