"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const connectDB = require("../config/db");
const { disconnectDB } = require("../config/db");
const Business = require("../models/Business");
const BusinessImportBatch = require("../models/BusinessImportBatch");
const BusinessImportRow = require("../models/BusinessImportRow");
const { runBusinessImport } = require("../services/businessImportService");

async function main() {
  if (!process.argv.includes("--execute")) {
    throw new Error("This smoke test writes and removes one exact test business. Pass --execute to run it.");
  }

  const suffix = `${Date.now()}-${process.pid}`;
  const businessName = `Codex Import Smoke ${suffix}`;
  const fileName = `codex-import-smoke-${suffix}.csv`;
  const filePath = path.join(os.tmpdir(), fileName);
  const phone = `1555${String(Date.now()).slice(-7)}`;
  let batchId = null;

  await fs.promises.writeFile(
    filePath,
    `Business Name,Phone,Email,Address,Country\n${businessName},${phone},smoke-${suffix}@example.com,1 Smoke Street,United States\n`
  );

  await connectDB();
  try {
    const result = await runBusinessImport({
      file: {
        path: filePath,
        originalname: fileName,
        mimetype: "text/csv",
        size: (await fs.promises.stat(filePath)).size,
      },
      user: { _id: new mongoose.Types.ObjectId(), role: "admin" },
      selectedCountry: "United States",
    });
    batchId = result.batchId;

    assert.equal(result.status, "completed");
    assert.equal(result.totals.imported, 1);
    assert.equal(result.audit.storedRows, 1);
    assert.equal(result.audit.omittedRows, 0);

    const [business, row, batch, indexes] = await Promise.all([
      Business.findOne({ businessName, "importMetadata.batch": batchId }).lean(),
      BusinessImportRow.findOne({ batch: batchId }).lean(),
      BusinessImportBatch.findById(batchId).lean(),
      BusinessImportRow.collection.indexes(),
    ]);

    assert.ok(business, "The business was not inserted.");
    assert.ok(row, "The import preview row was not inserted.");
    assert.equal(row.status, "imported");
    assert.equal(Object.hasOwn(row, "rawData"), false);
    assert.deepEqual(Object.keys(row.data).sort(), ["businessName", "email", "phone"]);
    assert.ok(row.expiresAt instanceof Date);
    assert.equal(batch.audit.storedRows, 1);
    assert.ok(
      indexes.some((index) => index.name === "expiresAt_1" && index.expireAfterSeconds === 0),
      "The import audit TTL index was not created."
    );

    console.log(
      JSON.stringify(
        {
          success: true,
          imported: result.totals.imported,
          auditStoredRows: result.audit.storedRows,
          auditExpiresAt: row.expiresAt,
          ttlIndex: "expiresAt_1",
        },
        null,
        2
      )
    );
  } finally {
    const batches = await BusinessImportBatch.find({ "file.originalName": fileName }).select("_id").lean();
    const batchIds = batches.map((batch) => batch._id);
    if (batchId && !batchIds.some((id) => String(id) === String(batchId))) batchIds.push(batchId);
    await Promise.all([
      Business.deleteMany({ businessName }),
      BusinessImportRow.deleteMany({ batch: { $in: batchIds } }),
      BusinessImportBatch.deleteMany({ _id: { $in: batchIds } }),
    ]);
    await fs.promises.unlink(filePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await disconnectDB();
  }
}

main().catch((error) => {
  console.error(`Business import smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
