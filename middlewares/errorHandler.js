"use strict";

const { randomUUID } = require("node:crypto");
const logger = require("../utils/logger");

function notFoundHandler(req, res) {
  logger.warn("http.route_not_found", "No route matched the HTTP request", {
    statusCode: 404,
  });
  res.status(404).json({
    success: false,
    message: "Route not found",
    requestId: req.requestId,
  });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    logger.error("http.error_after_headers", "Request failed after response headers were sent", {
      error,
    });
    next(error);
    return;
  }

  const errorId = randomUUID();
  const candidateStatus = error.statusCode || error.status;
  const statusCode = Number.isInteger(candidateStatus) && candidateStatus >= 400
    ? candidateStatus
    : error.type === "entity.parse.failed"
      ? 400
      : 500;
  const operational = Boolean(error.isOperational || statusCode < 500);
  const logMethod = statusCode >= 500 ? "error" : "warn";

  logger[logMethod]("http.request_error", "HTTP request handler raised an error", {
    errorId,
    statusCode,
    operational,
    error,
  });

  res.status(statusCode).json({
    success: false,
    message:
      statusCode >= 500 && process.env.NODE_ENV === "production"
        ? "Internal server error"
        : error.message || "Request failed",
    errorId,
    requestId: req.requestId,
  });
}

module.exports = { errorHandler, notFoundHandler };
