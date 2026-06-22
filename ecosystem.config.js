"use strict";

const fs = require("node:fs");
const path = require("node:path");

const rootDirectory = __dirname;
const logDirectory = path.join(rootDirectory, "logs");
fs.mkdirSync(logDirectory, { recursive: true });

const common = {
  cwd: rootDirectory,
  autorestart: true,
  watch: false,
  merge_logs: true,
  time: false,
  min_uptime: "10s",
  max_restarts: 10,
  exp_backoff_restart_delay: 100,
  kill_timeout: 15_000,
  listen_timeout: 20_000,
  source_map_support: true,
  env: {
    LOG_FORMAT: "pretty",
    LOG_LEVEL: "debug",
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: "business-listing-api",
      script: "./server.js",
      exec_mode: "cluster",
      instances: Number(process.env.WEB_CONCURRENCY || 2),
      instance_var: "NODE_APP_INSTANCE",
      wait_ready: true,
      max_memory_restart: process.env.API_MAX_MEMORY || "1G",
      out_file: path.join(logDirectory, "api-out.log"),
      error_file: path.join(logDirectory, "api-error.log"),
      env_production: {
        NODE_ENV: "production",
        SERVICE_NAME: "business-listing-api",
        LOG_FORMAT: "json",
        LOG_LEVEL: "info",
      },
    },
    {
      ...common,
      name: "business-listing-workers",
      script: "./startWorker.js",
      exec_mode: "fork",
      instances: 1,
      wait_ready: true,
      max_memory_restart: process.env.WORKER_MAX_MEMORY || "768M",
      out_file: path.join(logDirectory, "workers-out.log"),
      error_file: path.join(logDirectory, "workers-error.log"),
      env_production: {
        NODE_ENV: "production",
        SERVICE_NAME: "business-listing-workers",
        LOG_FORMAT: "json",
        LOG_LEVEL: "info",
      },
    },
    {
      ...common,
      name: "business-listing-cpu-monitor",
      script: "./scripts/cpuMonitor.js",
      exec_mode: "fork",
      instances: 1,
      wait_ready: false,
      max_memory_restart: "192M",
      out_file: path.join(logDirectory, "cpu-monitor-out.log"),
      error_file: path.join(logDirectory, "cpu-monitor-error.log"),
      env_production: {
        NODE_ENV: "production",
        SERVICE_NAME: "business-listing-cpu-monitor",
        LOG_FORMAT: "json",
        LOG_LEVEL: "info",
      },
    },
  ],
};
