"use strict";

require("dotenv").config();

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const logger = require("./utils/logger");

logger.installConsoleBridge();

const connectDB = require("./config/db");
const { disconnectDB } = require("./config/db");
const { createRequestLogger } = require("./middlewares/requestLogger");
const { errorHandler, notFoundHandler } = require("./middlewares/errorHandler");
const { installProcessHandlers } = require("./utils/processHandlers");
const { ResourceMonitor } = require("./utils/resourceMonitor");
const { closeQueueConnections, redisConnection } = require("./utils/queue");

const authRoutes = require("./routes/authRoutes.js");
const categoryRoutes = require("./routes/categoryRoutes");
const bannerRoutes = require("./routes/bannerRoutes");
const topBannerCategoryRoutes = require("./routes/topBannerCategoryRoutes");
const subCategoryRoutes = require("./routes/subCategoryRoutes.js");
const businessRoutes = require("./routes/businessRoutes.js");
const notificationRoutes = require("./routes/notificationRoutes.js");
const topCountryRoutes = require("./routes/topCountryRoutes.js");
const adminRoutes = require("./routes/adminRoutes.js");
const planRoutes = require("./routes/planRoutes.js");
const reviewRoutes = require("./routes/reviewRoutes.js");
const appointmentRoutes = require("./routes/appointmentRoutes.js");
const enquiryRoutes = require("./routes/enquiryRoutes.js");
const questionRoutes = require("./routes/questionRoutes.js");
const topServicesRoutes = require("./routes/topServicesRoutes");
const freeListingRoutes = require("./routes/freeListingRoutes");
const verticalRoutes = require("./routes/verticalRoutes");
const claimRoutes = require("./routes/claimRoutes");
const emailCampaignRoutes = require("./routes/emailCampaignRoutes");
const pageSeoRoutes = require("./routes/pageSeo");
const pricingRoutes = require("./routes/pricingRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const homeRoutes = require("./routes/homeRoutes");
const blogRoutes = require("./routes/blogRoutes");
const popularSearchRoutes = require("./routes/popularSearchRoutes");

const PORT = Number(process.env.PORT || 5000);
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10_000);
const sockets = new Set();
let server;
let resourceMonitor;
let shutdownPromise;
let workerRuntime;

function shouldStartInlineWorkers() {
  if (process.env.INLINE_WORKERS === "true") return true;
  if (process.env.INLINE_WORKERS === "false") return false;

  const runningUnderPm2 = process.env.pm_id !== undefined || process.env.NODE_APP_INSTANCE !== undefined;
  return !runningUnderPm2;
}

function configureTrustProxy(app) {
  const value = process.env.TRUST_PROXY;
  if (value === undefined || value === "false") return;
  if (value === "true") app.set("trust proxy", true);
  else if (/^\d+$/.test(value)) app.set("trust proxy", Number(value));
  else app.set("trust proxy", value);
}

function createApp() {
  const app = express();
  configureTrustProxy(app);
  app.disable("x-powered-by");
  app.use(createRequestLogger());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    express.json({
      limit: process.env.JSON_BODY_LIMIT || "2mb",
      verify: (req, _res, buffer) => {
        if (req.originalUrl.startsWith("/api/subscription/razorpay-webhook")) {
          req.rawBody = buffer.toString();
        }
      },
    })
  );
  app.use(cors());

  const uploadDirectory = path.join(__dirname, "public/uploads");
  fs.mkdirSync(uploadDirectory, { recursive: true });
  app.use("/uploads", express.static(uploadDirectory));

  app.get("/", (_req, res) => {
    res.status(200).json({ message: "Welcome to the UrbanCitations server" });
  });
  app.get("/health/live", (_req, res) => {
    res.status(200).json({
      status: "alive",
      uptimeSeconds: Number(process.uptime().toFixed(1)),
      timestamp: new Date().toISOString(),
    });
  });
  app.get("/health/ready", (_req, res) => {
    const dependencies = {
      mongodb: mongoose.connection.readyState === 1 ? "ready" : "unavailable",
      redis: redisConnection.status === "ready" ? "ready" : redisConnection.status,
    };
    const ready = dependencies.mongodb === "ready" && dependencies.redis === "ready";
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      dependencies,
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/category", categoryRoutes);
  app.use("/api/banner", bannerRoutes);
  app.use("/api", topBannerCategoryRoutes);
  app.use("/api/subCategory", subCategoryRoutes);
  app.use("/api/business", businessRoutes);
  app.use("/api/notification", notificationRoutes);
  app.use("/notification", notificationRoutes);
  app.use("/message", notificationRoutes);
  app.use("/api", topCountryRoutes);
  app.use("/admin", adminRoutes);
  app.use("/api/plan", planRoutes);
  app.use("/api/review", reviewRoutes);
  app.use("/api", appointmentRoutes);
  app.use("/api", claimRoutes);
  app.use("/api", emailCampaignRoutes);
  app.use("/api", enquiryRoutes);
  app.use("/api", questionRoutes);
  app.use("/api", topServicesRoutes);
  app.use("/api", freeListingRoutes);
  app.use("/api/seo", pageSeoRoutes);
  app.use("/api/pricing", pricingRoutes);
  app.use("/api/verticals", verticalRoutes);
  app.use("/api/subscription", subscriptionRoutes);
  app.use("/api/home", homeRoutes);
  app.use("/api/blog", blogRoutes);
  app.use("/api/popular-search", popularSearchRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = createApp();

function listen(httpServer) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(PORT, "0.0.0.0");
  });
}

async function startServer() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  logger.info("application.starting", "Application startup initiated", {
    port: PORT,
    nodeVersion: process.version,
    platform: process.platform,
    pm2RestartCount: process.env.restart_time,
    deploymentRevision: process.env.DEPLOYMENT_REVISION || process.env.GIT_COMMIT,
  });

  await connectDB();
  if (shouldStartInlineWorkers()) {
    const { startWorkers } = require("./startWorker");
    await startWorkers();
    workerRuntime = { shutdown: require("./startWorker").shutdown };
    logger.info("workers.inline_started", "Inline queue workers started with the API process");
  }
  server = http.createServer(app);
  server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 120_000);
  server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 65_000);
  server.keepAliveTimeout = Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || 5_000);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (error, socket) => {
    logger.warn("http.client_error", "HTTP server rejected a client connection", { error });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  server.on("error", (error) => {
    logger.error("http.server_error", "HTTP server emitted an error", { error });
  });

  await listen(server);
  resourceMonitor = new ResourceMonitor({ logger });
  resourceMonitor.start();

  logger.info("application.ready", "Application is ready for traffic", {
    port: PORT,
    address: server.address(),
  });
  if (typeof process.send === "function") process.send("ready");
  return server;
}

function closeHttpServer() {
  if (!server?.listening) return Promise.resolve();

  return new Promise((resolve) => {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      logger.warn("http.shutdown_forced", "Forcing remaining HTTP connections to close", {
        openSocketCount: sockets.size,
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
      for (const socket of sockets) socket.destroy();
      finish();
    }, SHUTDOWN_TIMEOUT_MS);

    server.close(finish);
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
  });
}

async function shutdown(reason, { crash = false } = {}) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const startedAt = process.hrtime.bigint();
    logger.info("application.shutdown_started", "Graceful application shutdown started", {
      reason,
      crash,
      openSocketCount: sockets.size,
    });

    resourceMonitor?.stop();
    await closeHttpServer();

    if (workerRuntime?.shutdown) {
      await workerRuntime.shutdown("serverShutdown", { crash });
      workerRuntime = null;
    }

    const results = await Promise.allSettled([closeQueueConnections(), disconnectDB()]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      logger.error("application.shutdown_dependency_error", "Some dependencies failed to close", {
        errors: failures.map((failure) => failure.reason),
      });
    }

    logger.info("application.shutdown_complete", "Graceful application shutdown completed", {
      reason,
      durationMs: Number(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2),
    });
  })();
  return shutdownPromise;
}

if (require.main === module) {
  installProcessHandlers({ logger, shutdown });
  startServer().catch(async (error) => {
    logger.fatal("application.startup_failed", "Application failed during startup", { error });
    try {
      await shutdown("startupFailure", { crash: true });
    } finally {
      process.exit(1);
    }
  });
}

module.exports = { app, shutdown, startServer };
