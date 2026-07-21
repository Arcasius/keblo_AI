"use strict";

const { buildConsolidationPlanScalable } = require("../../core/consolidation/ConsolidationPlan");

function parseArguments(argv) {
  const values = {
    count: 40000,
    batchSize: 500,
    runs: 3,
    maxRssMiB: 128,
    maxElapsedMs: 9500,
    seed: 1
  };
  const names = new Map([
    ["--count", "count"],
    ["--batch-size", "batchSize"],
    ["--runs", "runs"],
    ["--max-rss-mib", "maxRssMiB"],
    ["--max-elapsed-ms", "maxElapsedMs"],
    ["--seed", "seed"]
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    const raw = argv[index + 1];
    if (!key || raw === undefined) throw new TypeError("Unsupported or incomplete benchmark argument");
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError("Benchmark arguments must be positive integers");
    values[key] = number;
  }
  return values;
}

function buildDataset(count, seed) {
  return Array.from({ length: count }, (_, index) => ({
    id: `scale-${String(index).padStart(5, "0")}`,
    type: "episodic",
    content: {
      text: `synthetic deterministic memory ${index + ((seed - 1) * count)}`,
      entities: [`synthetic-${(index + seed) % 17}`],
      contextTags: ["synthetic"]
    },
    timestamp: 1900000000000 + index,
    memoryKind: "raw",
    storageTier: "warm",
    processingState: "raw",
    tags: ["keep"],
    meta: { synthetic: true, bucket: (index + seed - 1) % 31 },
    unknown: { preserve: true }
  }));
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const generationStarted = process.hrtime.bigint();
  const memories = buildDataset(options.count, options.seed);
  const generationElapsedMs = Number(process.hrtime.bigint() - generationStarted) / 1e6;
  const warmupCount = Math.min(1000, options.count);
  await buildConsolidationPlanScalable(memories.slice(0, warmupCount), {
    batchSize: Math.min(options.batchSize, warmupCount),
    budget: {
      maxElapsedMs: options.maxElapsedMs,
      maxRssDeltaBytes: options.maxRssMiB * 1024 * 1024
    }
  });

  const samples = [];
  for (let run = 1; run <= options.runs; run++) {
    if (typeof global.gc === "function") global.gc();
    const result = await buildConsolidationPlanScalable(memories, {
      batchSize: options.batchSize,
      budget: {
        maxElapsedMs: options.maxElapsedMs,
        maxRssDeltaBytes: options.maxRssMiB * 1024 * 1024
      }
    });
    samples.push({
      run,
      elapsedMs: result.telemetry.elapsedMs,
      rssDeltaBytes: result.telemetry.rssDeltaBytes,
      decisionCount: result.plan.decisions.length,
      candidateCount: result.plan.candidateIds.length,
      planId: result.plan.planId,
      budgetExceeded: result.telemetry.budgetExceeded
    });
  }
  const medianElapsedMs = median(samples.map(sample => sample.elapsedMs));
  const medianRssDeltaBytes = median(samples.map(sample => sample.rssDeltaBytes));
  const maxRssDeltaBytes = Math.max(...samples.map(sample => sample.rssDeltaBytes));
  const allRecordsAccounted = samples.every(sample => sample.decisionCount === options.count);
  const budgetPassed = allRecordsAccounted && medianElapsedMs <= options.maxElapsedMs &&
    maxRssDeltaBytes <= options.maxRssMiB * 1024 * 1024;
  const report = {
    schemaVersion: 1,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    count: options.count,
    batchSize: options.batchSize,
    runs: options.runs,
    seed: options.seed,
    generationElapsedMs,
    medianElapsedMs,
    medianRssDeltaBytes,
    maxRssDeltaBytes,
    budget: {
      maxElapsedMs: options.maxElapsedMs,
      maxRssDeltaBytes: options.maxRssMiB * 1024 * 1024
    },
    budgetPassed,
    samples
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!budgetPassed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error?.code || "BENCHMARK_FAILED"}\n`);
  process.exitCode = 1;
});
