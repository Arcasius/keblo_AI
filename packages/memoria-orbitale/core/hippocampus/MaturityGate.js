"use strict";

const MATURITY_GATE_SCHEMA_VERSION = 1;
const MATURITY_REASON_CODES = Object.freeze({
  EXPLICITLY_APPROVED: "EXPLICITLY_APPROVED",
  EXPLICIT_APPROVAL_REQUIRED: "EXPLICIT_APPROVAL_REQUIRED",
  INVALID_CLUSTER: "INVALID_CLUSTER",
  CLUSTER_SIZE_INCOHERENT: "CLUSTER_SIZE_INCOHERENT",
  INVALID_EMBEDDING_EVIDENCE: "INVALID_EMBEDDING_EVIDENCE",
  EVALUATOR_ACCEPTED: "EVALUATOR_ACCEPTED",
  EVALUATOR_REJECTED: "EVALUATOR_REJECTED"
});

class MaturityGateError extends Error {
  constructor(code, message) { super(message); this.name = "MaturityGateError"; this.code = code; }
}

function isPlain(value) { return value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function freeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child); return value; }

function createMaturityGate(options = {}) {
  if (!isPlain(options) || Object.keys(options).some(key => !["requireExplicitApproval", "evaluator"].includes(key))) throw new MaturityGateError("INVALID_OPTIONS", "Maturity options are invalid");
  const requireExplicitApproval = options.requireExplicitApproval === undefined ? true : options.requireExplicitApproval;
  if (typeof requireExplicitApproval !== "boolean" || options.evaluator !== undefined && typeof options.evaluator !== "function" || !requireExplicitApproval && !options.evaluator) throw new MaturityGateError("INVALID_OPTIONS", "Automatic maturity requires an explicit evaluator");

  return Object.freeze({
    async evaluate(clusterCandidate, context = {}) {
      if (!isPlain(context) || Object.keys(context).some(key => key !== "approvedClusterIds") || context.approvedClusterIds !== undefined && (!Array.isArray(context.approvedClusterIds) || context.approvedClusterIds.some(id => typeof id !== "string"))) throw new MaturityGateError("INVALID_CONTEXT", "Maturity context is invalid");
      const clusterId = typeof clusterCandidate?.clusterId === "string" ? clusterCandidate.clusterId : null;
      const members = clusterCandidate?.memberIds;
      const density = clusterCandidate?.density;
      const policy = clusterCandidate?.policy;
      const structural = isPlain(clusterCandidate) && clusterCandidate.schemaVersion === 1 && clusterCandidate.persisted === false && clusterId && Array.isArray(members) && members.length > 0 && new Set(members).size === members.length;
      const sizeCoherent = structural && isPlain(density) && density.memberCount === members.length && isPlain(policy) && Number.isInteger(policy.minClusterSize) && members.length >= policy.minClusterSize && (policy.maxClusterSize === null || Number.isInteger(policy.maxClusterSize) && members.length <= policy.maxClusterSize);
      const embeddingValid = structural && Number.isInteger(clusterCandidate.embeddingDimension) && clusterCandidate.embeddingDimension > 0 && Array.isArray(clusterCandidate.centroid) && clusterCandidate.centroid.length === clusterCandidate.embeddingDimension && clusterCandidate.centroid.every(Number.isFinite) && [density?.averageSimilarity, density?.minimumSimilarity, density?.maximumSimilarity].every(value => typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1);
      const approved = new Set(context.approvedClusterIds || []).has(clusterId);
      const reasonCodes = [];
      if (!structural) reasonCodes.push(MATURITY_REASON_CODES.INVALID_CLUSTER);
      else if (!sizeCoherent) reasonCodes.push(MATURITY_REASON_CODES.CLUSTER_SIZE_INCOHERENT);
      else if (!embeddingValid) reasonCodes.push(MATURITY_REASON_CODES.INVALID_EMBEDDING_EVIDENCE);
      if (structural && sizeCoherent && embeddingValid) reasonCodes.push(approved ? MATURITY_REASON_CODES.EXPLICITLY_APPROVED : MATURITY_REASON_CODES.EXPLICIT_APPROVAL_REQUIRED);
      let evaluatorEvidence = null;
      let evaluatorAccepted = true;
      if (options.evaluator) {
        const evaluated = await options.evaluator(clusterCandidate, Object.freeze({ approved }));
        if (!isPlain(evaluated) || typeof evaluated.mature !== "boolean" || !isPlain(evaluated.evidence)) throw new MaturityGateError("INVALID_EVALUATOR_RESULT", "Maturity evaluator returned invalid evidence");
        evaluatorAccepted = evaluated.mature;
        evaluatorEvidence = { ...evaluated.evidence };
        reasonCodes.push(evaluated.mature ? MATURITY_REASON_CODES.EVALUATOR_ACCEPTED : MATURITY_REASON_CODES.EVALUATOR_REJECTED);
      }
      const mature = Boolean(structural && sizeCoherent && embeddingValid && evaluatorAccepted && (!requireExplicitApproval || approved));
      return freeze({
        mature,
        reasonCodes,
        clusterId,
        evidence: {
          memberCount: Array.isArray(members) ? members.length : null,
          minimumClusterSize: Number.isInteger(policy?.minClusterSize) ? policy.minClusterSize : null,
          embeddingDimension: Number.isInteger(clusterCandidate?.embeddingDimension) ? clusterCandidate.embeddingDimension : null,
          explicitlyApproved: approved,
          evaluator: evaluatorEvidence
        }
      });
    }
  });
}

module.exports = { MATURITY_GATE_SCHEMA_VERSION, MATURITY_REASON_CODES, MaturityGateError, createMaturityGate };
