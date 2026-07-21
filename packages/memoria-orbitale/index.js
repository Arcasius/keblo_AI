"use strict";

const PUBLIC_EXPORTS = Object.freeze({
  RECALL_ROUTER_SCHEMA_VERSION: ["./core/recall/RecallRouter.js", "RECALL_ROUTER_SCHEMA_VERSION"],
  RECALL_MODES: ["./core/recall/RecallRouter.js", "RECALL_MODES"],
  RECALL_TIERS: ["./core/recall/RecallRouter.js", "RECALL_TIERS"],
  RECALL_REASON_CODES: ["./core/recall/RecallRouter.js", "RECALL_REASON_CODES"],
  DEFAULT_RECALL_POLICY: ["./core/recall/RecallRouter.js", "DEFAULT_RECALL_POLICY"],
  RecallRouterError: ["./core/recall/RecallRouter.js", "RecallRouterError"],
  createRecallRouter: ["./core/recall/RecallRouter.js", "createRecallRouter"],
  RECALL_COMMANDS: ["./core/recall/RecallRequestBuilder.js", "RECALL_COMMANDS"],
  RecallRequestBuilderError: ["./core/recall/RecallRequestBuilder.js", "RecallRequestBuilderError"],
  buildRecallRequest: ["./core/recall/RecallRequestBuilder.js", "buildRecallRequest"],
  LEGACY_RECALL_ADAPTER_SCHEMA_VERSION: ["./core/recall/LegacyRecallAdapter.js", "LEGACY_RECALL_ADAPTER_SCHEMA_VERSION"],
  LegacyRecallAdapterError: ["./core/recall/LegacyRecallAdapter.js", "LegacyRecallAdapterError"],
  createLegacyRecallAdapter: ["./core/recall/LegacyRecallAdapter.js", "createLegacyRecallAdapter"],
  rankReadOnly: ["./core/recall/OrbitalReadOnlyRanker.js", "rankReadOnly"],
  detectMemoryContract: ["./core/MemoryContractNormalizer.js", "detectMemoryContract"],
  normalizeMemory: ["./core/MemoryContractNormalizer.js", "normalizeMemory"],
  projectMemoryForCandidateSelection: ["./core/MemoryContractNormalizer.js", "projectMemoryForCandidateSelection"],
  STORAGE_CAPABILITIES: ["./core/StorageCapabilityContract.js", "STORAGE_CAPABILITIES"],
  CAPABILITY_STATUS: ["./core/StorageCapabilityContract.js", "CAPABILITY_STATUS"],
  StorageCapabilityError: ["./core/StorageCapabilityContract.js", "StorageCapabilityError"],
  inspectStorageCapabilities: ["./core/StorageCapabilityContract.js", "inspectStorageCapabilities"],
  hasStorageCapability: ["./core/StorageCapabilityContract.js", "hasStorageCapability"],
  assertStorageCapabilities: ["./core/StorageCapabilityContract.js", "assertStorageCapabilities"],
  getMissingStorageCapabilities: ["./core/StorageCapabilityContract.js", "getMissingStorageCapabilities"],
  validateCapabilityDeclaration: ["./core/StorageCapabilityContract.js", "validateCapabilityDeclaration"]
});

for (const [publicName, [modulePath, moduleName]] of Object.entries(PUBLIC_EXPORTS)) {
  Object.defineProperty(module.exports, publicName, {
    enumerable: true,
    configurable: false,
    get() {
      return require(modulePath)[moduleName];
    }
  });
}

Object.preventExtensions(module.exports);
