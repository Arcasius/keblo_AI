"use strict";

const {
  HippocampusActivationControllerError
} = require("./HippocampusActivationController");

const DEFAULT_MAX_BODY_BYTES = 100 * 1024;
const ROUTES = deepFreeze({
  "/api/hippocampus/status": "GET",
  "/api/hippocampus/mode": "POST",
  "/api/hippocampus/run": "POST",
  "/api/hippocampus/stop": "POST"
});
const ROUTER_OPTION_KEYS = Object.freeze([
  "authorizeRequest", "controller", "maxBodyBytes"
]);
const REQUEST_KEYS = Object.freeze(["body", "headers", "method", "path"]);

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

function isPlainDataObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value");
  });
}

function hasOnlyKeys(value, allowed) {
  return isPlainDataObject(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

function response(statusCode, body, extraHeaders = {}) {
  return deepFreeze({
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    },
    body: deepFreeze(body)
  });
}

function failure(statusCode, reasonCode, extraHeaders) {
  return response(statusCode, {
    ok: false,
    reasonCode
  }, extraHeaders);
}

function normalizedHeaders(headers) {
  if (!isPlainDataObject(headers)) return null;
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowered = key.toLowerCase();
    if (Object.hasOwn(normalized, lowered) ||
        (typeof value !== "string" && !Array.isArray(value))) {
      return null;
    }
    normalized[lowered] = value;
  }
  return normalized;
}

function parseJsonBody(request, maxBodyBytes) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" ||
      contentType.split(";", 1)[0].trim().toLowerCase() !==
        "application/json") {
    return { error: failure(415, "INVALID_REQUEST") };
  }
  const body = request.body === undefined ? "" : request.body;
  if (typeof body !== "string" && !Buffer.isBuffer(body)) {
    return { error: failure(400, "INVALID_REQUEST") };
  }
  if (Buffer.byteLength(body) > maxBodyBytes) {
    return { error: failure(413, "INVALID_REQUEST") };
  }
  try {
    const parsed = JSON.parse(body.toString());
    if (!isPlainDataObject(parsed)) {
      return { error: failure(400, "INVALID_REQUEST") };
    }
    return { value: parsed };
  } catch {
    return { error: failure(400, "INVALID_REQUEST") };
  }
}

function statusCodeFor(reasonCode) {
  if (["MODE_CHANGE_REJECTED_RUN_ACTIVE", "RUN_ALREADY_ACTIVE",
    "ACTIVATION_OFF", "NO_ACTIVE_RUN", "LIVE_NOT_AUTHORIZED"].includes(
    reasonCode
  )) return 409;
  if (["PREFLIGHT_NOT_READY", "RUNNER_UNAVAILABLE"].includes(reasonCode)) {
    return 503;
  }
  if (reasonCode === "RUN_FAILED") return 500;
  return 200;
}

function createHippocampusControlPlaneHttpRouter(options) {
  if (!hasOnlyKeys(options, ROUTER_OPTION_KEYS) ||
      !options.controller ||
      typeof options.controller.getStatus !== "function" ||
      typeof options.controller.setMode !== "function" ||
      typeof options.controller.runOnce !== "function" ||
      typeof options.controller.stop !== "function" ||
      typeof options.authorizeRequest !== "function" ||
      (options.maxBodyBytes !== undefined &&
        (!Number.isSafeInteger(options.maxBodyBytes) ||
          options.maxBodyBytes <= 0))) {
    throw new TypeError("Invalid hippocampus control plane router configuration");
  }
  const maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;

  async function handle(input) {
    if (!hasOnlyKeys(input, REQUEST_KEYS) ||
        typeof input.method !== "string" ||
        typeof input.path !== "string") {
      return failure(400, "INVALID_REQUEST");
    }
    const headers = normalizedHeaders(input.headers || {});
    if (!headers) return failure(400, "INVALID_REQUEST");
    const request = { ...input, headers, method: input.method.toUpperCase() };
    const expectedMethod = ROUTES[request.path];
    if (!expectedMethod) return failure(404, "INVALID_REQUEST");
    if (request.method !== expectedMethod) {
      return failure(405, "INVALID_REQUEST", { allow: expectedMethod });
    }
    let authorized = false;
    try {
      authorized = await options.authorizeRequest({
        headers,
        method: request.method,
        path: request.path
      });
    } catch {
      authorized = false;
    }
    if (authorized !== true) return failure(403, "INVALID_REQUEST");

    let body = {};
    if (request.method === "POST") {
      const parsed = parseJsonBody(request, maxBodyBytes);
      if (parsed.error) return parsed.error;
      body = parsed.value;
    } else if (request.body !== undefined &&
        request.body !== null &&
        request.body !== "") {
      return failure(400, "INVALID_REQUEST");
    }

    try {
      if (request.path === "/api/hippocampus/status") {
        return response(200, {
          ok: true,
          reasonCode: "STATUS_AVAILABLE",
          status: options.controller.getStatus()
        });
      }
      const result = request.path === "/api/hippocampus/mode"
        ? options.controller.setMode(body)
        : request.path === "/api/hippocampus/run"
          ? await options.controller.runOnce(body)
          : await options.controller.stop(body);
      return response(statusCodeFor(result.reasonCode), {
        ok: result.accepted,
        reasonCode: result.reasonCode,
        status: result.status
      });
    } catch (error) {
      const invalid = error instanceof HippocampusActivationControllerError;
      return failure(invalid ? 400 : 500, "INVALID_REQUEST");
    }
  }

  return deepFreeze({ handle });
}

module.exports = {
  DEFAULT_MAX_BODY_BYTES,
  ROUTES,
  createHippocampusControlPlaneHttpRouter
};
