"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");
const mongoose = require("mongoose");
const BusinessImportBatch = require("../models/BusinessImportBatch");
const { MAX_IMPORT_FILE_BYTES } = require("../config/businessImportUpload");

const {
  buildIdentityKey,
  compactAuditData,
  decodeReasonCounts,
  encodeReasonCounts,
  getExistingBusinessIdentityKeys,
  makeAuditDocument,
  MAX_IMPORT_ROWS,
  normalizeHeader,
  readImportFile,
  reserveAuditRow,
  validateAndNormalizeRow,
} = require("./businessImportService");

test("large-import defaults support datasets above the old 100,000-row limit", () => {
  assert.equal(MAX_IMPORT_ROWS, 1_000_000);
  assert.equal(MAX_IMPORT_FILE_BYTES, 100 * 1024 * 1024);
});

test("reason summaries encode punctuation safely for Mongoose maps", () => {
  const original = {
    "Phone number is too short.": 12,
    "Invalid phone number for the selected country.": 4,
  };
  const encoded = encodeReasonCounts(original);

  assert.equal(Object.keys(encoded).every((key) => !/[.$]/.test(key)), true);
  assert.deepEqual(decodeReasonCounts(new Map(Object.entries(encoded))), original);

  const batch = new BusinessImportBatch({
    file: {
      originalName: "phones.csv",
      extension: ".csv",
      sizeBytes: 1,
      reference: "reason-map-regression-test",
    },
    uploadedBy: new mongoose.Types.ObjectId(),
    uploaderModel: "Admin",
    reasonCounts: encoded,
  });
  assert.equal(batch.validateSync(), undefined);
  assert.deepEqual(decodeReasonCounts(batch.reasonCounts), original);
});

const phoneOnlyRow = {
  "Business Name": "Acme Services",
  Phone: "+91 98765-43210",
  Email: "HELLO@EXAMPLE.COM",
};

test("phone is the only required field", () => {
  const result = validateAndNormalizeRow({ Phone: "+91 98765-43210" });

  assert.equal(result.status, "valid");
  assert.equal(result.data.businessName, "Unnamed Business");
  assert.equal(result.data.phone, "+919876543210");
  assert.equal(result.data.email, "");
  assert.equal(result.data.address, "");
  assert.equal(result.data.rating, null);
  assert.equal(result.data.latitude, null);
});

test("row with blank email is valid", () => {
  const result = validateAndNormalizeRow({
    "Business Name": "No Email Co",
    Phone: "+91 98765-43210",
  });

  assert.equal(result.status, "valid");
  assert.equal(result.data.businessName, "No Email Co");
  assert.equal(result.data.phone, "+919876543210");
  assert.equal(result.data.email, "");
});

test("common header aliases and a selected country are mapped", () => {
  const result = validateAndNormalizeRow(
    {
      company_name: "Alias Co",
      mobile_number: 2133734253,
      email_address: "alias@example.com",
    },
    {
      selectedCountry: "USA",
      normalizeCountry: (country) => (country === "USA" ? "United States" : country),
    }
  );

  assert.equal(result.status, "valid");
  assert.equal(result.data.phone, "+12133734253");
  assert.equal(result.data.country, "United States");
});

test("a missing phone is the only missing-field failure", () => {
  const result = validateAndNormalizeRow({ Address: "Somewhere" });

  assert.equal(result.status, "skipped");
  assert.deepEqual(result.reasons, ["Missing Phone"]);
});

test("an empty row is skipped as a missing phone", () => {
  const result = validateAndNormalizeRow({
    "Business Name": "",
    Phone: "",
    Email: "",
  });

  assert.equal(result.status, "skipped");
  assert.deepEqual(result.reasons, ["Missing Phone"]);
});

test("phone validation remains enforced while optional email is not validated", () => {
  const result = validateAndNormalizeRow({
    "Business Name": "Broken Co",
    Phone: "call-me",
    Email: "not-an-email",
  });

  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.includes("Invalid phone number for the selected country."));
  assert.equal(result.reasons.includes("Invalid Email format"), false);
});

test("extra unnamed columns do not reject a row", () => {
  const result = validateAndNormalizeRow({ ...phoneOnlyRow, _3: "unexpected" });

  assert.equal(result.status, "valid");
  assert.deepEqual(result.reasons, []);
});

test("invalid optional values do not reject a row", () => {
  const result = validateAndNormalizeRow({
    ...phoneOnlyRow,
    Email: "not-an-email",
    Website: "not a url",
    Rating: "5.5",
    Reviews: "1.2",
    Latitude: "91",
    Longitude: "181",
  });

  assert.equal(result.status, "valid");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.data.email, "not-an-email");
  assert.equal(result.data.website, "not a url");
  assert.equal(result.data.rating, null);
  assert.equal(result.data.reviews, null);
  assert.equal(result.data.latitude, null);
  assert.equal(result.data.longitude, null);
});

test("an unpaired coordinate is ignored without rejecting the row", () => {
  const result = validateAndNormalizeRow({ ...phoneOnlyRow, Latitude: "22.57" });

  assert.equal(result.status, "valid");
  assert.equal(result.data.latitude, null);
  assert.equal(result.data.longitude, null);
});

test("unsupported optional spreadsheet cells are ignored", () => {
  const result = validateAndNormalizeRow({
    values: { ...phoneOnlyRow, Rating: true },
    unsupportedFields: ["Rating"],
  });

  assert.equal(result.status, "valid");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.data.rating, null);
});

test("identity keys use only the normalized phone number", () => {
  const first = buildIdentityKey({
    businessName: "First Business",
    phone: "+91 98765 43210",
    email: "first@example.com",
  });
  const second = buildIdentityKey({
    businessName: "Completely Different Business",
    phone: "+919876543210",
    email: "different@example.com",
  });
  const third = buildIdentityKey({
    businessName: "First Business",
    phone: "+919876543211",
    email: "first@example.com",
  });

  assert.equal(first, second);
  assert.notEqual(first, third);
});

test("legacy local-format business phones match the phone-only identity", () => {
  const existingKeys = getExistingBusinessIdentityKeys({
    businessName: "Existing Name",
    address: { country: "India" },
    contact: {
      mobile: ["98765 43210"],
      whatsapp: [],
      contactDetails: [],
    },
  });
  const samePhoneDifferentBusiness = buildIdentityKey({
    businessName: "Different Name",
    phone: "+919876543210",
  });
  const sameBusinessDifferentPhone = buildIdentityKey({
    businessName: "Existing Name",
    phone: "+919876543211",
  });

  assert.equal(existingKeys.has(samePhoneDifferentBusiness), true);
  assert.equal(existingKeys.has(sameBusinessDifferentPhone), false);
});

test("header normalization handles BOM, spaces, and punctuation", () => {
  assert.equal(normalizeHeader("\uFEFFBusiness_Name "), "businessname");
});

test("successful audit previews keep only the fields rendered by the admin", () => {
  assert.deepEqual(
    compactAuditData(
      {
        businessName: "Compact Co",
        phone: "9876543210",
        email: "hello@example.com",
        address: "A long address that is already stored on the business",
        website: "https://example.com",
      },
      "imported"
    ),
    {
      businessName: "Compact Co",
      phone: "9876543210",
      email: "hello@example.com",
    }
  );
});

test("audit rows omit raw spreadsheet copies and receive an expiry", () => {
  const before = Date.now();
  const document = makeAuditDocument(
    new mongoose.Types.ObjectId(),
    { rowNumber: 2 },
    { status: "imported", reasons: [], data: phoneOnlyRow }
  );

  assert.equal(Object.hasOwn(document, "rawData"), false);
  assert.equal(document.status, "imported");
  assert.ok(document.expiresAt.getTime() > before);
});

test("audit previews cap successful rows while retaining capacity for failures", () => {
  const audit = {
    storedRows: 0,
    omittedRows: 0,
    successfulRowsStored: 0,
    maxStoredRows: 2,
    maxSuccessfulRows: 1,
  };

  assert.equal(reserveAuditRow(audit, "imported"), true);
  assert.equal(reserveAuditRow(audit, "imported"), false);
  assert.equal(reserveAuditRow(audit, "rejected"), true);
  assert.deepEqual(
    {
      storedRows: audit.storedRows,
      omittedRows: audit.omittedRows,
      successfulRowsStored: audit.successfulRowsStored,
    },
    { storedRows: 2, omittedRows: 1, successfulRowsStored: 1 }
  );
});

test("CSV parsing streams data rows with spreadsheet row numbers", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "business-import-test-"));
  const filePath = path.join(directory, "records.csv");
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  await fs.promises.writeFile(
    filePath,
    "Business Name,Phone,Email\nAcme,9876543210,hello@example.com\nNo Email,9876543211,\n"
  );

  const entries = [];
  await readImportFile(
    { path: filePath, originalname: "records.csv" },
    async (chunk) => entries.push(...chunk)
  );

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.rowNumber), [2, 3]);
  assert.equal(validateAndNormalizeRow(entries[0]).status, "valid");
  assert.equal(validateAndNormalizeRow(entries[1]).status, "valid");
  assert.equal(validateAndNormalizeRow(entries[1]).data.email, "");
});

test("CSV parsing continues beyond 100,000 business rows", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "business-import-large-test-"));
  const filePath = path.join(directory, "large-records.csv");
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));

  const rowCount = 100_001;
  const lines = new Array(rowCount + 1);
  lines[0] = "Business Name,Phone";
  for (let index = 1; index <= rowCount; index += 1) {
    lines[index] = `Business ${index},+12133734253`;
  }
  await fs.promises.writeFile(filePath, lines.join("\n"));

  let parsedRows = 0;
  let largestChunk = 0;
  await readImportFile(
    { path: filePath, originalname: "large-records.csv" },
    async (chunk) => {
      parsedRows += chunk.length;
      largestChunk = Math.max(largestChunk, chunk.length);
    }
  );

  assert.equal(parsedRows, rowCount);
  assert.ok(largestChunk <= 500);
});

test("XLSX parsing preserves empty rows and numeric phone cells", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "business-import-test-"));
  const filePath = path.join(directory, "records.xlsx");
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Businesses");
  worksheet.addRow(["Business Name", "Phone", "Email"]);
  worksheet.getRow(2);
  worksheet.getCell("A3").value = "Acme";
  worksheet.getCell("B3").value = 9876543210;
  worksheet.getCell("C3").value = "hello@example.com";
  await workbook.xlsx.writeFile(filePath);

  const entries = [];
  await readImportFile(
    { path: filePath, originalname: "records.xlsx" },
    async (chunk) => entries.push(...chunk)
  );

  assert.deepEqual(entries.map((entry) => entry.rowNumber), [2, 3]);
  assert.deepEqual(validateAndNormalizeRow(entries[0]).reasons, ["Missing Phone"]);
  assert.equal(validateAndNormalizeRow(entries[1]).status, "valid");
});
