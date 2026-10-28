#!/usr/bin/env node
"use strict";

// Read-only audit of every business's saved logo/photo reference. Run with
// --output /path/report.json. Original filenames remain in the report for backup
// recovery; this script never substitutes images or changes MongoDB records.
require("dotenv").config({ path: require("node:path").join(__dirname, "../.env"), quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { uploadDir } = require("../utils/uploadDir");
const { cleanBusinessLogo, cleanBusinessPhotos } = require("../utils/businessMedia");

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output")) {
    throw new Error("Usage: node scripts/auditBusinessMedia.js [--output /path/report.json]");
  }
  await mongoose.connect(process.env.MONGO_URI);
  const directory = uploadDir();
  const report = { generatedAt: new Date().toISOString(), uploadDirectory: directory, businessesChecked: 0, uploadedReferencesFound: 0, externalReferences: 0, genericReferences: 0, missing: [] };
  const cursor = mongoose.connection.db.collection("businesses").find({}, { projection: { businessName: 1, businessLogo: 1, photos: 1 } });
  for await (const business of cursor) {
    report.businessesChecked++;
    const references = [["businessLogo", business.businessLogo], ...(business.photos || []).map((photo) => ["photos", photo])];
    for (const [field, storedPath] of references) {
      if (typeof storedPath !== "string" || !storedPath.trim()) continue;
      if ((field === "businessLogo" && !cleanBusinessLogo(storedPath)) || (field === "photos" && !cleanBusinessPhotos([storedPath]).length)) {
        report.genericReferences++;
        continue;
      }
      let key = storedPath.trim().replace(/\\/g, "/");
      if (/^(https?:)?\/\//i.test(key)) {
        const url = new URL(key, "https://urbancitations.com");
        if (!/(^|\.)urbancitations\.com$/i.test(url.hostname) || !url.pathname.startsWith("/uploads/")) {
          report.externalReferences++;
          continue;
        }
        key = decodeURIComponent(url.pathname);
      }
      key = key.replace(/^(?:\.\/)?\/?(?:public\/)?uploads\//, "").replace(/^\/+/, "");
      const target = path.resolve(directory, key);
      const withinUploads = target.startsWith(directory + path.sep);
      if (withinUploads && fs.existsSync(target) && fs.statSync(target).isFile()) report.uploadedReferencesFound++;
      else report.missing.push({ businessId: String(business._id), businessName: business.businessName, field, storedPath, key });
    }
  }
  report.affectedBusinesses = new Set(report.missing.map((item) => item.businessId)).size;
  if (args[1]) fs.writeFileSync(args[1], JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ...report, missing: `${report.missing.length} missing upload references; use --output for the full recovery inventory` }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
