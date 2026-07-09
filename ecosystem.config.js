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
      name: "business-listing-api",
      script: "./server.js",
      instances: 1,
      exec_mode: "cluster",
      watch: false,
      max_memory_restart: "1500M",
      env: {
        NODE_ENV: "development",
        INLINE_WORKERS: "false",
      },
      env_production: {
        NODE_ENV: "production",
        SERVICE_NAME: "business-listing-api",
        LOG_FORMAT: "json",
        LOG_LEVEL: "info",
        INLINE_WORKERS: "false",
      },
      wait_ready: true,
      instance_var: "NODE_APP_INSTANCE",
      out_file: path.join(logDirectory, "api-out.log"),
      error_file: path.join(logDirectory, "api-error.log"),
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
        INLINE_WORKERS: "false",
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
