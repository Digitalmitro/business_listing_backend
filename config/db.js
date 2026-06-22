"use strict";

const mongoose = require("mongoose");
const logger = require("../utils/logger");

let lifecycleListenersInstalled = false;
let driverListenersInstalled = false;

function installLifecycleListeners() {
  if (lifecycleListenersInstalled) return;
  lifecycleListenersInstalled = true;

  mongoose.connection.on("connected", () => {
    logger.info("database.connected", "MongoDB connection established", {
      database: mongoose.connection.name,
      host: mongoose.connection.host,
    });
  });
  mongoose.connection.on("reconnected", () => {
    logger.warn("database.reconnected", "MongoDB connection was re-established");
  });
  mongoose.connection.on("disconnected", () => {
    logger.warn("database.disconnected", "MongoDB connection was lost");
  });
  mongoose.connection.on("error", (error) => {
    logger.error("database.connection_error", "MongoDB connection emitted an error", { error });
  });
}

function installDriverListeners(client) {
  if (driverListenersInstalled) return;
  driverListenersInstalled = true;
  const slowQueryMs = Number(process.env.MONGO_SLOW_QUERY_MS || 500);
  const logAllCommands = process.env.MONGO_LOG_ALL_COMMANDS === "true";

  client.on("commandSucceeded", (event) => {
    if (!logAllCommands && event.duration < slowQueryMs) return;
    const level = event.duration >= slowQueryMs ? "warn" : "debug";
    logger[level](
      event.duration >= slowQueryMs ? "database.slow_command" : "database.command_completed",
      event.duration >= slowQueryMs
        ? "MongoDB command exceeded the duration threshold"
        : "MongoDB command completed",
      {
        command: event.commandName,
        database: event.databaseName,
        durationMs: event.duration,
        mongoRequestId: event.requestId,
        slowQueryMs,
      }
    );
  });
  client.on("commandFailed", (event) => {
    logger.error("database.command_failed", "MongoDB command failed", {
      command: event.commandName,
      durationMs: event.duration,
      mongoRequestId: event.requestId,
      error: event.failure,
    });
  });
  client.on("connectionPoolCleared", (event) => {
    logger.warn("database.pool_cleared", "MongoDB driver cleared a connection pool", {
      address: event.address,
      serviceId: event.serviceId,
    });
  });
  client.on("connectionCheckOutFailed", (event) => {
    logger.warn("database.checkout_failed", "MongoDB connection checkout failed", {
      address: event.address,
      reason: event.reason,
      durationMs: event.durationMS,
      error: event.error,
    });
  });
}

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is required");

  installLifecycleListeners();
  const startedAt = process.hrtime.bigint();
  logger.info("database.connecting", "Connecting to MongoDB");

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 10_000),
      monitorCommands: process.env.MONGO_COMMAND_MONITORING !== "false",
    });
    installDriverListeners(mongoose.connection.getClient());
    logger.info("database.connection_ready", "MongoDB is ready for application traffic", {
      durationMs: Number(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2),
      readyState: mongoose.connection.readyState,
    });
    return mongoose.connection;
  } catch (error) {
    logger.error("database.connection_failed", "Initial MongoDB connection failed", {
      durationMs: Number(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2),
      error,
    });
    throw error;
  }
}

async function disconnectDB() {
  if (mongoose.connection.readyState === 0) return;
  const startedAt = process.hrtime.bigint();
  await mongoose.connection.close(false);
  logger.info("database.closed", "MongoDB connection closed", {
    durationMs: Number(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2),
  });
}

module.exports = connectDB;
module.exports.disconnectDB = disconnectDB;
