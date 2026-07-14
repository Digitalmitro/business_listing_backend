// backend/services/crmLeadImportService.js
"use strict";

const fs = require("node:fs");
const csvParser = require("csv-parser");
const xlsx = require("xlsx");
const { createLead } = require("./crmLeadService");
const logger = require("../utils/logger");

/**
 * Parses and imports leads from a CSV or Excel file buffer/path for a given user.
 *
 * Supported columns (case-insensitive header matching):
 *  - leadName / name / full name / contact name (required)
 *  - company / business / organization / company name
 *  - email / email address
 *  - phone / mobile / contact number / phone number
 *  - expectedRevenue / revenue / value / deal size
 *  - status / stage
 *  - source / lead source
 *  - notes / comments / description
 *
 * @param {string} ownerId
 * @param {string|Buffer} fileInput - Absolute path to uploaded file or file buffer
 * @param {string} fileType - "csv" or "xlsx"
 * @returns {Promise<{ success: boolean, importedCount: number, failedCount: number, errors: Array }>}
 */
async function importLeads(ownerId, fileInput, fileType = "csv") {
  if (!ownerId) {
    throw new Error("ownerId is required to import leads");
  }

  const rows = [];
  const errors = [];
  let importedCount = 0;

  try {
    if (fileType.toLowerCase() === "csv") {
      await new Promise((resolve, reject) => {
        const stream = typeof fileInput === "string" ? fs.createReadStream(fileInput) : null;
        if (!stream) {
          // Parse string buffer directly
          const Readable = require("node:stream").Readable;
          const s = new Readable();
          s.push(fileInput);
          s.push(null);
          s.pipe(csvParser())
            .on("data", (data) => rows.push(data))
            .on("end", resolve)
            .on("error", reject);
        } else {
          stream
            .pipe(csvParser())
            .on("data", (data) => rows.push(data))
            .on("end", resolve)
            .on("error", reject);
        }
      });
    } else if (fileType.toLowerCase() === "xlsx" || fileType.toLowerCase() === "xls") {
      const workbook = typeof fileInput === "string"
        ? xlsx.readFile(fileInput)
        : xlsx.read(fileInput, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(sheet, { defval: "" });
      rows.push(...jsonData);
    } else {
      throw new Error(`Unsupported file type '${fileType}'. Supported types: csv, xlsx`);
    }

    // Process rows sequentially or in chunks
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // +2 accounting for 1-based index and header row

      // Normalize keys by removing spaces/underscores and converting to lowercase
      const normalizedRow = {};
      for (const [k, v] of Object.entries(row)) {
        const key = k.trim().toLowerCase().replace(/[\s_-]+/g, "");
        normalizedRow[key] = typeof v === "string" ? v.trim() : v;
      }

      const leadName =
        normalizedRow.leadname ||
        normalizedRow.name ||
        normalizedRow.fullname ||
        normalizedRow.contactname ||
        "";

      if (!leadName) {
        errors.push({ row: rowNum, error: "Missing required field: leadName (or Name)" });
        continue;
      }

      const company =
        normalizedRow.company ||
        normalizedRow.business ||
        normalizedRow.organization ||
        normalizedRow.companyname ||
        "";
      const email = normalizedRow.email || normalizedRow.emailaddress || "";
      const phone =
        normalizedRow.phone ||
        normalizedRow.mobile ||
        normalizedRow.contactnumber ||
        normalizedRow.phonenumber ||
        "";
      const rawRevenue =
        normalizedRow.expectedrevenue ||
        normalizedRow.revenue ||
        normalizedRow.value ||
        normalizedRow.dealsize ||
        0;
      const expectedRevenue = Number(rawRevenue) || 0;
      const status = normalizedRow.status || normalizedRow.stage || "New";
      const source = normalizedRow.source || normalizedRow.leadsource || "Imported";
      const notes = normalizedRow.notes || normalizedRow.comments || normalizedRow.description || "";

      try {
        await createLead(ownerId, {
          leadName,
          company,
          email,
          phone,
          expectedRevenue,
          status,
          source,
          notes,
        });
        importedCount++;
      } catch (rowErr) {
        errors.push({ row: rowNum, error: rowErr.message });
      }
    }

    // Clean up temporary file if path was passed
    if (typeof fileInput === "string" && fs.existsSync(fileInput)) {
      try {
        fs.unlinkSync(fileInput);
      } catch (cleanupErr) {
        logger.warn("Could not remove temp uploaded file after import", { fileInput, error: cleanupErr.message });
      }
    }

    logger.info("CRM lead import completed", { ownerId, totalRows: rows.length, importedCount, failedCount: errors.length });
    return {
      success: true,
      importedCount,
      failedCount: errors.length,
      errors: errors.slice(0, 100), // Limit returned error details
    };
  } catch (err) {
    if (typeof fileInput === "string" && fs.existsSync(fileInput)) {
      try { fs.unlinkSync(fileInput); } catch {}
    }
    logger.error("Error during CRM lead import", { ownerId, error: err.message });
    throw err;
  }
}

module.exports = { importLeads };
