"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const csv = require("csv-parser");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const mongoose = require("mongoose");
const validator = require("validator");

const Business = require("../models/Business");
const BusinessImportBatch = require("../models/BusinessImportBatch");
const BusinessImportRow = require("../models/BusinessImportRow");
const Category = require("../models/Category");
const SubCategory = require("../models/SubCategory");

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

const IMPORT_CHUNK_SIZE = positiveInteger(process.env.BUSINESS_IMPORT_CHUNK_SIZE, 500, 5_000);
const MAX_IMPORT_ROWS = positiveInteger(process.env.BUSINESS_IMPORT_MAX_ROWS, 100_000, 1_000_000);
const MAX_CELL_LENGTH = positiveInteger(process.env.BUSINESS_IMPORT_MAX_CELL_LENGTH, 5_000, 100_000);
const MAX_RAW_COLUMNS = 100;
const MAX_RAW_CELL_LENGTH = positiveInteger(
  process.env.BUSINESS_IMPORT_MAX_RAW_CELL_LENGTH,
  1_000,
  10_000
);
const CATEGORY_RESOLUTION_CONCURRENCY = positiveInteger(
  process.env.BUSINESS_IMPORT_CATEGORY_CONCURRENCY,
  10,
  50
);
let importIndexPromise;

const HEADER_ALIASES = {
  businessName: ["Business Name", "businessName", "business_name", "Name", "Company Name"],
  phone: ["Phone", "Mobile", "Phone Number", "Mobile Number"],
  email: ["Email", "Email Address"],
  address: ["Address", "Street Address"],
  website: ["Website", "Website URL", "URL"],
  rating: ["Rating"],
  reviews: ["Reviews", "Review Count", "Total Reviews"],
  latitude: ["Latitude", "Lat"],
  longitude: ["Longitude", "Lng", "Lon", "Long"],
  category: ["Category"],
  subcategory: ["Subcategory", "Sub Category"],
  country: ["Country"],
};

const FIELD_LABELS = {
  businessName: "Business Name",
  phone: "Phone",
  email: "Email",
  address: "Address",
  website: "Website",
  rating: "Rating",
  reviews: "Reviews",
  latitude: "Latitude",
  longitude: "Longitude",
  category: "Category",
  subcategory: "Subcategory",
  country: "Country",
};

const TEXT_FIELDS = new Set([
  "businessName",
  "email",
  "address",
  "website",
  "category",
  "subcategory",
  "country",
]);
const NUMERIC_FIELDS = new Set(["rating", "reviews", "latitude", "longitude"]);

function normalizeHeader(header) {
  return String(header || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeIdentityPart(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhone(value) {
  const trimmed = String(value || "").trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

function buildIdentitySource(data) {
  return [
    normalizeIdentityPart(data.businessName),
    normalizePhone(data.phone),
    normalizeIdentityPart(data.email),
  ].join("|");
}

function buildIdentityKey(data) {
  return createHash("sha256").update(buildIdentitySource(data)).digest("hex");
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function isEmptyRawRow(values) {
  return Object.values(values || {}).every(isBlank);
}

function sanitizeRawData(values) {
  const sanitized = {};
  for (const [key, value] of Object.entries(values || {}).slice(0, MAX_RAW_COLUMNS)) {
    if (key.startsWith("__")) continue;
    const safeKey = String(key).slice(0, 200).replace(/[.$]/g, "_") || "unnamed_column";
    if (value === null || value === undefined) {
      sanitized[safeKey] = "";
    } else if (["string", "number", "boolean"].includes(typeof value)) {
      sanitized[safeKey] = String(value).slice(0, MAX_RAW_CELL_LENGTH);
    } else {
      sanitized[safeKey] = "[unsupported data type]";
    }
  }
  return sanitized;
}

function createRowReader(values) {
  const normalizedValues = new Map();
  for (const [header, value] of Object.entries(values || {})) {
    normalizedValues.set(normalizeHeader(header), value);
  }

  return {
    read(field) {
      for (const alias of HEADER_ALIASES[field]) {
        const key = normalizeHeader(alias);
        if (normalizedValues.has(key)) {
          return { present: true, key, value: normalizedValues.get(key) };
        }
      }
      return { present: false, key: null, value: undefined };
    },
  };
}

function valueAsString(value) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return "";
}

function hasUnsupportedType(field, readResult, unsupportedHeaders) {
  if (!readResult.present || isBlank(readResult.value)) return false;
  if (unsupportedHeaders.has(readResult.key)) return true;
  if (field === "phone") return !["string", "number"].includes(typeof readResult.value);
  if (TEXT_FIELDS.has(field)) return typeof readResult.value !== "string";
  if (NUMERIC_FIELDS.has(field)) return !["string", "number"].includes(typeof readResult.value);
  return false;
}

function validateAndNormalizeRow(entry, options = {}) {
  const values = entry?.values || entry || {};
  const unsupportedHeaders = new Set(
    (entry?.unsupportedFields || []).map((header) => normalizeHeader(header))
  );
  const normalizeCountry = options.normalizeCountry || ((country) => country);

  if (isEmptyRawRow(values)) {
    return {
      status: "skipped",
      reasons: ["Empty row"],
      data: {},
      rawData: sanitizeRawData(values),
    };
  }

  const reader = createRowReader(values);
  const fields = {};
  for (const field of Object.keys(HEADER_ALIASES)) fields[field] = reader.read(field);
  const malformedRow = Object.keys(values).some((header) => /^_\d+$/.test(header));

  const missingReasons = [];
  for (const field of ["businessName", "phone", "email"]) {
    if (!fields[field].present || isBlank(fields[field].value)) {
      missingReasons.push(`Missing ${FIELD_LABELS[field]}`);
    }
  }

  const data = {};
  for (const field of Object.keys(HEADER_ALIASES)) {
    data[field] = valueAsString(fields[field].value);
  }

  if (!data.country && options.selectedCountry) data.country = String(options.selectedCountry).trim();
  if (data.country) data.country = normalizeCountry(data.country);

  if (missingReasons.length > 0) {
    return {
      status: "skipped",
      reasons: missingReasons,
      data,
      rawData: sanitizeRawData(values),
    };
  }

  const reasons = [];
  if (malformedRow) reasons.push("Malformed row");
  for (const field of Object.keys(HEADER_ALIASES)) {
    if (hasUnsupportedType(field, fields[field], unsupportedHeaders)) {
      reasons.push(`Unsupported data type: ${FIELD_LABELS[field]}`);
    }
  }

  if (reasons.length > 0) {
    return {
      status: "rejected",
      reasons,
      data,
      rawData: sanitizeRawData(values),
    };
  }

  if (data.businessName.length > 300) reasons.push("Invalid Business Name");

  const rawPhone = data.phone;
  const phoneDigits = rawPhone.replace(/\D/g, "");
  const validPhoneCharacters = /^[+\d\s().-]+$/.test(rawPhone);
  const plusIsValid = !rawPhone.includes("+") || /^\+[^+]*$/.test(rawPhone);
  if (!validPhoneCharacters || !plusIsValid || phoneDigits.length < 7 || phoneDigits.length > 15) {
    reasons.push("Invalid Phone format");
  } else {
    data.phone = normalizePhone(rawPhone);
  }

  if (!validator.isEmail(data.email, { allow_utf8_local_part: false })) {
    reasons.push("Invalid Email format");
  } else {
    data.email = data.email.toLowerCase();
  }

  if (
    data.website &&
    !validator.isURL(data.website, {
      protocols: ["http", "https"],
      require_protocol: false,
      require_valid_protocol: true,
    })
  ) {
    reasons.push("Invalid Website format");
  }

  const parseOptionalNumber = (field, reason, predicate) => {
    if (!data[field]) {
      data[field] = null;
      return;
    }
    const parsed = Number(data[field]);
    if (!Number.isFinite(parsed) || !predicate(parsed)) reasons.push(reason);
    else data[field] = parsed;
  };

  parseOptionalNumber("rating", "Invalid Rating", (value) => value >= 0 && value <= 5);
  parseOptionalNumber("reviews", "Invalid Reviews", (value) => Number.isInteger(value) && value >= 0);
  parseOptionalNumber("latitude", "Invalid Latitude", (value) => value >= -90 && value <= 90);
  parseOptionalNumber("longitude", "Invalid Longitude", (value) => value >= -180 && value <= 180);

  const hasLatitude = data.latitude !== null;
  const hasLongitude = data.longitude !== null;
  if (hasLatitude !== hasLongitude) {
    reasons.push("Latitude and Longitude must be provided together");
  }

  for (const field of ["address", "website", "category", "subcategory", "country"]) {
    if (data[field] && data[field].length > MAX_CELL_LENGTH) {
      reasons.push(`Invalid ${FIELD_LABELS[field]}`);
    }
  }

  return {
    status: reasons.length > 0 ? "rejected" : "valid",
    reasons,
    data,
    rawData: sanitizeRawData(values),
    identityKey: reasons.length > 0 ? null : buildIdentityKey(data),
  };
}

function extractExcelCellValue(value) {
  if (value === null || value === undefined) return { value: "", unsupported: false };
  if (["string", "number"].includes(typeof value)) return { value, unsupported: false };
  if (typeof value === "boolean" || value instanceof Date) return { value, unsupported: true };

  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "result")) {
      return extractExcelCellValue(value.result);
    }
    if (typeof value.text === "string") return { value: value.text, unsupported: false };
    if (Array.isArray(value.richText)) {
      return {
        value: value.richText.map((part) => part?.text || "").join(""),
        unsupported: false,
      };
    }
  }

  return { value, unsupported: true };
}

function assertUsableHeaders(headers) {
  if (!headers.some((header) => String(header || "").trim())) {
    throw new Error("The file does not contain a readable header row.");
  }
}

async function readCsvInChunks(filePath, onChunk) {
  let rowNumber = 1;
  let chunk = [];
  const parser = fs.createReadStream(filePath).pipe(
    csv({
      mapHeaders: ({ header }) => String(header || "").replace(/^\uFEFF/, "").trim(),
      maxRowBytes: positiveInteger(
        process.env.BUSINESS_IMPORT_MAX_ROW_BYTES,
        1024 * 1024,
        5 * 1024 * 1024
      ),
    })
  );

  for await (const values of parser) {
    rowNumber += 1;
    if (rowNumber - 1 > MAX_IMPORT_ROWS) {
      throw new Error(`The file exceeds the maximum of ${MAX_IMPORT_ROWS} business rows.`);
    }
    chunk.push({ rowNumber, values, unsupportedFields: [] });
    if (chunk.length >= IMPORT_CHUNK_SIZE) {
      await onChunk(chunk);
      chunk = [];
    }
  }

  if (chunk.length > 0) await onChunk(chunk);
}

async function readExcelWithExcelJs(filePath, onChunk) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Workbook does not contain a worksheet.");

  const headers = [];
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    const extracted = extractExcelCellValue(cell.value);
    headers[columnNumber] = valueAsString(extracted.value).replace(/^\uFEFF/, "");
  });
  assertUsableHeaders(headers);

  const finalRow = worksheet.rowCount;
  if (Math.max(0, finalRow - 1) > MAX_IMPORT_ROWS) {
    throw new Error(`The file exceeds the maximum of ${MAX_IMPORT_ROWS} business rows.`);
  }

  let chunk = [];
  for (let rowNumber = 2; rowNumber <= finalRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = {};
    const unsupportedFields = [];
    for (let columnNumber = 1; columnNumber < headers.length; columnNumber += 1) {
      const header = headers[columnNumber];
      if (!header) continue;
      const extracted = extractExcelCellValue(row.getCell(columnNumber).value);
      values[header] = extracted.value;
      if (extracted.unsupported) unsupportedFields.push(header);
    }
    chunk.push({ rowNumber, values, unsupportedFields });
    if (chunk.length >= IMPORT_CHUNK_SIZE) {
      await onChunk(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) await onChunk(chunk);
}

async function readExcelWithSheetJs(filePath, onChunk) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const firstSheetName = workbook.SheetNames?.[0];
  const worksheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
  if (!worksheet) throw new Error("Workbook does not contain a readable worksheet.");

  const matrix = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
    raw: true,
    blankrows: true,
  });
  const headers = (matrix[0] || []).map((header) => valueAsString(header).replace(/^\uFEFF/, ""));
  assertUsableHeaders(headers);
  if (Math.max(0, matrix.length - 1) > MAX_IMPORT_ROWS) {
    throw new Error(`The file exceeds the maximum of ${MAX_IMPORT_ROWS} business rows.`);
  }

  let chunk = [];
  for (let index = 1; index < matrix.length; index += 1) {
    const values = {};
    const unsupportedFields = [];
    for (let column = 0; column < headers.length; column += 1) {
      if (!headers[column]) continue;
      const value = matrix[index]?.[column] ?? "";
      values[headers[column]] = value;
      if (!["string", "number"].includes(typeof value) && !isBlank(value)) {
        unsupportedFields.push(headers[column]);
      }
    }
    chunk.push({ rowNumber: index + 1, values, unsupportedFields });
    if (chunk.length >= IMPORT_CHUNK_SIZE) {
      await onChunk(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) await onChunk(chunk);
}

async function readImportFile(file, onChunk) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (extension === ".csv") {
    await readCsvInChunks(file.path, onChunk);
    return;
  }
  if (extension !== ".xlsx") throw new Error("Unsupported file type.");

  try {
    await readExcelWithExcelJs(file.path, onChunk);
  } catch (excelJsError) {
    // Do not replay already processed rows. ExcelJS failures during initial workbook
    // loading are safe to retry; processing errors must be surfaced as-is.
    if (excelJsError.importRowsProcessed) throw excelJsError;
    await readExcelWithSheetJs(file.path, onChunk);
  }
}

function incrementReasonCounts(reasonCounts, reasons) {
  for (const reason of reasons) {
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
}

async function ensureImportIndexes() {
  if (!importIndexPromise) {
    importIndexPromise = Promise.all([
      Business.collection.createIndex(
        { importIdentityKey: 1 },
        { unique: true, sparse: true, name: "importIdentityKey_1" }
      ),
      BusinessImportBatch.collection.createIndex(
        { "file.reference": 1 },
        { unique: true, name: "file.reference_1" }
      ),
      BusinessImportBatch.collection.createIndex(
        { uploadedBy: 1, createdAt: -1 },
        { name: "uploadedBy_1_createdAt_-1" }
      ),
      BusinessImportRow.collection.createIndex(
        { batch: 1, rowNumber: 1 },
        { unique: true, name: "batch_1_rowNumber_1" }
      ),
      BusinessImportRow.collection.createIndex(
        { batch: 1, status: 1, rowNumber: 1 },
        { name: "batch_1_status_1_rowNumber_1" }
      ),
    ]).catch((error) => {
      importIndexPromise = null;
      throw error;
    });
  }
  return importIndexPromise;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getExistingBusinessIdentityKeys(business) {
  const phones = new Set([
    ...(business.contact?.mobile || []),
    ...(business.contact?.contactDetails || []).flatMap((contact) => contact.mobileNumbers || []),
  ].map(normalizePhone).filter(Boolean));
  const emails = new Set([
    ...(business.contact?.email || []),
    ...(business.contact?.contactDetails || []).flatMap((contact) => contact.emails || []),
  ].map(normalizeIdentityPart).filter(Boolean));
  const keys = new Set();
  for (const phone of phones) {
    for (const email of emails) {
      keys.add(buildIdentityKey({ businessName: business.businessName, phone, email }));
    }
  }
  if (business.importIdentityKey) keys.add(business.importIdentityKey);
  return keys;
}

function parseAddress(data) {
  const parts = String(data.address || "").split(";").map((part) => part.trim());
  const hasStructuredAddress = parts.length >= 5;
  return {
    streetName: hasStructuredAddress ? parts[0] : data.address || "",
    area: hasStructuredAddress ? parts[1] : "",
    city: hasStructuredAddress ? parts[2] || "Unknown City" : "Unknown City",
    state: hasStructuredAddress ? parts[3] || "Unknown State" : "Unknown State",
    pincode: hasStructuredAddress ? parts[4] || "000000" : "000000",
    country: data.country || (hasStructuredAddress ? parts[5] : "") || "Unknown Country",
  };
}

function buildBusinessDocument(candidate, category, subcategory, batch, fileName) {
  const { data, identityKey, rowId, businessId, rowNumber } = candidate;
  const hasCoordinates = data.latitude !== null && data.longitude !== null;
  const address = parseAddress(data);

  return {
    _id: businessId,
    businessName: data.businessName,
    address,
    addressString: data.address || "",
    location: {
      type: "Point",
      coordinates: hasCoordinates ? [data.longitude, data.latitude] : [0, 0],
    },
    contact: {
      mobile: [data.phone],
      email: [data.email],
      contactDetails: [
        {
          title: "Mr",
          name: data.businessName,
          mobileNumbers: [data.phone],
          emails: [data.email],
        },
      ],
    },
    website: data.website || "",
    rating: data.rating ?? 0,
    totalReviews: data.reviews ?? 0,
    category: category ? [category._id] : [],
    subCategory: subcategory ? [subcategory._id] : [],
    importedCategory: data.category || "",
    importedSubcategory: data.subcategory || "",
    verified: false,
    claimed: false,
    isBlocked: false,
    needsGeocoding: !hasCoordinates && Boolean(data.address),
    importIdentityKey: identityKey,
    importMetadata: {
      batch: batch._id,
      row: rowId,
      rowNumber,
      sourceFileName: fileName,
      importedAt: new Date(),
    },
  };
}

function createCategoryResolver() {
  const categoryCache = new Map();
  const subcategoryCache = new Map();

  const getCategory = async (name) => {
    const normalizedName = normalizeIdentityPart(name);
    if (!normalizedName) return null;
    if (categoryCache.has(normalizedName)) return categoryCache.get(normalizedName);
    const pendingCategory = (async () => {
      let category = await Category.findOne({
        name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
      });
      if (!category) {
        try {
          category = await Category.create({ name: String(name).trim() });
        } catch (error) {
          if (error.code !== 11000) throw error;
          category = await Category.findOne({
            name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
          });
        }
      }
      return category;
    })();
    categoryCache.set(normalizedName, pendingCategory);
    try {
      const category = await pendingCategory;
      categoryCache.set(normalizedName, category);
      return category;
    } catch (error) {
      categoryCache.delete(normalizedName);
      throw error;
    }
  };

  const getSubcategory = async (name, category) => {
    const normalizedName = normalizeIdentityPart(name);
    if (!normalizedName || !category) return null;
    const cacheKey = `${category._id}:${normalizedName}`;
    if (subcategoryCache.has(cacheKey)) return subcategoryCache.get(cacheKey);
    const pendingSubcategory = (async () => {
      let subcategory = await SubCategory.findOne({
        name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
        category: category._id,
      });
      if (!subcategory) {
        try {
          subcategory = await SubCategory.create({ name: String(name).trim(), category: category._id });
        } catch (error) {
          if (error.code !== 11000) throw error;
          subcategory = await SubCategory.findOne({
            name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
            category: category._id,
          });
        }
      }
      return subcategory;
    })();
    subcategoryCache.set(cacheKey, pendingSubcategory);
    try {
      const subcategory = await pendingSubcategory;
      subcategoryCache.set(cacheKey, subcategory);
      return subcategory;
    } catch (error) {
      subcategoryCache.delete(cacheKey);
      throw error;
    }
  };

  return { getCategory, getSubcategory };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        try {
          results[currentIndex] = {
            status: "fulfilled",
            value: await worker(items[currentIndex], currentIndex),
          };
        } catch (reason) {
          results[currentIndex] = { status: "rejected", reason };
        }
      }
    })
  );
  return results;
}

function makeAuditDocument(batchId, entry, validation, overrides = {}) {
  return {
    _id: overrides.rowId || new mongoose.Types.ObjectId(),
    batch: batchId,
    rowNumber: entry.rowNumber,
    status: overrides.status || validation.status,
    reason: overrides.reasons?.[0] || validation.reasons?.[0] || null,
    reasons: overrides.reasons || validation.reasons || [],
    rawData: validation.rawData,
    data: validation.data,
    business: overrides.businessId || null,
    processedAt: overrides.status === "processing" ? null : new Date(),
  };
}

async function findDuplicateKeys(candidates) {
  if (candidates.length === 0) return new Set();
  const identityKeys = candidates.map((candidate) => candidate.identityKey);
  const businessNames = [...new Set(candidates.map((candidate) => candidate.data.businessName))];
  const existingBusinesses = await Business.find({
    $or: [
      { importIdentityKey: { $in: identityKeys } },
      { businessName: { $in: businessNames } },
    ],
  })
    .collation({ locale: "en", strength: 2 })
    .select("businessName importIdentityKey contact.mobile contact.email contact.contactDetails")
    .lean();

  const existingKeys = new Set();
  for (const business of existingBusinesses) {
    for (const identityKey of getExistingBusinessIdentityKeys(business)) existingKeys.add(identityKey);
  }
  return existingKeys;
}

async function processChunk(entries, context) {
  const { batch, counters, reasonCounts, seenIdentityKeys, categoryResolver, normalizeCountry } = context;
  const auditDocuments = [];
  const validCandidates = [];

  for (const entry of entries) {
    counters.found += 1;
    const validation = validateAndNormalizeRow(entry, {
      selectedCountry: batch.selectedCountry,
      normalizeCountry,
    });

    if (validation.status !== "valid") {
      counters[validation.status] += 1;
      incrementReasonCounts(reasonCounts, validation.reasons);
      auditDocuments.push(makeAuditDocument(batch._id, entry, validation));
      continue;
    }

    if (seenIdentityKeys.has(validation.identityKey)) {
      const reasons = ["Duplicate record"];
      counters.rejected += 1;
      incrementReasonCounts(reasonCounts, reasons);
      auditDocuments.push(makeAuditDocument(batch._id, entry, validation, { status: "rejected", reasons }));
      continue;
    }

    seenIdentityKeys.add(validation.identityKey);
    validCandidates.push({
      ...validation,
      entry,
      rowNumber: entry.rowNumber,
      rowId: new mongoose.Types.ObjectId(),
      businessId: new mongoose.Types.ObjectId(),
    });
  }

  const duplicateKeys = await findDuplicateKeys(validCandidates);
  const categoryCandidates = [];
  const importCandidates = [];
  for (const candidate of validCandidates) {
    if (duplicateKeys.has(candidate.identityKey)) {
      const reasons = ["Duplicate record"];
      counters.rejected += 1;
      incrementReasonCounts(reasonCounts, reasons);
      auditDocuments.push(
        makeAuditDocument(batch._id, candidate.entry, candidate, {
          rowId: candidate.rowId,
          status: "rejected",
          reasons,
        })
      );
      continue;
    }
    categoryCandidates.push(candidate);
  }

  const categoryResults = await mapWithConcurrency(
    categoryCandidates,
    CATEGORY_RESOLUTION_CONCURRENCY,
    async (candidate) => {
      candidate.categoryDocument = await categoryResolver.getCategory(candidate.data.category);
      candidate.subcategoryDocument = await categoryResolver.getSubcategory(
        candidate.data.subcategory,
        candidate.categoryDocument
      );
      return candidate;
    }
  );

  for (let index = 0; index < categoryCandidates.length; index += 1) {
    const candidate = categoryCandidates[index];
    if (categoryResults[index].status === "fulfilled") {
      importCandidates.push(candidate);
      auditDocuments.push(
        makeAuditDocument(batch._id, candidate.entry, candidate, {
          rowId: candidate.rowId,
          status: "processing",
        })
      );
    } else {
      const reasons = ["Database error"];
      counters.rejected += 1;
      incrementReasonCounts(reasonCounts, reasons);
      auditDocuments.push(
        makeAuditDocument(batch._id, candidate.entry, candidate, {
          rowId: candidate.rowId,
          status: "rejected",
          reasons,
        })
      );
    }
  }

  if (auditDocuments.length > 0) {
    await BusinessImportRow.insertMany(auditDocuments, { ordered: true });
  }
  if (importCandidates.length === 0) return;

  const operations = importCandidates.map((candidate) => ({
    insertOne: {
      document: buildBusinessDocument(
        candidate,
        candidate.categoryDocument,
        candidate.subcategoryDocument,
        batch,
        batch.file.originalName
      ),
    },
  }));

  const failedIndexes = new Map();
  try {
    await Business.bulkWrite(operations, { ordered: false });
  } catch (error) {
    const writeErrors = error.writeErrors || [];
    if (writeErrors.length === 0) {
      for (let index = 0; index < operations.length; index += 1) failedIndexes.set(index, error);
    } else {
      for (const writeError of writeErrors) failedIndexes.set(writeError.index, writeError);
    }
  }

  const rowUpdates = [];
  for (let index = 0; index < importCandidates.length; index += 1) {
    const candidate = importCandidates[index];
    const writeError = failedIndexes.get(index);
    if (writeError) {
      const duplicate = writeError.code === 11000 || writeError.err?.code === 11000;
      const reason = duplicate ? "Duplicate record" : "Database error";
      counters.rejected += 1;
      incrementReasonCounts(reasonCounts, [reason]);
      rowUpdates.push({
        updateOne: {
          filter: { _id: candidate.rowId },
          update: {
            $set: {
              status: "rejected",
              reason,
              reasons: [reason],
              business: null,
              processedAt: new Date(),
            },
          },
        },
      });
    } else {
      counters.imported += 1;
      const importedCountry = parseAddress(candidate.data).country;
      if (importedCountry && importedCountry !== "Unknown Country") {
        context.affectedCountries.add(importedCountry);
      }
      rowUpdates.push({
        updateOne: {
          filter: { _id: candidate.rowId },
          update: {
            $set: {
              status: "imported",
              reason: null,
              reasons: [],
              business: candidate.businessId,
              processedAt: new Date(),
            },
          },
        },
      });
    }
  }
  await BusinessImportRow.bulkWrite(rowUpdates, { ordered: false });
}

async function createBatch({ file, user, selectedCountry }) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  return BusinessImportBatch.create({
    file: {
      originalName: String(file.originalname || "import").slice(0, 500),
      mimeType: file.mimetype || "application/octet-stream",
      extension,
      sizeBytes: file.size || 0,
      reference: randomUUID(),
    },
    uploadedBy: user._id,
    uploaderModel: ["admin", "super-admin"].includes(user.role) ? "Admin" : "User",
    selectedCountry: selectedCountry || "",
  });
}

async function finalizeBatch(batch, counters, reasonCounts, fatalError = null, fatalKind = null) {
  const hasRowErrors = counters.skipped > 0 || counters.rejected > 0;
  const status = fatalError
    ? counters.found > 0 || counters.imported > 0
      ? "completed_with_errors"
      : "failed"
    : hasRowErrors
      ? "completed_with_errors"
      : "completed";

  await BusinessImportBatch.updateOne(
    { _id: batch._id },
    {
      $set: {
        status,
        totals: counters,
        reasonCounts,
        failureReason: fatalError ? `${fatalKind}: ${fatalError.message}` : null,
        completedAt: new Date(),
      },
    }
  );

  return {
    status,
    totals: { ...counters },
    reasonCounts: { ...reasonCounts },
    failureReason: fatalError ? `${fatalKind}: ${fatalError.message}` : null,
  };
}

async function runBusinessImport({ file, user, selectedCountry = "", normalizeCountry }) {
  await ensureImportIndexes();
  const batch = await createBatch({ file, user, selectedCountry });
  const counters = { found: 0, imported: 0, skipped: 0, rejected: 0 };
  const reasonCounts = {};
  const context = {
    batch,
    counters,
    reasonCounts,
    seenIdentityKeys: new Set(),
    affectedCountries: new Set(),
    categoryResolver: createCategoryResolver(),
    normalizeCountry: normalizeCountry || ((country) => country),
  };
  let fatalError = null;

  try {
    await readImportFile(file, async (entries) => {
      try {
        await processChunk(entries, context);
      } catch (error) {
        error.importRowsProcessed = true;
        throw error;
      }
    });
  } catch (error) {
    fatalError = error;
    const reason = error.importRowsProcessed ? "Import processing error" : "File parsing error";
    incrementReasonCounts(reasonCounts, [reason]);
  } finally {
    try {
      await fs.promises.unlink(file.path);
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`[BusinessImport] Could not remove temp file: ${error.message}`);
    }
  }

  const fatalKind = fatalError?.importRowsProcessed ? "Import processing error" : "File parsing error";
  const finalState = await finalizeBatch(batch, counters, reasonCounts, fatalError, fatalKind);
  return {
    batchId: batch._id,
    fileReference: batch.file.reference,
    fileName: batch.file.originalName,
    affectedCountries: [...context.affectedCountries].sort(),
    fatal: Boolean(fatalError),
    ...finalState,
  };
}

module.exports = {
  HEADER_ALIASES,
  buildIdentityKey,
  normalizeHeader,
  normalizePhone,
  readImportFile,
  runBusinessImport,
  validateAndNormalizeRow,
};
