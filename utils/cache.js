// backend/utils/cache.js
"use strict";

const { redisConnection } = require("./queue");
const logger = require("./logger");

const inMemoryCache = new Map();

/**
 * Get value from Redis or fallback in-memory cache.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function getCache(key) {
  try {
    if (redisConnection && redisConnection.status === "ready") {
      const data = await redisConnection.get(key);
      if (data) return JSON.parse(data);
      return null;
    }
  } catch (err) {
    logger.warn("Redis getCache error, checking in-memory cache", { key, error: err.message });
  }

  const memItem = inMemoryCache.get(key);
  if (memItem) {
    if (Date.now() < memItem.expiry) {
      return memItem.value;
    }
    inMemoryCache.delete(key);
  }
  return null;
}

/**
 * Set value in Redis or fallback in-memory cache with TTL (in seconds).
 * @param {string} key
 * @param {any} value
 * @param {number} ttlSeconds
 */
async function setCache(key, value, ttlSeconds = 60) {
  try {
    const stringData = JSON.stringify(value);
    if (redisConnection && redisConnection.status === "ready") {
      await redisConnection.set(key, stringData, "EX", ttlSeconds);
      return true;
    }
  } catch (err) {
    logger.warn("Redis setCache error, using in-memory cache", { key, error: err.message });
  }

  inMemoryCache.set(key, {
    value,
    expiry: Date.now() + ttlSeconds * 1000,
  });
  return true;
}

/**
 * Invalidate key or keys matching pattern.
 */
async function delCache(key) {
  try {
    if (redisConnection && redisConnection.status === "ready") {
      await redisConnection.del(key);
    }
  } catch (err) {
    logger.warn("Redis delCache error", { key, error: err.message });
  }
  inMemoryCache.delete(key);
}

module.exports = {
  getCache,
  setCache,
  delCache,
};
