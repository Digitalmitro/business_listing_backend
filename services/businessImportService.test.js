"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { closeQueueConnections } = require("../utils/queue");

const {
  buildIdentityKey,
  normalizeHeader,
  readImportFile,
  validateAndNormalizeRow,
} = require("./businessImportService");

const requiredOnlyRow = {
  "Business Name": "Acme Services",
  Phone: "+91 98765-43210",
  Email: "HELLO@EXAMPLE.COM",
};

test("only Business Name and Phone are required (email can be blank too)", () => {
  const result = validateAndNormalizeRow(requiredOnlyRow);

  assert.equal(result.status, "valid");
  assert.equal(result.data.businessName, "Acme Services");
  assert.equal(result.data.phone, "+919876543210");
  assert.equal(result.data.email, "hello@example.com");
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
      mobile_number: 9876543210,
      email_address: "alias@example.com",
    },
    {
      selectedCountry: "USA",
      normalizeCountry: (country) => (country === "USA" ? "United States" : country),
    }
  );

  assert.equal(result.status, "valid");
  assert.equal(result.data.phone, "9876543210");
  assert.equal(result.data.country, "United States");
});

test("missing mandatory values are skipped with every exact reason", () => {
  const result = validateAndNormalizeRow({ Address: "Somewhere" });

  assert.equal(result.status, "skipped");
  assert.deepEqual(result.reasons, [
    "Missing Business Name",
    "Missing Phone",
  ]);
});

test("an empty row is skipped distinctly", () => {
  const result = validateAndNormalizeRow({
    "Business Name": "",
    Phone: "",
    Email: "",
  });

  assert.equal(result.status, "skipped");
  assert.deepEqual(result.reasons, ["Empty row"]);
});

test("invalid mandatory formats reject a row without throwing", () => {
  const result = validateAndNormalizeRow({
    "Business Name": "Broken Co",
    Phone: "call-me",
    Email: "not-an-email",
  });

  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.includes("Invalid Phone format"));
  assert.ok(result.reasons.includes("Invalid Email format"));
});

test("a CSV row with extra unnamed columns is rejected as malformed", () => {
  const result = validateAndNormalizeRow({ ...requiredOnlyRow, _3: "unexpected" });

  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.includes("Malformed row"));
});

test("optional values are validated only when supplied", () => {
  const result = validateAndNormalizeRow({
    ...requiredOnlyRow,
    Website: "not a url",
    Rating: "5.5",
    Reviews: "1.2",
    Latitude: "91",
    Longitude: "181",
  });

  assert.equal(result.status, "rejected");
  assert.deepEqual(result.reasons, [
    "Invalid Website format",
    "Invalid Rating",
    "Invalid Reviews",
    "Invalid Latitude",
    "Invalid Longitude",
  ]);
});

test("latitude and longitude must be supplied together", () => {
  const result = validateAndNormalizeRow({ ...requiredOnlyRow, Latitude: "22.57" });

  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.includes("Latitude and Longitude must be provided together"));
});

test("unsupported spreadsheet cell types reject only that row", () => {
  const result = validateAndNormalizeRow({
    values: { ...requiredOnlyRow, Rating: true },
    unsupportedFields: ["Rating"],
  });

  assert.equal(result.status, "rejected");
  assert.deepEqual(result.reasons, ["Unsupported data type: Rating"]);
});

test("identity keys are stable across harmless formatting differences", () => {
  const first = buildIdentityKey({
    businessName: "  Acme   Services ",
    phone: "+91 98765 43210",
    email: "HELLO@EXAMPLE.COM",
  });
  const second = buildIdentityKey({
    businessName: "acme services",
    phone: "+919876543210",
    email: "hello@example.com",
  });

  assert.equal(first, second);
});

test("header normalization handles BOM, spaces, and punctuation", () => {
  assert.equal(normalizeHeader("\uFEFFBusiness_Name "), "businessname");
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
  assert.deepEqual(validateAndNormalizeRow(entries[0]).reasons, ["Empty row"]);
  assert.equal(validateAndNormalizeRow(entries[1]).status, "valid");
});

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
