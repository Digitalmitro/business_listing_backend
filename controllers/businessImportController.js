"use strict";

const fs = require("node:fs");
const mongoose = require("mongoose");

const BusinessImportBatch = require("../models/BusinessImportBatch");
const BusinessImportRow = require("../models/BusinessImportRow");
const { runBusinessImport } = require("../services/businessImportService");

const configuredPreviewLimit = Number.parseInt(process.env.BUSINESS_IMPORT_PREVIEW_LIMIT, 10);
const PREVIEW_LIMIT =
  Number.isInteger(configuredPreviewLimit) && configuredPreviewLimit > 0
    ? Math.min(200, configuredPreviewLimit)
    : 100;

const COUNTRY_ALIASES = new Map([
  ["US", "United States"],
  ["USA", "United States"],
  ["UNITED STATES", "United States"],
  ["UK", "United Kingdom"],
  ["UAE", "United Arab Emirates"],
]);

function normalizeImportCountry(country) {
  const trimmed = String(country || "").trim();
  return COUNTRY_ALIASES.get(trimmed.toUpperCase()) || trimmed;
}

function normalizeReasonCounts(reasonCounts) {
  if (reasonCounts instanceof Map) return Object.fromEntries(reasonCounts);
  return reasonCounts || {};
}

function formatSummary(totals = {}, reasonCounts = {}) {
  return {
    totalRowsFound: totals.found || 0,
    totalRowsSuccessfullyImported: totals.imported || 0,
    totalRowsSkipped: totals.skipped || 0,
    totalRowsRejected: totals.rejected || 0,
    reasonCounts: normalizeReasonCounts(reasonCounts),
  };
}

function formatRow(row) {
  return {
    id: row._id,
    rowNumber: row.rowNumber,
    status: row.status,
    reason: row.reason,
    reasons: row.reasons || [],
    data: row.data || {},
    rawData: row.rawData || {},
    businessId: row.business || null,
    processedAt: row.processedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function formatBatch(batch) {
  return {
    id: batch._id,
    fileName: batch.file?.originalName,
    fileReference: batch.file?.reference,
    mimeType: batch.file?.mimeType,
    sizeBytes: batch.file?.sizeBytes,
    status: batch.status,
    failureReason: batch.failureReason,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
    createdAt: batch.createdAt,
  };
}

function canAccessBatch(req, batch) {
  if (["admin", "super-admin"].includes(req.user?.role)) return true;
  return String(batch.uploadedBy) === String(req.user?._id || req.user?.id);
}

async function loadRows(batchId, query = {}) {
  const requestedPage = Number.parseInt(query.page, 10) || 1;
  const requestedLimit = Number.parseInt(query.limit, 10) || PREVIEW_LIMIT;
  const page = Math.max(1, requestedPage);
  const limit = Math.min(200, Math.max(1, requestedLimit));
  const filter = { batch: batchId };

  if (["imported", "skipped", "rejected", "processing"].includes(query.status)) {
    filter.status = query.status;
  }
  if (query.reason) filter.reasons = String(query.reason);

  const [rows, totalRows] = await Promise.all([
    BusinessImportRow.find(filter)
      .sort({ rowNumber: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    BusinessImportRow.countDocuments(filter),
  ]);

  return {
    rows: rows.map(formatRow),
    pagination: {
      page,
      limit,
      totalRows,
      totalPages: Math.max(1, Math.ceil(totalRows / limit)),
    },
  };
}

exports.importBusinesses = async (req, res, next) => {
  if (!req.file) {
    res.status(400).json({
      success: false,
      message: "File is required. Upload one CSV or Excel (.xlsx) file using the file or csvFile field.",
    });
    return;
  }

  try {
    const selectedCountry = req.body?.country ? String(req.body.country).trim() : "";
    const result = await runBusinessImport({
      file: req.file,
      user: req.user,
      selectedCountry: normalizeImportCountry(selectedCountry),
      normalizeCountry: normalizeImportCountry,
    });
    const rowResult = await loadRows(result.batchId, { page: 1, limit: PREVIEW_LIMIT });
    const summary = formatSummary(result.totals, result.reasonCounts);
    const responseStatus = result.fatal && result.totals.imported === 0 ? 400 : 200;

    res.status(responseStatus).json({
      success: responseStatus < 400,
      message: result.fatal
        ? result.totals.imported > 0
          ? "Import completed partially before a file parsing error occurred."
          : result.failureReason
        : result.status === "completed_with_errors"
          ? "Import completed with skipped or rejected rows."
          : "Import completed successfully.",
      batch: {
        id: result.batchId,
        fileName: result.fileName,
        fileReference: result.fileReference,
        status: result.status,
        failureReason: result.failureReason,
      },
      summary,
      rows: rowResult.rows,
      pagination: rowResult.pagination,
      resultsEndpoint: `/api/business/import-batches/${result.batchId}`,
      affectedCountries: result.affectedCountries,
      // Compatibility fields for existing API consumers.
      created: summary.totalRowsSuccessfullyImported,
      updated: 0,
      unchanged: 0,
      skipped: summary.totalRowsSkipped,
      rejected: summary.totalRowsRejected,
      errors: result.failureReason ? [result.failureReason] : [],
      warnings: [],
    });
  } catch (error) {
    try {
      await fs.promises.unlink(req.file.path);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        console.warn(`[BusinessImport] Could not remove temp file: ${cleanupError.message}`);
      }
    }
    next(error);
  }
};

exports.getBusinessImportBatch = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.batchId)) {
      res.status(400).json({ success: false, message: "Invalid import batch ID." });
      return;
    }

    const batch = await BusinessImportBatch.findById(req.params.batchId).lean();
    if (!batch) {
      res.status(404).json({ success: false, message: "Import batch not found." });
      return;
    }
    if (!canAccessBatch(req, batch)) {
      res.status(403).json({ success: false, message: "You cannot access this import batch." });
      return;
    }

    const rowResult = await loadRows(batch._id, req.query);
    res.json({
      success: true,
      batch: formatBatch(batch),
      summary: formatSummary(batch.totals, batch.reasonCounts),
      rows: rowResult.rows,
      pagination: rowResult.pagination,
    });
  } catch (error) {
    next(error);
  }
};

exports.getBusinessImportBatchRows = exports.getBusinessImportBatch;

exports.formatSummary = formatSummary;
