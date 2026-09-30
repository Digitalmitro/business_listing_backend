"use strict";

/**
 * Reads the first sheet of a CSV or Excel file into `{ headers, rows }`, where each
 * row is an object keyed by the original header text. Blank rows are dropped.
 */

const fs = require("node:fs");
const csvParser = require("csv-parser");
const xlsx = require("xlsx");

async function readCsv(filePath, maxRows) {
  const rows = [];
  let headers = [];
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream
      .pipe(csvParser({ mapHeaders: ({ header }) => String(header || "").replace(/^﻿/, "").trim() }))
      .on("headers", (h) => {
        headers = h;
      })
      .on("data", (row) => {
        if (rows.length < maxRows) rows.push(row);
      })
      .on("end", resolve)
      .on("error", reject);
  });
  return { headers, rows };
}

function readWorkbook(filePath, maxRows) {
  const workbook = xlsx.readFile(filePath, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { headers: [], rows: [] };
  const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, dateNF: "yyyy-mm-dd" });
  const headers = (matrix[0] || []).map((h) => String(h || "").trim());
  const rows = [];
  for (let i = 1; i < matrix.length && rows.length < maxRows; i++) {
    const row = {};
    headers.forEach((h, idx) => {
      if (h) row[h] = matrix[i][idx] ?? "";
    });
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * @param {string} filePath
 * @param {"csv"|"xlsx"} fileType
 * @param {{maxRows?: number}} [options]
 */
async function readSpreadsheet(filePath, fileType, { maxRows = 20000 } = {}) {
  const { headers, rows } = fileType === "csv" ? await readCsv(filePath, maxRows + 1) : readWorkbook(filePath, maxRows + 1);
  const cleanHeaders = [...new Set(headers.filter(Boolean))];
  const nonEmpty = rows.filter((r) => Object.values(r).some((v) => String(v ?? "").trim() !== ""));
  return { headers: cleanHeaders, rows: nonEmpty.slice(0, maxRows), truncated: nonEmpty.length > maxRows };
}

module.exports = { readSpreadsheet };
