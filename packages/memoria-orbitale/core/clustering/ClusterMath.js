"use strict";

const { createHash } = require("node:crypto");

function validateEmbedding(embedding) {
  if (!Array.isArray(embedding)) throw new TypeError("Embedding must be an array");
  if (embedding.length === 0) throw new TypeError("Embedding must not be empty");
  let normSquared = 0;
  for (const value of embedding) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("Embedding values must be finite numbers");
    }
    normSquared += value * value;
  }
  if (!Number.isFinite(normSquared) || normSquared === 0) {
    throw new TypeError("Embedding must have a finite non-zero norm");
  }
  return true;
}

function assertSameDimension(embeddings) {
  const dimension = embeddings[0].length;
  for (const embedding of embeddings) {
    if (embedding.length !== dimension) throw new TypeError("Embedding dimensions must match");
  }
  return dimension;
}

function cosineSimilarity(a, b) {
  validateEmbedding(a);
  validateEmbedding(b);
  if (a.length !== b.length) throw new TypeError("Embedding dimensions must match");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(similarity)) throw new TypeError("Cosine similarity must be finite");
  return Math.max(-1, Math.min(1, similarity));
}

function validateEmbeddingCollection(embeddings) {
  if (!Array.isArray(embeddings) || embeddings.length === 0) {
    throw new TypeError("At least one embedding is required");
  }
  for (const embedding of embeddings) validateEmbedding(embedding);
  return assertSameDimension(embeddings);
}

function calculateCentroid(embeddings) {
  const dimension = validateEmbeddingCollection(embeddings);
  const centroid = new Array(dimension).fill(0);
  for (const embedding of embeddings) {
    for (let index = 0; index < dimension; index += 1) centroid[index] += embedding[index];
  }
  for (let index = 0; index < dimension; index += 1) centroid[index] /= embeddings.length;
  return centroid;
}

function calculateInternalDensity(embeddings, centroid) {
  validateEmbeddingCollection(embeddings);
  validateEmbedding(centroid);
  if (embeddings[0].length !== centroid.length) throw new TypeError("Embedding dimensions must match");
  const similarities = embeddings.map((embedding) => cosineSimilarity(embedding, centroid));
  return {
    averageSimilarity: similarities.reduce((sum, value) => sum + value, 0) / similarities.length,
    minimumSimilarity: Math.min(...similarities),
    maximumSimilarity: Math.max(...similarities),
    memberCount: embeddings.length
  };
}

function calculateClusterIsolation(centroid, otherCentroids) {
  validateEmbedding(centroid);
  if (!Array.isArray(otherCentroids)) throw new TypeError("Other centroids must be an array");
  if (otherCentroids.length === 0) {
    return { averageSimilarity: null, externalIsolation: 1, comparedClusterCount: 0 };
  }
  for (const other of otherCentroids) validateEmbedding(other);
  assertSameDimension([centroid, ...otherCentroids]);
  const similarities = otherCentroids.map((other) => cosineSimilarity(centroid, other));
  const averageSimilarity = similarities.reduce((sum, value) => sum + value, 0) /
    similarities.length;
  return {
    averageSimilarity,
    externalIsolation: 1 - averageSimilarity,
    comparedClusterCount: otherCentroids.length
  };
}

function fingerprintEmbedding(embedding) {
  validateEmbedding(embedding);
  return createHash("sha256").update(JSON.stringify(embedding), "utf8").digest("hex");
}

module.exports = {
  validateEmbedding,
  cosineSimilarity,
  calculateCentroid,
  calculateInternalDensity,
  calculateClusterIsolation,
  fingerprintEmbedding
};
