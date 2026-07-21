const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;

function validIdentity(value) {
  return typeof value === "string" && value.length > 0;
}

function key(sessionId, userId) {
  if (!validIdentity(sessionId) || !validIdentity(userId)) {
    throw new TypeError("session identity is required");
  }
  return `${sessionId.length}:${sessionId}${userId.length}:${userId}`;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, clone(child)]));
  }
  return value;
}

function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  }
  return value;
}

function sanitizeItem(item) {
  if (!item || typeof item !== "object" || !["core", "warm"].includes(item.tier) ||
      item.injected !== true || !Number.isInteger(item.rank) || item.rank < 1 ||
      typeof item.excerpt !== "string" || item.excerpt.length === 0 || item.excerpt.length > 280) {
    throw new TypeError("invalid injected provenance item");
  }
  const output = {
    tier: item.tier,
    rank: item.rank,
    score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null,
    matchedBy: typeof item.matchedBy === "string" ? item.matchedBy.slice(0, 120) : "RANKED_RECALL",
    timestamp: typeof item.timestamp === "string" ? item.timestamp : null,
    excerpt: item.excerpt,
    injected: true
  };
  if (item.tier === "core") {
    output.sourceCount = Number.isInteger(item.sourceCount) && item.sourceCount >= 0
      ? item.sourceCount : 0;
  }
  return output;
}

export function createKebloRecallProvenanceStore({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS || typeof now !== "function") {
    throw new TypeError("invalid provenance store options");
  }
  const traces = new Map();

  return Object.freeze({
    clear(sessionId, userId) {
      traces.delete(key(sessionId, userId));
    },
    replace(sessionId, userId, { metrics, items } = {}) {
      if (!metrics || typeof metrics !== "object" || !Array.isArray(items) || items.length === 0) {
        throw new TypeError("non-empty recall provenance is required");
      }
      const createdAtMs = now();
      const injectedItems = items.map(sanitizeItem);
      const trace = freeze({
        durationMs: typeof metrics.durationMs === "number" && Number.isFinite(metrics.durationMs)
          ? Math.max(0, metrics.durationMs) : 0,
        selectedCount: injectedItems.length,
        truncated: metrics.truncated === true,
        items: injectedItems
      });
      traces.set(key(sessionId, userId), { expiresAtMs: createdAtMs + ttlMs, trace });
      return this.read(sessionId, userId);
    },
    read(sessionId, userId) {
      const traceKey = key(sessionId, userId);
      const entry = traces.get(traceKey);
      if (!entry) return Object.freeze({ lastRecall: null, expiresAt: null });
      if (now() >= entry.expiresAtMs) {
        traces.delete(traceKey);
        return Object.freeze({ lastRecall: null, expiresAt: null });
      }
      return freeze({ lastRecall: clone(entry.trace),
        expiresAt: new Date(entry.expiresAtMs).toISOString() });
    }
  });
}
